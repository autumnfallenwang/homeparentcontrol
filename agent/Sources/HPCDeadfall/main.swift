import Foundation
import HPCAgentIO
import HPCCore

/// `hpc-deadfall` — the class-A backstop (§4.6).
///
/// > "**The deadfall** closes class A. A `StartCalendarInterval` launchd job
/// > set to the current policy's earliest `restricted_from`, rewritten by the
/// > sync daemon whenever the schedule changes. It fires, **re-evaluates the
/// > full predicate itself — including `overrides[]`** — and locks. If both
/// > main daemons are dead, bedtime still happens. ~30 lines."
///
/// ⚠️ **The override clause is not decoration**: "without it, a holiday night
/// with both daemons dead would lock at the baseline time."
///
/// It runs, decides, acts and exits. No timer, no network, no state carried
/// between invocations beyond one breadcrumb for the parent's benefit.
///
/// ⚠️ **It is not a second enforcer, and must never become one.** It has no
/// ladder, sends no warnings and never escalates to shutdown: it locks, or it
/// does nothing. A warning from a process that has just woken up has nobody to
/// deliver to and no way to follow through, and an unattended `shutdown` from
/// a one-shot with no grace period is how you lose a child's homework.
enum Deadfall {
    static let version = "0.1.0"

    static func run() -> Int32 {
        // ── 1. The kill switch, first and fresh, exactly as §3.2 orders it
        //       for the enforcer. A deadfall that ignored DISABLE would make
        //       the emergency control a lie the one night it is needed.
        let killSwitch = KillSwitch.check()
        if killSwitch.present {
            log("kill_switch_present", ["indefinite": String(killSwitch.indefinite)])
            return 0
        }

        // ── 2. Load, verify, fall back to LKG. Same rules, same order.
        let current = try? String(contentsOfFile: Paths.currentPolicy, encoding: .utf8)
        let lkg = try? String(contentsOfFile: Paths.lkgPolicy, encoding: .utf8)
        let keys = SigningKeys.load()

        guard case .success(let loaded) = PolicyStore.load(
            currentJWS: current, lkgJWS: lkg, keys: keys)
        else {
            // ⚠️ §4.6 fail-open, loudly — and the deadfall has no second
            // chance to be loud, so it writes to the spool AND to stderr,
            // which launchd captures to `deadfall.log`.
            log("degraded", ["reason": "policy_unavailable"])
            FileHandle.standardError.write(
                Data("hpc-deadfall: NOT ENFORCING — no usable policy\n".utf8))
            return 0
        }

        // ── 3. The full predicate, overrides included. This is the one line
        //       the design document singles out, and it is free here only
        //       because the predicate is pure and already tested: a holiday
        //       grant relaxes the deadfall exactly as it relaxes the enforcer.
        let evaluation = BedtimePredicate.evaluate(policy: loaded.document, now: Date())

        guard evaluation.isRestricted else {
            // The common case by a wide margin: the enforcer is alive and this
            // process is redundant. Nothing to do, and say so quietly.
            log("evaluated", ["restricted": "false"])
            return 0
        }

        // ── 4. Is the enforcer actually dead? Only lock if it is not.
        //
        // ⚠️ This is a **courtesy check, not a gate**, and the difference is
        // the whole design. If the health file is missing, unreadable, stale,
        // or from the future, we lock. The only branch that declines to lock
        // is a *positive* reading that the enforcer ticked within the last
        // five minutes — because then it has already locked, and a second
        // lock is noise. Every ambiguity resolves toward locking.
        if enforcerIsAlive() {
            log("evaluated", ["restricted": "true", "action": "deferred_to_enforcer"])
            return 0
        }

        let locked = Effects.lock()
        log(
            locked ? "action_taken" : "action_failed",
            [
                "action": "lock",
                "window_id": evaluation.activeWindow?.id ?? "",
                "applied_overrides": evaluation.appliedOverrideIds.joined(separator: ","),
            ])
        if !locked {
            FileHandle.standardError.write(
                Data("hpc-deadfall: LOCK FAILED inside a restricted window\n".utf8))
        }
        return locked ? 0 : 1
    }

    /// A positive, recent heartbeat — and nothing else — counts as alive.
    static func enforcerIsAlive() -> Bool {
        guard let data = FileManager.default.contents(atPath: Paths.health),
              let row = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let ts = row["ts"] as? String,
              let writtenAt = ISO8601DateFormatter.hpcParse(ts)
        else { return false }
        let age = Date().timeIntervalSince(writtenAt)
        // A future timestamp means the clock moved, not that the enforcer is
        // healthy. Treat it as dead, because the cost of a redundant lock is a
        // locked screen the child unlocks; the cost of the other mistake is
        // the whole night.
        guard age >= 0 else { return false }
        return age < 300
    }

    /// The deadfall shares the enforcer's spool so a parent reads one
    /// timeline. `seq: -1` marks the rows this process wrote — it has no tick
    /// counter and inventing one would collide with the enforcer's.
    static func log(_ kind: String, _ detail: [String: String]) {
        var detail = detail
        detail["source"] = "deadfall"
        detail["deadfall_version"] = version
        Spool.append(kind: "enforcement.\(kind)", detail: detail, tickSeq: -1)
        try? Data(ISO8601DateFormatter().string(from: Date()).utf8)
            .write(to: URL(fileURLWithPath: Paths.deadfallState), options: .atomic)
    }
}

exit(Deadfall.run())

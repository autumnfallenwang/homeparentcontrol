import Dispatch
import Foundation
import HPCCore

/// `enforcerd` — the tick loop (§3.2).
///
/// ⚠️ **No network code at all.** Enforcement is provably independent of the
/// network, which is the contract's central unproven claim (V1–V9), and the
/// proof is that `otool -L` shows no networking symbols in this binary. Adding
/// a single `URLSession` here invalidates the milestone.
///
/// ```
/// every 60 s:
///   1. kill switch   — fresh from disk, FIRST
///   2. load policy   — current; verify JWS; else LKG; else fail open LOUDLY
///   3. resolve now   — in the POLICY's zone, never the system's
///   4. clock sanity
///   5. effective rules
///   6. predicate
///   7. act
///   8. spool         — decision already taken; a failed write changes nothing
///   9. health
/// ```
enum Enforcer {
    static let version = "0.1.0"
    static let tickInterval: TimeInterval = 60

    static var ladderState = Ladder.State()
    static var tickSeq = 0
    static var pendingWarning: (leadMinutes: Int, outcome: Ladder.WarningOutcome)?
    static let bootId = UUID().uuidString

    static func tick() {
        tickSeq += 1
        var decision = "none"

        // ── 1. Kill switch, first, fresh from disk.
        let killSwitch = KillSwitch.check()
        if killSwitch.present {
            Spool.append(
                kind: "enforcement.kill_switch_present",
                detail: [
                    "indefinite": String(killSwitch.indefinite),
                    "check_threw": String(killSwitch.checkThrew),
                ], tickSeq: tickSeq)
            Spool.writeHealth(
                tickSeq: tickSeq, lastDecision: "kill_switch", version: version)
            return
        }

        // ── 2. Load and verify.
        let current = try? String(contentsOfFile: Paths.currentPolicy, encoding: .utf8)
        let lkg = try? String(contentsOfFile: Paths.lkgPolicy, encoding: .utf8)
        let keys = loadSigningKeys()

        let loaded: PolicyStore.Loaded
        switch PolicyStore.load(currentJWS: current, lkgJWS: lkg, keys: keys) {
        case .success(let value):
            loaded = value
        case .failure(let error):
            // ⚠️ §4.6 — FAIL OPEN, LOUDLY. We cannot determine the rules, so
            // we must not lock; "fail-open is not fail-silent, and the entire
            // argument depends on that distinction holding." Every branch here
            // screams, every tick, for as long as it lasts.
            let reason: String
            switch error {
            case .missing: reason = "policy_missing"
            case .corrupt: reason = "policy_corrupt"
            case .unverifiable: reason = "policy_unverified"
            }
            Spool.append(
                kind: "agent.degraded", detail: ["reason": reason], tickSeq: tickSeq)
            Spool.writeHealth(tickSeq: tickSeq, lastDecision: reason, version: version)
            FileHandle.standardError.write(Data("NOT ENFORCING: \(reason)\n".utf8))
            return
        }

        if !loaded.signatureValid {
            Spool.append(kind: "policy.unsigned", detail: [:], tickSeq: tickSeq)
        }
        if loaded.source == .lastKnownGood {
            Spool.append(
                kind: "agent.degraded", detail: ["reason": "using_lkg"], tickSeq: tickSeq)
        }

        // ── 3–6. Resolve, and ask the predicate. Pure, tested, no I/O.
        let evaluation = BedtimePredicate.evaluate(policy: loaded.document, now: Date())

        // ── 7. Act.
        let step = Ladder.step(
            evaluation: evaluation,
            state: ladderState,
            now: Date(),
            previousWarning: pendingWarning)
        ladderState = step.state
        pendingWarning = nil

        for effect in step.effects {
            switch effect {
            case .deliverWarning(let lead, let channel, _):
                let outcome = Effects.warn(
                    leadMinutes: lead, channel: channel,
                    displayName: loaded.document.subject.displayName)
                // Folded into the NEXT tick's state, so a slow notifier never
                // delays this tick's lock.
                pendingWarning = (lead, outcome)
                Spool.append(
                    kind: "enforcement.warning_shown",
                    detail: ["lead_minutes": String(lead), "channel": channel,
                             "outcome": String(describing: outcome)],
                    tickSeq: tickSeq)

            case .lock:
                let ok = Effects.lock()
                decision = "lock"
                Spool.append(
                    kind: ok ? "enforcement.action_taken" : "enforcement.action_failed",
                    detail: ["action": "lock"], tickSeq: tickSeq)

            case .shutdown:
                let ok = Effects.shutdown()
                decision = "shutdown"
                Spool.append(
                    kind: ok ? "enforcement.action_taken" : "enforcement.action_failed",
                    detail: ["action": "shutdown"], tickSeq: tickSeq)

            case .audit(let kind, let detail):
                Spool.append(kind: kind, detail: detail, tickSeq: tickSeq)
            }
        }

        // ── 8–9. Already decided and acted; these cannot change the outcome.
        Spool.writeHealth(tickSeq: tickSeq, lastDecision: decision, version: version)
    }

    static func loadSigningKeys() -> [PolicyStore.SigningKey] {
        guard let data = FileManager.default.contents(atPath: Paths.signingKeys),
              let rows = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]]
        else { return [] }
        return rows.compactMap { row in
            guard let kid = row["kid"] as? String, let x = row["x"] as? String else { return nil }
            return PolicyStore.SigningKey(kid: kid, x: x)
        }
    }

    static func start() {
        // §3.8 — report the previous run, then immediately mark this one dirty.
        if let previous = Spool.readPreviousCleanExit() {
            Spool.append(
                kind: "agent.started",
                detail: [
                    "clean_exit_previous_run": String(previous.clean),
                    "previous_stop_reason": previous.reason ?? "",
                ], tickSeq: 0)
        } else {
            Spool.append(
                kind: "agent.started", detail: ["clean_exit_previous_run": "false"], tickSeq: 0)
        }
        Spool.writeCleanExit(clean: false, reason: nil, bootId: bootId)

        // ⚖️ Two lock paths, checked in daylight rather than at 21:30.
        let selfTest = Effects.lockSelfTest()
        Spool.append(
            kind: "agent.lock_self_test",
            detail: selfTest.mapValues(String.init), tickSeq: 0)
        if !selfTest.values.contains(true) {
            FileHandle.standardError.write(
                Data("NO WORKING LOCK PATH — enforcement cannot be applied\n".utf8))
        }
    }
}

// ── Signals.
//
// ⚠️ E.8, kept even though the agent is Swift. "A naive `sleep 30` in a loop
// defers the SIGTERM trap until the sleep returns, and launchd SIGKILLs it."
// The tick waits on a `DispatchSourceTimer`, and the signal on a
// `DispatchSourceSignal` — both interruptible primitives the handler can
// break. Never `Thread.sleep`.
signal(SIGTERM, SIG_IGN)
signal(SIGINT, SIG_IGN)

let queue = DispatchQueue(label: "hpc.enforcer", qos: .utility)

let termSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: queue)
termSource.setEventHandler {
    Spool.writeCleanExit(clean: true, reason: "signal", bootId: Enforcer.bootId)
    Spool.append(kind: "agent.stopping", detail: ["reason": "signal"], tickSeq: Enforcer.tickSeq)
    exit(0)
}
termSource.resume()

let intSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: queue)
intSource.setEventHandler {
    Spool.writeCleanExit(clean: true, reason: "interrupt", bootId: Enforcer.bootId)
    exit(0)
}
intSource.resume()

Enforcer.start()

let timer = DispatchSource.makeTimerSource(queue: queue)
timer.schedule(deadline: .now(), repeating: Enforcer.tickInterval, leeway: .seconds(1))
timer.setEventHandler { Enforcer.tick() }
timer.resume()

dispatchMain()

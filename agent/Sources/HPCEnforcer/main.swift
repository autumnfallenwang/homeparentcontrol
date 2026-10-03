import Dispatch
import Foundation
import HPCAgentIO
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
///   4. clock sanity  — TRUSTED time, never `Date()` (ADR 0015); done first,
///                      because the kill switch's expiry needs it too
///   5. effective rules
///   6. predicate
///   7. act
///   8. spool         — decision already taken; a failed write changes nothing
///   9. health
/// ```
enum Enforcer {
    static let version = AgentVersion.current
    static let tickInterval: TimeInterval = 60

    static var ladderState = Ladder.State()
    static var tickSeq = 0
    static var pendingWarning: (leadMinutes: Int, outcome: Ladder.WarningOutcome)?
    static let bootId = UUID().uuidString

    static func tick() {
        tickSeq += 1
        var decision = "none"

        // ── 4, hoisted. The clock everything below decides on.
        //
        // ⚠️ Never `Date()`. On 2026-10-03 Ivy set her Mac's clock 23 hours
        // ahead at midnight and the 00:45 shutdown never came: the predicate
        // was asking about a Saturday evening that had not happened. Reading
        // the clock cannot throw and cannot skip anything; it only decides
        // WHICH instant the rules are asked about.
        let clock = TimeBasis.resolve(persist: true)
        let now = clock.now
        reportClock(clock)

        // ── 1. Kill switch, first of the decisions, fresh from disk. Its
        //       `until` is judged on trusted time: a clock set back must not
        //       stretch a time-boxed DISABLE.
        let killSwitch = KillSwitch.check(now: now)
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
        let keys = SigningKeys.load()

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
        let evaluation = BedtimePredicate.evaluate(policy: loaded.document, now: now)

        // ── 7. Act.
        let step = Ladder.step(
            evaluation: evaluation,
            state: ladderState,
            now: now,
            previousWarning: pendingWarning)
        ladderState = step.state
        pendingWarning = nil

        // ── 7a. ⚠️ **SHADOW MODE — the one branch that does not act** (§6.5).
        //
        // A newly installed version runs the full loop and computes every
        // decision it would make, applying none of them. The decision above
        // is already computed; this only decides whether to carry it out.
        //
        // ⚠️ The verdict is taken AFTER the ladder, deliberately. Shadow must
        // exercise exactly the same code path as enforcement — a shadow that
        // short-circuits earlier is testing a different program than the one
        // that will run tomorrow, which makes the soak worthless.
        //
        // Every ambiguity in `ShadowMode.verdict` resolves to `.enforcing`,
        // and the window has a hard deadline that criteria can only shorten.
        // See `ShadowMode`'s header for the four properties.
        // Trusted time here too: a clock set back must not stretch the soak.
        let shadow = ShadowMode.verdict(
            soak: SoakMarker.read(), runningVersion: version, now: now)
        if case .shadowing(let until, let shadowVersion) = shadow {
            let would = step.effects.compactMap { effect -> String? in
                switch effect {
                case .lock: return "lock"
                case .shutdown: return "shutdown"
                case .deliverWarning(let lead, _, _, _): return "warn_\(lead)"
                case .audit: return nil
                }
            }
            Spool.append(
                kind: "enforcement.shadow_decision",
                detail: ShadowMode.shadowDecision(
                    would: would, windowId: evaluation.activeWindow?.id,
                    version: shadowVersion, deadline: until
                ).mapValues { String(describing: $0) },
                tickSeq: tickSeq)
            Spool.writeHealth(
                tickSeq: tickSeq, lastDecision: "shadow", version: version)
            // ⚠️ LOUD, every tick, exactly like the fail-open branches above.
            // §4.6: "fail-open is not fail-silent, and the entire argument
            // depends on that distinction holding." A silent soak is a Mac
            // that quietly stopped locking.
            FileHandle.standardError.write(
                Data("NOT ENFORCING: shadow mode until \(until) (\(shadowVersion))\n".utf8))
            return
        }

        for effect in step.effects {
            switch effect {
            case .deliverWarning(let lead, let left, let channel, _):
                let outcome = Effects.warn(
                    leadMinutes: lead, minutesLeft: left, channel: channel,
                    displayName: loaded.document.subject.displayName)
                // Folded into the NEXT tick's state, so a slow notifier never
                // delays this tick's lock.
                pendingWarning = (lead, outcome)
                Spool.append(
                    kind: "enforcement.warning_shown",
                    detail: ["lead_minutes": String(lead), "minutes_left": String(left),
                             "channel": channel, "outcome": String(describing: outcome)],
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

    /// `clock.stepped` once per change of the Mac's clock error (ADR 0015).
    /// Audit class: it outlives a queue overrun and reaches the parent's
    /// history, where a change away from the real time is red.
    static func reportClock(_ clock: TrustedClock.Resolution) {
        let iso = ISO8601DateFormatter()
        if let step = clock.step {
            Spool.append(
                kind: "clock.stepped",
                detail: [
                    "offset_s": String(Int(step.to.rounded())),
                    "previous_offset_s": String(Int(step.from.rounded())),
                    "source": clock.source.rawValue,
                    "wall": iso.string(from: clock.now.addingTimeInterval(clock.offset)),
                    "trusted": iso.string(from: clock.now),
                ], tickSeq: tickSeq)
        }
        if clock.serverOutvotedStarted {
            // The server disagreed with this Mac's clock AND with our own
            // reckoning; we enforced on ours. Worth a look at the server.
            Spool.append(
                kind: "clock.server_outvoted", detail: ["source": clock.source.rawValue],
                tickSeq: tickSeq)
        }
    }

    static func start() {
        // ★ Every timestamp this process writes is trusted time (ADR 0015).
        Spool.clock = { TimeBasis.now() }

        // §3.8 — report the previous run, then immediately mark this one dirty.
        // ★ `boot_time` says WHICH boot this launch is in (ADR 0014), so the
        // parent's history can tell "turned on" from "restarted" — even for a
        // boot this Mac never checked in from, once its queue is delivered.
        let bootTime = BootTime.kernelISO().map { ["boot_time": $0] } ?? [:]
        if let previous = Spool.readPreviousCleanExit() {
            Spool.append(
                kind: "agent.started",
                detail: [
                    "clean_exit_previous_run": String(previous.clean),
                    "previous_stop_reason": previous.reason ?? "",
                ].merging(bootTime) { current, _ in current }, tickSeq: 0)
        } else {
            let detail = ["clean_exit_previous_run": "false"]
            Spool.append(
                kind: "agent.started",
                detail: detail.merging(bootTime) { current, _ in current }, tickSeq: 0)
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
AgentVersion.handleFlag()

signal(SIGTERM, SIG_IGN)
signal(SIGINT, SIG_IGN)

let queue = DispatchQueue(label: "hpc.enforcer", qos: .utility)

let termSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: queue)
termSource.setEventHandler {
    // ★ The clock's error, written on the way down: E.4 says launchd delivers
    // this at shutdown, so a clock moved in the last minute before a restart
    // is still known to the next boot (ADR 0015, simulation S11).
    TimeBasis.resolve(persist: true)
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

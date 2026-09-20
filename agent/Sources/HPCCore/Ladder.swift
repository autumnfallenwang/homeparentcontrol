import Foundation

/// The enforcement ladder (§3.5, D.3).
///
/// ```
///   T-30 ─── banner
///   T-15 ─── banner
///   T-5  ─── modal
///   T-1  ─── modal
///   T-0  ─── LOCK          she clears it with her own password
///            │  the enforcer RE-LOCKS every tick while the predicate holds.
///            │  "Enforcement" is the re-locking, not the lock.
///   T+300s ─ SHUTDOWN      only if the predicate STILL holds
/// ```
///
/// ⚠️ **This type is where lever #7 would live.** It is pure — no files, no
/// processes, no screen — precisely so every branch can be interrogated with
/// the standing test: *can this path result in the Mac staying usable past
/// bedtime?* If a future change makes that answer "yes", it does not belong
/// here.
public enum Ladder {

    /// What the enforcer should do about this tick. The caller performs these;
    /// the ladder never touches the machine itself.
    public enum Effect: Equatable, Sendable {
        case deliverWarning(leadMinutes: Int, channel: String, windowId: String)
        /// Assert the screen lock. Idempotent — if it is already locked this
        /// is a no-op, which is why re-locking every tick is safe.
        case lock
        /// The terminal rung. Only ever reachable through `canEscalate`.
        case shutdown
        /// An audit event for the spool. The decision is taken BEFORE the
        /// write, so a failed write drops telemetry and never affects
        /// enforcement (§3.2 step 8).
        case audit(kind: String, detail: [String: String])
    }

    /// How the previous tick's warning attempt went.
    ///
    /// ⚠️ X10: "**No console user logged in is not a skip** — it is a no-op.
    /// There is nobody using the Mac and nothing to warn. Distinguish the two
    /// cases explicitly in code; conflating them is how this lever got written
    /// in the first place." Hence three cases, not two.
    public enum WarningOutcome: Equatable, Sendable {
        /// Shown to a human. This is the only one that unlocks escalation.
        case delivered
        /// Tried and failed — the surface is broken. A health signal, never a gate.
        case failed
        /// Nobody was logged in. Not a failure; there was nothing to warn.
        case noConsoleUser
    }

    public struct State: Equatable, Sendable {
        /// When the current restricted episode began. Nil when clear.
        public var episodeStartedAt: Date?
        /// Lead-minute values successfully DELIVERED during this episode.
        public var warningsDelivered: Set<Int> = []
        /// Consecutive delivery failures, for the `warning_undeliverable` signal.
        public var warningFailures: Int = 0
        /// Lead-minute values already attempted, so a warning is not re-fired
        /// on every 60-second tick.
        public var warningsAttempted: Set<Int> = []
        /// ⚠️ Which BOUNDARY those attempts relate to. Keyed by lead minutes
        /// alone, "already warned at T-30" would survive into the following
        /// night and silently suppress that night's warnings — a bedtime that
        /// arrives with no notice, which is exactly what X10 protects against
        /// at the other end of the ladder.
        public var warningsAttemptedFor: Date?
        public var lastLockAt: Date?
        public var shutdownIssued = false
        /// Episode start times inside the rolling 24 hours — X9's breaker.
        public var recentEpisodes: [Date] = []
        public var breakerTripped = false

        public init() {}
    }

    public struct Decision: Equatable, Sendable {
        public let effects: [Effect]
        public let state: State
    }

    /// ⚠️ X9's breaker counts EPISODES, not actions. T3's original — "1 action
    /// per 10 min, 5 per 24 h, penalty = disable enforcement" — is
    /// incompatible with this very ladder (lock + shutdown is already two
    /// actions inside one grace window) and with per-tick re-locking at ~60
    /// per hour. "A correctly functioning agent would trip its own breaker
    /// into a self-inflicted bypass on the first ordinary bedtime."
    ///
    /// The number is inherited from T3 and re-scoped to episodes, where it is
    /// generous: an ordinary day has one or two.
    public static let maxEpisodesPer24h = 5

    /// POC 1 §5.2's `REASSERT_MINUTES`. Re-locking is throttled, never broken
    /// — X9: "runaway re-assertion is throttled, not broken."
    public static let reassertInterval: TimeInterval = 60

    /// One tick's worth of decision.
    public static func step(
        evaluation: BedtimePredicate.Evaluation,
        state incoming: State,
        now: Date,
        previousWarning: (leadMinutes: Int, outcome: WarningOutcome)? = nil
    ) -> Decision {
        var state = incoming
        var effects: [Effect] = []

        // Fold in what happened to the warning we asked for last tick.
        if let previous = previousWarning {
            switch previous.outcome {
            case .delivered:
                state.warningsDelivered.insert(previous.leadMinutes)
                state.warningFailures = 0
            case .failed:
                // ⚠️ A health signal, NEVER a gate. Enforcement below is not
                // conditioned on this in any way.
                state.warningFailures += 1
                effects.append(
                    .audit(
                        kind: "enforcement.warning_failed",
                        detail: ["lead_minutes": String(previous.leadMinutes)]))
            case .noConsoleUser:
                // A no-op. Nobody to warn, nothing failed, nothing to report
                // as a degradation — and emphatically not a reason to skip the
                // lock below.
                break
            }
        }

        guard evaluation.isRestricted else {
            // ⚠️ Only reset when an episode was actually OPEN. An earlier
            // version cleared `warningsAttempted` on every unrestricted tick —
            // including the half-hour BEFORE bedtime, where warnings live — so
            // each warning re-fired every 60 seconds: thirty modal dialogs
            // instead of four, which is how a child learns to ignore them.
            if state.episodeStartedAt != nil {
                effects.append(.audit(kind: "enforcement.episode_ended", detail: [:]))
                state.episodeStartedAt = nil
                state.warningsDelivered = []
                state.warningsAttempted = []
                state.warningFailures = 0
                state.shutdownIssued = false
                state.lastLockAt = nil
            }

            // Warnings fire BEFORE the window opens, so they belong here.
            for warning in evaluation.dueWarnings {
                // A different boundary is a different night: start clean.
                if state.warningsAttemptedFor != warning.boundaryAt {
                    state.warningsAttemptedFor = warning.boundaryAt
                    state.warningsAttempted = []
                }
                if state.warningsAttempted.contains(warning.leadMinutes) { continue }
                state.warningsAttempted.insert(warning.leadMinutes)
                effects.append(
                    .deliverWarning(
                        leadMinutes: warning.leadMinutes,
                        channel: warning.channel,
                        windowId: warning.windowId))
            }
            return Decision(effects: effects, state: state)
        }

        // ── Inside a restricted window.
        let window = evaluation.activeWindow

        if state.episodeStartedAt == nil {
            state.episodeStartedAt = now
            state.recentEpisodes.append(now)
            state.recentEpisodes = state.recentEpisodes.filter {
                now.timeIntervalSince($0) < 24 * 3600
            }
            // X9 — on trip the enforcer HOLDS AT ITS CURRENT RUNG. It does not
            // advance lock → shutdown. It does not stop locking.
            state.breakerTripped = state.recentEpisodes.count > maxEpisodesPer24h
            if state.breakerTripped {
                effects.append(
                    .audit(
                        kind: "enforcement.breaker_tripped",
                        detail: ["episodes_24h": String(state.recentEpisodes.count)]))
            }
            effects.append(.audit(kind: "enforcement.episode_started", detail: [:]))
        }

        // `warn_only` is a real action and means exactly that: no lock.
        if window?.action == "warn_only" {
            return Decision(effects: effects, state: state)
        }

        // ★ THE LOCK IS UNCONDITIONAL.
        //
        // X10: "Bedtime still locks, warning or no warning. Lock costs a
        // password and destroys nothing, so it is safe to apply unwarned."
        //
        // Nothing above this line may gate it — not a warning failure, not an
        // absent console user, not the breaker. If a future edit adds an `if`
        // here, that edit is lever #7.
        let shouldReassert =
            state.lastLockAt.map { now.timeIntervalSince($0) >= reassertInterval } ?? true
        if shouldReassert {
            effects.append(.lock)
            effects.append(
                .audit(kind: "enforcement.action_taken", detail: ["action": "lock"]))
            state.lastLockAt = now
        }

        // ── The terminal rung.
        guard window?.action == "shutdown", !state.shutdownIssued else {
            return Decision(effects: effects, state: state)
        }

        // ⚠️ X10: "The ladder may not advance past `lock` until a warning has
        // been delivered successfully. Shutdown without notice destroys work —
        // that is the one thing D.3 exists to prevent." Note this gates
        // ESCALATION only; the lock above already fired regardless.
        guard !state.warningsDelivered.isEmpty else {
            return Decision(effects: effects, state: state)
        }
        // X9: held at the current rung, still locking.
        guard !state.breakerTripped else {
            return Decision(effects: effects, state: state)
        }

        let grace = Double(window?.actionOptions.shutdownGraceS ?? 300)
        guard let started = state.episodeStartedAt,
              now.timeIntervalSince(started) >= grace
        else {
            return Decision(effects: effects, state: state)
        }

        // "…only if the predicate STILL holds" — which it does, or we would
        // have returned at the `guard evaluation.isRestricted` above. A
        // corrected policy landing inside the grace window cancels the
        // shutdown for exactly this reason.
        effects.append(.shutdown)
        effects.append(
            .audit(kind: "enforcement.action_taken", detail: ["action": "shutdown"]))
        state.shutdownIssued = true
        return Decision(effects: effects, state: state)
    }
}

import Foundation

/// Shadow mode (§6.5) — a newly installed version runs the full tick loop and
/// computes every decision it *would* make, without applying any of them.
///
/// > "Population-based staged rollout is meaningless at n=1. The purpose
/// > survives in a different form: **stage in time, not in population.**"
///
/// ⚠️ **This is the only code path in the project that deliberately does not
/// enforce, and it is therefore the most dangerous type in it.** The standing
/// question — *can this path result in the Mac staying usable past bedtime?*
/// — answers **yes, by construction, for a bounded window**. That is the
/// feature. Everything below exists to bound it.
///
/// Four properties, and the design is nothing but these:
///
/// 1. **⏰ A HARD DEADLINE, baked in at entry.** §6.5 says promotion is
///    automatic on soak criteria. Criteria can only END shadow EARLY; they
///    can never extend it. If the promotion logic is broken, if the criteria
///    can never be met — a child away for a week means no bedtime window ever
///    completes — shadow still expires and the agent enforces. A soak that
///    silently never finishes is a Mac that silently never locks, and that
///    failure is invisible: everything looks healthy.
/// 2. **🔒 Entered ONLY by the supervisor, at install, keyed to a version.**
///    Not a flag, not an env var, not a file anyone can create meaningfully.
///    A runtime switch for "do not enforce" on a machine where the child has
///    admin is lever #1 wearing a lab coat.
/// 3. **🔁 Never re-entered for a version that already soaked.** Otherwise
///    reinstalling the agent buys a free unenforced day, every time, and
///    "reinstall the agent" becomes the bypass.
/// 4. **📣 Loud, every tick.** Shadow is reported exactly like `DEGRADED`:
///    the device is NOT enforcing and the parent must be told so, in those
///    words. Fail-open is only defensible while it is loud.
public enum ShadowMode {

    /// ⚠️ §6.5's soak is "≥24 h and ≥1 full bedtime window". This is the
    /// ceiling on the whole thing, not the target — promotion usually
    /// happens sooner, when the criteria are met.
    public static let maxDurationS: TimeInterval = 36 * 3_600

    /// The minimum soak before promotion is even considered.
    public static let minDurationS: TimeInterval = 24 * 3_600

    /// Written by the supervisor at install; read by the enforcer.
    public struct Soak: Equatable, Sendable {
        /// The version being soaked. ⚠️ Shadow applies to THIS version only.
        public let version: String
        public let startedAt: Date
        /// ⏰ Baked in at entry, never recomputed. A deadline derived fresh
        /// each tick could be pushed forward for ever by a clock that keeps
        /// moving.
        public let deadline: Date
        /// §6.5: "A release declares its expected divergences
        /// (`expect_divergence: true` with a reason), so an intentional fix
        /// does not fail its own soak."
        public let expectDivergence: Bool
        public let divergenceReason: String?

        public init(
            version: String, startedAt: Date, deadline: Date,
            expectDivergence: Bool = false, divergenceReason: String? = nil
        ) {
            self.version = version
            self.startedAt = startedAt
            self.deadline = deadline
            self.expectDivergence = expectDivergence
            self.divergenceReason = divergenceReason
        }

        public static func begin(
            version: String, at now: Date,
            expectDivergence: Bool = false, divergenceReason: String? = nil
        ) -> Soak {
            Soak(
                version: version,
                startedAt: now,
                deadline: now.addingTimeInterval(maxDurationS),
                expectDivergence: expectDivergence,
                divergenceReason: divergenceReason)
        }
    }

    public enum Verdict: Equatable, Sendable {
        /// Apply the decision. The normal state, and the default for every
        /// ambiguity below.
        case enforcing
        /// Compute and report the decision; apply nothing.
        case shadowing(until: Date, version: String)
    }

    /// Should this tick enforce?
    ///
    /// ⚠️ **Every branch that is not a positive, current, matching soak
    /// returns `.enforcing`.** Unreadable file, absent file, wrong version,
    /// expired deadline, nonsense dates — all enforce. There is exactly one
    /// way to not enforce and it requires the supervisor to have written a
    /// well-formed marker for the version that is actually running, within
    /// its own deadline.
    public static func verdict(
        soak: Soak?, runningVersion: String, now: Date
    ) -> Verdict {
        guard let soak else { return .enforcing }

        // 🔒 Property 2/3: the marker names a different version than the one
        // executing. That is a stale marker from a previous install — or a
        // rollback to an already-soaked version, which must enforce at once.
        guard soak.version == runningVersion else { return .enforcing }

        // ⏰ Property 1. `>=` so a deadline exactly now enforces.
        guard now < soak.deadline else { return .enforcing }

        // ⚠️ A deadline further out than the maximum means the marker was
        // edited, or written by a clock that has since been corrected
        // backwards. Either way it is not trustworthy, and an untrustworthy
        // "do not enforce" instruction is refused.
        guard soak.deadline.timeIntervalSince(soak.startedAt) <= maxDurationS + 60 else {
            return .enforcing
        }

        // ⚠️ A soak that started in the future is the same problem seen from
        // the other side.
        guard soak.startedAt <= now.addingTimeInterval(60) else { return .enforcing }

        return .shadowing(until: soak.deadline, version: soak.version)
    }

    /// Has the soak earned early promotion? (§6.5's criteria.)
    ///
    /// ⚠️ This can only END shadow early. It is never consulted to extend
    /// one — `verdict` does not call it, and the deadline does not move.
    public struct SoakEvidence: Sendable {
        public var elapsedS: TimeInterval
        public var completedBedtimeWindows: Int
        public var crashes: Int
        public var heartbeatGaps: Int
        /// Divergences the server could not explain.
        public var unexpectedDivergences: Int

        public init(
            elapsedS: TimeInterval, completedBedtimeWindows: Int, crashes: Int,
            heartbeatGaps: Int, unexpectedDivergences: Int
        ) {
            self.elapsedS = elapsedS
            self.completedBedtimeWindows = completedBedtimeWindows
            self.crashes = crashes
            self.heartbeatGaps = heartbeatGaps
            self.unexpectedDivergences = unexpectedDivergences
        }
    }

    public enum Promotion: Equatable, Sendable {
        case promote
        case keepSoaking(reason: String)
    }

    public static func promotion(_ evidence: SoakEvidence) -> Promotion {
        if evidence.elapsedS < minDurationS {
            return .keepSoaking(reason: "under 24 h")
        }
        // ⚠️ "≥1 FULL bedtime window". A soak that never saw the thing the
        // agent exists to do has tested nothing that matters.
        if evidence.completedBedtimeWindows < 1 {
            return .keepSoaking(reason: "no complete bedtime window yet")
        }
        if evidence.crashes > 0 {
            return .keepSoaking(reason: "\(evidence.crashes) crash(es) during the soak")
        }
        if evidence.heartbeatGaps > 0 {
            return .keepSoaking(reason: "\(evidence.heartbeatGaps) heartbeat gap(s)")
        }
        if evidence.unexpectedDivergences > 0 {
            return .keepSoaking(
                reason: "\(evidence.unexpectedDivergences) unexplained decision divergence(s)")
        }
        return .promote
    }

    /// What a shadowing tick reports instead of acting.
    ///
    /// §6.5: "the candidate emits `enforcement.shadow_decision` events and the
    /// control plane diffs them against `enforcement_log`'s history for
    /// equivalent inputs."
    public static func shadowDecision(
        would: [String], windowId: String?, version: String, deadline: Date
    ) -> [String: Any] {
        var data: [String: Any] = [
            "would": would,
            "shadow_version": version,
            "shadow_until": ISO8601DateFormatter().string(from: deadline),
        ]
        if let windowId { data["window_id"] = windowId }
        return data
    }
}

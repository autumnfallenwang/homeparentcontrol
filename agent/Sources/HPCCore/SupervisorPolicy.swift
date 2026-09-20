import Foundation

/// Every decision the supervisor makes, with no I/O attached (§6.4).
///
/// The supervisor is "~300 lines, **enforcement-logic-free**" and is "the one
/// component that cannot be rolled back in place" (A.24). Those two facts are
/// why its judgement lives here, in the tested pure core, and only its
/// `installer(8)` and `launchctl(1)` calls live in the daemon.
///
/// ⚠️ **The supervisor's own failure mode is the dangerous one.** It holds
/// `launchctl kickstart -k`, which kills the enforcer. A supervisor that
/// decides "stale" wrongly, every 60 s, is a supervisor that kills the
/// enforcer every 60 s — a Mac that never locks, caused by the component whose
/// job is making sure it does. Every rule below is shaped by that: this type
/// degrades toward **doing nothing**, loudly, and never toward acting more.
public enum SupervisorPolicy {

    /// §6.4's triggers, verbatim.
    public static let healthStaleAfterS: TimeInterval = 300
    public static let crashWindowS: TimeInterval = 300
    public static let crashesForRollback = 3

    /// ⚠️ Not in the spec; added because the spec's rule alone loops.
    ///
    /// A rollback kickstarts the enforcer, which then takes a tick to write a
    /// fresh health file. Re-checking staleness 60 s later, before that write,
    /// sees the *old* file and rolls back again. `kickstartCooldownS` is the
    /// grace the restarted process needs to prove itself.
    public static let kickstartCooldownS: TimeInterval = 600

    /// ⚠️ Also not in the spec. After this many rollbacks in 24 h the
    /// supervisor stops acting entirely and only reports.
    ///
    /// Rolling back four times in a day has already established that rolling
    /// back is not the fix. Continuing would trade a broken agent for a
    /// killed one, and a *killed* enforcer is strictly worse than a crashing
    /// one — a crashing enforcer is restarted by launchd and locks between
    /// crashes.
    public static let maxRollbacksPer24h = 3

    /// How many consecutive ticks must agree before staleness is believed.
    /// One sample cannot distinguish a dead daemon from a clock step.
    public static let staleConfirmations = 2

    public struct Health: Equatable, Sendable {
        public let job: String
        /// Nil when the file is missing or unparseable.
        public let writtenAt: Date?
        public let lastDecision: String?
        public let version: String?

        public init(job: String, writtenAt: Date?, lastDecision: String?, version: String?) {
            self.job = job
            self.writtenAt = writtenAt
            self.lastDecision = lastDecision
            self.version = version
        }
    }

    public struct State: Equatable, Sendable {
        public var consecutiveStale: [String: Int] = [:]
        public var lastKickstartAt: Date?
        public var rollbacksInWindow: [Date] = []
        public init() {}
    }

    public struct Inputs: Sendable {
        public var runningVersion: String
        public var health: [Health]
        /// Non-zero exits observed, newest last.
        public var recentCrashes: [Date]
        /// `pkgs/<version>.pkg` present on disk.
        public var stagedVersions: [String]
        public var lastGoodVersion: String?
        public var quarantined: Set<String>
        public var bootedAt: Date

        public init(
            runningVersion: String, health: [Health], recentCrashes: [Date],
            stagedVersions: [String], lastGoodVersion: String?, quarantined: Set<String>,
            bootedAt: Date
        ) {
            self.runningVersion = runningVersion
            self.health = health
            self.recentCrashes = recentCrashes
            self.stagedVersions = stagedVersions
            self.lastGoodVersion = lastGoodVersion
            self.quarantined = quarantined
            self.bootedAt = bootedAt
        }
    }

    public enum Decision: Equatable, Sendable {
        case idle
        /// Install a staged upgrade. Carries the digest to re-verify first.
        case install(version: String)
        /// Reinstall the last-good pkg from cache. **No network.**
        case rollback(to: String, quarantine: String, reason: String)
        /// Something is wrong and acting would make it worse. Report only.
        case report(reason: String)
    }

    public struct Step: Equatable, Sendable {
        public let decision: Decision
        public let state: State
        /// Always emitted, regardless of the decision.
        public let audit: [String: String]
    }

    public static func step(_ inputs: Inputs, state: State, now: Date) -> Step {
        var state = state
        var audit: [String: String] = [:]

        // ── Age out the rollback window first, so the cap is a rate and not a
        // lifetime total.
        state.rollbacksInWindow = state.rollbacksInWindow.filter {
            now.timeIntervalSince($0) < 86_400
        }

        // ── Staleness, confirmed over consecutive ticks.
        var staleJobs: [String] = []
        var anyStaleNow = false
        for health in inputs.health {
            let stale = isStale(health, now: now)
            if stale { anyStaleNow = true }
            let count = stale ? (state.consecutiveStale[health.job] ?? 0) + 1 : 0
            state.consecutiveStale[health.job] = count
            if count >= staleConfirmations { staleJobs.append(health.job) }
        }
        audit["stale_jobs"] = staleJobs.joined(separator: ",")

        let crashes = inputs.recentCrashes.filter { now.timeIntervalSince($0) <= crashWindowS }
        audit["recent_crashes"] = String(crashes.count)

        let needsRollback = !staleJobs.isEmpty || crashes.count >= crashesForRollback

        // ── Cooldown. A freshly kickstarted daemon has not had time to write
        // a health file yet, and neither has a freshly booted machine.
        let sinceKickstart = state.lastKickstartAt.map { now.timeIntervalSince($0) }
        let inCooldown =
            (sinceKickstart.map { $0 < kickstartCooldownS } ?? false)
            || now.timeIntervalSince(inputs.bootedAt) < kickstartCooldownS

        if needsRollback {
            if inCooldown {
                return Step(
                    decision: .report(reason: "unhealthy_but_in_cooldown"), state: state,
                    audit: audit)
            }
            if state.rollbacksInWindow.count >= maxRollbacksPer24h {
                // ⚠️ The deliberate dead end. See `maxRollbacksPer24h`.
                return Step(
                    decision: .report(reason: "rollback_budget_exhausted"), state: state,
                    audit: audit)
            }
            guard let lastGood = inputs.lastGoodVersion, lastGood != inputs.runningVersion,
                  inputs.stagedVersions.contains(lastGood)
            else {
                // Nothing to roll back TO. Restarting the same broken binary
                // is not a repair, and launchd is already doing it.
                return Step(
                    decision: .report(reason: "unhealthy_no_rollback_target"), state: state,
                    audit: audit)
            }
            state.rollbacksInWindow.append(now)
            state.lastKickstartAt = now
            state.consecutiveStale = [:]
            return Step(
                decision: .rollback(
                    to: lastGood, quarantine: inputs.runningVersion,
                    reason: staleJobs.isEmpty ? "crash_loop" : "health_stale"),
                state: state, audit: audit)
        }

        // ── Upgrades. Healthy only, and never while enforcement is live.
        //
        // ⚠️ **Strictly newer, and never the rollback target.**
        //
        // The pkg cache holds the last-good version *because* it is the thing
        // to fall back to. Treating "any staged version that is not the
        // running one" as an upgrade makes the supervisor downgrade a
        // perfectly healthy agent to its own safety net — and then, on the
        // next tick, see the newer pkg still staged and upgrade back. A
        // permanent install/downgrade oscillation, every 60 s, each iteration
        // kickstarting the enforcer.
        //
        // `SupervisorPolicyTests.oneStaleReadingIsNotEnough` failed with
        // `.install(version: "0.1.0")` — the rollback target — which is how
        // this was found rather than shipped.
        let candidates = inputs.stagedVersions
            .filter { version in
                version != inputs.runningVersion
                    && version != inputs.lastGoodVersion
                    && !inputs.quarantined.contains(version)
                    && isNewer(version, than: inputs.runningVersion)
            }
            .sorted(by: { isNewer($1, than: $0) })
        guard let candidate = candidates.last else {
            return Step(decision: .idle, state: state, audit: audit)
        }

        // ⚠️ **An upgrade needs a CLEAN signal, not merely an unconfirmed one.**
        //
        // `staleConfirmations` exists to stop a single reading triggering a
        // rollback. It is not a licence to install onto a machine that is one
        // tick away from being declared unhealthy — that would swap a sick
        // agent for an untested one at the worst possible moment, and then
        // quarantine the new version for the old one's crime.
        //
        // `SupervisorPolicyTests.rollbackBeatsInstall` failed with
        // `.install(version: "0.3.0")` against the confirmed-only check.
        if anyStaleNow || !crashes.isEmpty {
            return Step(decision: .report(reason: "upgrade_deferred_unhealthy"), state: state,
                        audit: audit)
        }
        if inCooldown {
            return Step(decision: .report(reason: "upgrade_deferred_cooldown"), state: state,
                        audit: audit)
        }

        // ⚠️ Do not install during a lock.
        //
        // Installing kickstarts the enforcer, and a restart mid-window drops
        // any escalation in flight. This reads `last_decision` — a status
        // string the enforcer already computed — rather than evaluating the
        // policy itself, which is what keeps the supervisor enforcement-logic-
        // free. X8: the health file is "the supervisor's input".
        let enforcing = inputs.health.contains {
            $0.job == "enforcer" && ($0.lastDecision == "lock" || $0.lastDecision == "shutdown")
        }
        if enforcing {
            return Step(decision: .report(reason: "upgrade_deferred_enforcing"), state: state,
                        audit: audit)
        }

        state.lastKickstartAt = now
        return Step(decision: .install(version: candidate), state: state, audit: audit)
    }

    /// Dotted-numeric version ordering, with a defined answer for everything.
    ///
    /// ⚠️ Not a semver library, and deliberately not: an unparseable component
    /// compares as **0**, so a version string the agent cannot read is never
    /// "newer" and therefore never installs itself. Guessing in the other
    /// direction would let a malformed `desired[]` spec trigger an install.
    public static func isNewer(_ lhs: String, than rhs: String) -> Bool {
        let left = lhs.split(separator: ".").map { Int($0) ?? 0 }
        let right = rhs.split(separator: ".").map { Int($0) ?? 0 }
        for index in 0..<max(left.count, right.count) {
            let l = index < left.count ? left[index] : 0
            let r = index < right.count ? right[index] : 0
            if l != r { return l > r }
        }
        return false
    }

    /// ⚠️ A health file from the *future* is not stale.
    ///
    /// A forward clock step makes every file look ancient at once, which under
    /// the naive rule rolls back a perfectly healthy agent. Treating future
    /// timestamps as fresh means a backward step costs one deferred rollback
    /// and a forward step costs nothing — the right way round.
    static func isStale(_ health: Health, now: Date) -> Bool {
        guard let writtenAt = health.writtenAt else { return true }
        let age = now.timeIntervalSince(writtenAt)
        if age < 0 { return false }
        return age > healthStaleAfterS
    }
}

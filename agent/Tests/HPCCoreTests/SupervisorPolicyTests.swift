import Foundation
import Testing

@testable import HPCCore

/// The supervisor's judgement. Every test answers the standing question from
/// the other side: *can this path leave the enforcer dead?* The supervisor
/// holds `launchctl kickstart -k`, so a wrong "stale" verdict every 60 s is a
/// Mac that never locks.
struct SupervisorPolicyTests {

    static let t0 = Date(timeIntervalSince1970: 1_800_000_000)
    /// Old enough that the boot-time cooldown is never the reason for an answer.
    static let bootedLongAgo = t0.addingTimeInterval(-86_400)

    static func health(
        _ job: String, ageS: TimeInterval, decision: String = "none", version: String = "0.1.0"
    ) -> SupervisorPolicy.Health {
        .init(
            job: job, writtenAt: t0.addingTimeInterval(-ageS), lastDecision: decision,
            version: version)
    }

    static func inputs(
        health: [SupervisorPolicy.Health] = [],
        crashes: [Date] = [],
        staged: [String] = [],
        lastGood: String? = nil,
        quarantined: Set<String> = [],
        running: String = "0.2.0",
        bootedAt: Date = bootedLongAgo
    ) -> SupervisorPolicy.Inputs {
        .init(
            runningVersion: running, health: health, recentCrashes: crashes,
            stagedVersions: staged, lastGoodVersion: lastGood, quarantined: quarantined,
            bootedAt: bootedAt)
    }

    /// Run ticks 60 s apart until the supervisor does something, and return
    /// that step — `staleConfirmations` means the first tick is never the
    /// interesting one, and the tick *after* an action is always a cooldown.
    static func settle(
        _ inputs: SupervisorPolicy.Inputs, ticks: Int = 4
    ) -> SupervisorPolicy.Step {
        var state = SupervisorPolicy.State()
        var last: SupervisorPolicy.Step?
        for i in 0..<ticks {
            let step = SupervisorPolicy.step(
                inputs, state: state, now: t0.addingTimeInterval(Double(i) * 60))
            state = step.state
            last = step
            // Stop at an ACTION. `.idle` and `.report` both mean the
            // supervisor did nothing this tick, so keep ticking past them.
            switch step.decision {
            case .install, .rollback: return step
            case .idle, .report: continue
            }
        }
        return last!
    }

    // MARK: - Idle

    @Test("a healthy agent with nothing staged does nothing")
    func idle() {
        let step = Self.settle(Self.inputs(health: [Self.health("enforcer", ageS: 30)]))
        #expect(step.decision == .idle)
    }

    // MARK: - ★ One sample is never enough

    /// ★ A single stale reading cannot distinguish a dead daemon from a clock
    /// step or a slow disk. Acting on one would make every hiccup a kickstart.
    @Test("★ one stale reading does not trigger a rollback")
    func oneStaleReadingIsNotEnough() {
        let inputs = Self.inputs(
            health: [Self.health("enforcer", ageS: 600)], staged: ["0.1.0"], lastGood: "0.1.0")
        let step = SupervisorPolicy.step(inputs, state: .init(), now: Self.t0)
        #expect(step.decision == .idle)
    }

    @Test("two consecutive stale readings do trigger a rollback")
    func confirmedStalenessRollsBack() {
        let step = Self.settle(
            Self.inputs(
                health: [Self.health("enforcer", ageS: 600)], staged: ["0.1.0"],
                lastGood: "0.1.0"))
        #expect(step.decision == .rollback(to: "0.1.0", quarantine: "0.2.0", reason: "health_stale"))
    }

    // MARK: - ★ A clock step is not a dead daemon

    /// ★ A health file written in the future means the clock went backwards,
    /// not that the daemon died. The naive `age > 300` rule reads a forward
    /// step as "every job is stale at once" and rolls back a healthy agent.
    @Test("★ a health file from the future is fresh, not stale")
    func futureTimestampIsFresh() {
        let step = Self.settle(
            Self.inputs(
                health: [Self.health("enforcer", ageS: -3_600)], staged: ["0.1.0"],
                lastGood: "0.1.0"))
        #expect(step.decision == .idle)
    }

    @Test("a missing health file is stale")
    func missingHealthIsStale() {
        let missing = SupervisorPolicy.Health(
            job: "enforcer", writtenAt: nil, lastDecision: nil, version: nil)
        let step = Self.settle(
            Self.inputs(health: [missing], staged: ["0.1.0"], lastGood: "0.1.0"))
        #expect(step.decision != .idle)
    }

    // MARK: - Crash loop

    @Test("three non-zero exits in five minutes roll back")
    func crashLoop() {
        let crashes = (0..<3).map { Self.t0.addingTimeInterval(-Double($0) * 60) }
        let step = Self.settle(
            Self.inputs(
                health: [Self.health("enforcer", ageS: 30)], crashes: crashes,
                staged: ["0.1.0"], lastGood: "0.1.0"))
        #expect(step.decision == .rollback(to: "0.1.0", quarantine: "0.2.0", reason: "crash_loop"))
    }

    @Test("three exits spread over an hour are not a crash loop")
    func crashesOutsideWindow() {
        let crashes = (0..<3).map { Self.t0.addingTimeInterval(-Double($0) * 1_200) }
        let step = Self.settle(
            Self.inputs(health: [Self.health("enforcer", ageS: 30)], crashes: crashes))
        #expect(step.decision == .idle)
    }

    // MARK: - ★ The loops the spec's rule alone does not close

    /// ★ A rollback kickstarts the enforcer, which needs a tick to write a
    /// fresh health file. Re-checking 60 s later without a cooldown sees the
    /// same old file and rolls back again, for ever.
    @Test("★ a second rollback is refused during the cooldown")
    func cooldownStopsTheRollbackLoop() {
        let inputs = Self.inputs(
            health: [Self.health("enforcer", ageS: 600)], staged: ["0.1.0"], lastGood: "0.1.0")
        var state = SupervisorPolicy.State()
        var first: SupervisorPolicy.Decision = .idle
        for i in 0..<3 {
            let step = SupervisorPolicy.step(
                inputs, state: state, now: Self.t0.addingTimeInterval(Double(i) * 60))
            state = step.state
            if case .rollback = step.decision { first = step.decision }
        }
        #expect(first != .idle)

        let next = SupervisorPolicy.step(
            inputs, state: state, now: Self.t0.addingTimeInterval(240))
        #expect(next.decision == .report(reason: "unhealthy_but_in_cooldown"))
    }

    /// ★ A freshly booted Mac has daemons that have not ticked yet. Without
    /// this, every reboot is a rollback.
    @Test("★ a machine that just booted is never rolled back")
    func bootCooldown() {
        let step = Self.settle(
            Self.inputs(
                health: [Self.health("enforcer", ageS: 600)], staged: ["0.1.0"],
                lastGood: "0.1.0", bootedAt: Self.t0.addingTimeInterval(-60)))
        #expect(step.decision == .report(reason: "unhealthy_but_in_cooldown"))
    }

    /// ★ After the budget, the supervisor stops acting and only reports. A
    /// *crashing* enforcer is restarted by launchd and locks between crashes;
    /// a *killed* one does not. Four rollbacks in a day has already proved
    /// rolling back is not the fix.
    @Test("★ the rollback budget degrades the supervisor into a reporter")
    func rollbackBudget() {
        let inputs = Self.inputs(
            health: [Self.health("enforcer", ageS: 600)], staged: ["0.1.0"], lastGood: "0.1.0")
        var state = SupervisorPolicy.State()
        var rollbacks = 0
        // Twelve hours of ticks, spaced past the cooldown every time.
        for i in 0..<24 {
            let now = Self.t0.addingTimeInterval(Double(i) * 1_800)
            var step = SupervisorPolicy.step(inputs, state: state, now: now)
            state = step.state
            // A second tick to satisfy the confirmation count.
            step = SupervisorPolicy.step(inputs, state: state, now: now.addingTimeInterval(60))
            state = step.state
            if case .rollback = step.decision { rollbacks += 1 }
        }
        #expect(rollbacks == SupervisorPolicy.maxRollbacksPer24h)

        let final = SupervisorPolicy.step(
            inputs, state: state, now: Self.t0.addingTimeInterval(24 * 1_800))
        #expect(final.decision == .report(reason: "rollback_budget_exhausted"))
    }

    /// Restarting the same broken binary is not a repair — and launchd is
    /// already doing it, for free, without killing anything mid-lock.
    @Test("★ with nothing to roll back TO, the supervisor reports and stops")
    func noRollbackTarget() {
        let step = Self.settle(Self.inputs(health: [Self.health("enforcer", ageS: 600)]))
        #expect(step.decision == .report(reason: "unhealthy_no_rollback_target"))
    }

    @Test("a last-good that is not actually cached is not a rollback target")
    func lastGoodMustBeOnDisk() {
        let step = Self.settle(
            Self.inputs(
                health: [Self.health("enforcer", ageS: 600)], staged: [], lastGood: "0.1.0"))
        #expect(step.decision == .report(reason: "unhealthy_no_rollback_target"))
    }

    // MARK: - Upgrades

    @Test("a staged newer version is installed when everything is healthy")
    func installsStaged() {
        let step = Self.settle(
            Self.inputs(
                health: [Self.health("enforcer", ageS: 30)], staged: ["0.3.0"],
                running: "0.2.0"))
        #expect(step.decision == .install(version: "0.3.0"))
    }

    @Test("a quarantined staged version is never installed")
    func neverInstallsQuarantined() {
        let step = Self.settle(
            Self.inputs(
                health: [Self.health("enforcer", ageS: 30)], staged: ["0.3.0"],
                quarantined: ["0.3.0"], running: "0.2.0"))
        #expect(step.decision == .idle)
    }

    /// ★ Installing kickstarts the enforcer. Doing that at 21:31 drops any
    /// escalation in flight. Reading `last_decision` — a string the enforcer
    /// already computed — defers the install without the supervisor ever
    /// evaluating a policy, which is what keeps it enforcement-logic-free.
    @Test("★ an upgrade is deferred while the enforcer is locking")
    func defersUpgradeDuringEnforcement() {
        let step = Self.settle(
            Self.inputs(
                health: [Self.health("enforcer", ageS: 30, decision: "lock")],
                staged: ["0.3.0"], running: "0.2.0"))
        #expect(step.decision == .report(reason: "upgrade_deferred_enforcing"))
    }

    @Test("an upgrade is also deferred mid-shutdown")
    func defersUpgradeDuringShutdown() {
        let step = Self.settle(
            Self.inputs(
                health: [Self.health("enforcer", ageS: 30, decision: "shutdown")],
                staged: ["0.3.0"], running: "0.2.0"))
        #expect(step.decision == .report(reason: "upgrade_deferred_enforcing"))
    }

    /// ★ Rollback outranks upgrade. An unhealthy agent with a shiny new pkg
    /// waiting must not install it — that is how a crash loop becomes two.
    @Test("★ an unhealthy agent rolls back rather than installing")
    func rollbackBeatsInstall() {
        let step = Self.settle(
            Self.inputs(
                health: [Self.health("enforcer", ageS: 600)], staged: ["0.1.0", "0.3.0"],
                lastGood: "0.1.0", running: "0.2.0"))
        #expect(step.decision == .rollback(to: "0.1.0", quarantine: "0.2.0", reason: "health_stale"))
    }

    @Test("the running version is never re-installed over itself")
    func neverReinstallsSelf() {
        let step = Self.settle(
            Self.inputs(
                health: [Self.health("enforcer", ageS: 30)], staged: ["0.2.0"],
                running: "0.2.0"))
        #expect(step.decision == .idle)
    }

    @Test("every tick emits an audit line whatever it decides")
    func alwaysAudits() {
        let step = Self.settle(Self.inputs(health: [Self.health("enforcer", ageS: 30)]))
        #expect(step.audit["stale_jobs"] != nil)
        #expect(step.audit["recent_crashes"] != nil)
    }
}

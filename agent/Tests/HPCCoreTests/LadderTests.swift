import Foundation
import Testing

@testable import HPCCore

/// The ladder, interrogated against the standing test on every branch:
/// *can this path result in the Mac staying usable past bedtime?*
struct LadderTests {

    static func evaluation(
        restricted: Bool,
        action: String = "lock",
        graceS: Int = 300,
        warnings: [BedtimePredicate.DueWarning] = []
    ) -> BedtimePredicate.Evaluation {
        let json = """
            {"id":"w1","label":"School nights","days":["mon"],
             "restricted_from":"21:30","restricted_until":"07:00","action":"\(action)",
             "action_options":{"shutdown_grace_s":\(graceS),"escalate_after_failures":3},
             "warnings":[]}
            """
        let window = try! JSONDecoder().decode(PolicyDocument.Window.self, from: Data(json.utf8))
        return BedtimePredicate.Evaluation(
            activeWindow: restricted ? window : nil,
            restrictedUntil: restricted ? Date().addingTimeInterval(3600) : nil,
            nextBoundaryAt: nil,
            dueWarnings: warnings,
            appliedOverrideIds: []
        )
    }

    static let t0 = Date(timeIntervalSince1970: 1_800_000_000)

    static func hasLock(_ d: Ladder.Decision) -> Bool { d.effects.contains(.lock) }
    static func hasShutdown(_ d: Ladder.Decision) -> Bool { d.effects.contains(.shutdown) }

    // MARK: - The lock is unconditional

    @Test("entering the window locks")
    func locksOnEntry() {
        let d = Ladder.step(
            evaluation: Self.evaluation(restricted: true), state: Ladder.State(), now: Self.t0)
        #expect(Self.hasLock(d))
    }

    @Test("outside the window nothing locks")
    func noLockOutside() {
        let d = Ladder.step(
            evaluation: Self.evaluation(restricted: false), state: Ladder.State(), now: Self.t0)
        #expect(!Self.hasLock(d))
    }

    /// "The enforcer RE-LOCKS every tick while the predicate holds.
    /// *Enforcement* is the re-locking, not the lock."
    @Test("it re-locks on the next tick, and the one after")
    func reLocks() {
        var state = Ladder.State()
        for tick in 0..<5 {
            let d = Ladder.step(
                evaluation: Self.evaluation(restricted: true),
                state: state,
                now: Self.t0.addingTimeInterval(Double(tick) * 60))
            #expect(Self.hasLock(d), Comment(rawValue: "tick \(tick) must re-lock"))
            state = d.state
        }
    }

    /// ★ X10. A failed warning is a health signal, never a gate.
    @Test("a FAILED warning does not stop the lock")
    func failedWarningStillLocks() {
        let d = Ladder.step(
            evaluation: Self.evaluation(restricted: true),
            state: Ladder.State(),
            now: Self.t0,
            previousWarning: (leadMinutes: 5, outcome: .failed))
        #expect(Self.hasLock(d))
        #expect(d.effects.contains { if case .audit(let k, _) = $0 { return k == "enforcement.warning_failed" } else { return false } })
    }

    /// ★ X10 again — "no console user logged in is not a skip, it is a no-op".
    @Test("no console user does not stop the lock")
    func noConsoleUserStillLocks() {
        let d = Ladder.step(
            evaluation: Self.evaluation(restricted: true),
            state: Ladder.State(),
            now: Self.t0,
            previousWarning: (leadMinutes: 5, outcome: .noConsoleUser))
        #expect(Self.hasLock(d))
        // And it is NOT reported as a failure — there was nothing to warn.
        #expect(!d.effects.contains { if case .audit(let k, _) = $0 { return k == "enforcement.warning_failed" } else { return false } })
    }

    /// ★ X9 — the breaker holds the rung; it never stops enforcing.
    @Test("a TRIPPED breaker still locks")
    func trippedBreakerStillLocks() {
        var state = Ladder.State()
        // Six episodes in 24 h trips a cap of five.
        state.recentEpisodes = (0..<6).map { Self.t0.addingTimeInterval(-Double($0) * 3600) }
        let d = Ladder.step(
            evaluation: Self.evaluation(restricted: true), state: state, now: Self.t0)
        #expect(d.state.breakerTripped)
        #expect(Self.hasLock(d), "the penalty is stop ESCALATING, never stop enforcing")
    }

    @Test("warn_only really does not lock")
    func warnOnlyDoesNotLock() {
        let d = Ladder.step(
            evaluation: Self.evaluation(restricted: true, action: "warn_only"),
            state: Ladder.State(), now: Self.t0)
        #expect(!Self.hasLock(d))
    }

    // MARK: - Escalation to shutdown

    /// The base case: grace elapsed, a warning was delivered, predicate holds.
    @Test("shutdown fires after the grace period when a warning was delivered")
    func shutdownAfterGrace() {
        var state = Ladder.State()
        state.episodeStartedAt = Self.t0
        state.warningsDelivered = [5]
        let d = Ladder.step(
            evaluation: Self.evaluation(restricted: true, action: "shutdown"),
            state: state,
            now: Self.t0.addingTimeInterval(301))
        #expect(Self.hasShutdown(d))
    }

    @Test("shutdown does NOT fire before the grace period")
    func noShutdownBeforeGrace() {
        var state = Ladder.State()
        state.episodeStartedAt = Self.t0
        state.warningsDelivered = [5]
        let d = Ladder.step(
            evaluation: Self.evaluation(restricted: true, action: "shutdown"),
            state: state,
            now: Self.t0.addingTimeInterval(299))
        #expect(!Self.hasShutdown(d))
        #expect(Self.hasLock(d), "but it is still locked throughout the grace")
    }

    /// ★ X10's other half. "Shutdown without notice destroys work — that is
    /// the one thing D.3 exists to prevent."
    @Test("shutdown does NOT fire when no warning was ever delivered")
    func noShutdownWithoutWarning() {
        var state = Ladder.State()
        state.episodeStartedAt = Self.t0
        state.warningsDelivered = []  // every attempt failed
        state.warningFailures = 4
        let d = Ladder.step(
            evaluation: Self.evaluation(restricted: true, action: "shutdown"),
            state: state,
            now: Self.t0.addingTimeInterval(3600))
        #expect(!Self.hasShutdown(d))
        #expect(Self.hasLock(d), "escalation is delayed; enforcement is not")
    }

    @Test("a tripped breaker holds the rung at lock, never reaching shutdown")
    func breakerBlocksEscalation() {
        var state = Ladder.State()
        state.episodeStartedAt = Self.t0
        state.warningsDelivered = [5]
        state.breakerTripped = true
        let d = Ladder.step(
            evaluation: Self.evaluation(restricted: true, action: "shutdown"),
            state: state,
            now: Self.t0.addingTimeInterval(3600))
        #expect(!Self.hasShutdown(d))
        #expect(Self.hasLock(d))
    }

    @Test("action=lock never escalates to shutdown, however long it runs")
    func lockNeverShutsDown() {
        var state = Ladder.State()
        state.episodeStartedAt = Self.t0
        state.warningsDelivered = [5]
        let d = Ladder.step(
            evaluation: Self.evaluation(restricted: true, action: "lock"),
            state: state,
            now: Self.t0.addingTimeInterval(86_400))
        #expect(!Self.hasShutdown(d))
    }

    @Test("shutdown fires once, not on every subsequent tick")
    func shutdownOnlyOnce() {
        var state = Ladder.State()
        state.episodeStartedAt = Self.t0
        state.warningsDelivered = [5]
        let first = Ladder.step(
            evaluation: Self.evaluation(restricted: true, action: "shutdown"),
            state: state, now: Self.t0.addingTimeInterval(301))
        #expect(Self.hasShutdown(first))

        let second = Ladder.step(
            evaluation: Self.evaluation(restricted: true, action: "shutdown"),
            state: first.state, now: Self.t0.addingTimeInterval(361))
        #expect(!Self.hasShutdown(second), "a shutdown loop outruns every recovery path")
    }

    /// "A corrected policy landing inside the grace window cancels the
    /// shutdown." That is the whole reason the grace exists.
    @Test("leaving the window during grace cancels the shutdown")
    func correctedPolicyCancels() {
        var state = Ladder.State()
        state.episodeStartedAt = Self.t0
        state.warningsDelivered = [5]

        let released = Ladder.step(
            evaluation: Self.evaluation(restricted: false),
            state: state, now: Self.t0.addingTimeInterval(120))
        #expect(!Self.hasShutdown(released))
        #expect(released.state.episodeStartedAt == nil)

        // And re-entering starts a FRESH grace, not a resumed one.
        let reentered = Ladder.step(
            evaluation: Self.evaluation(restricted: true, action: "shutdown"),
            state: released.state, now: Self.t0.addingTimeInterval(180))
        #expect(!Self.hasShutdown(reentered))
    }

    // MARK: - Episodes and warnings

    @Test("one bedtime window is one episode, however many re-locks")
    func oneEpisodePerWindow() {
        var state = Ladder.State()
        for tick in 0..<10 {
            state = Ladder.step(
                evaluation: Self.evaluation(restricted: true),
                state: state,
                now: Self.t0.addingTimeInterval(Double(tick) * 60)
            ).state
        }
        #expect(state.recentEpisodes.count == 1)
    }

    @Test("leaving and re-entering is two episodes")
    func twoEpisodes() {
        var state = Ladder.step(
            evaluation: Self.evaluation(restricted: true), state: Ladder.State(), now: Self.t0
        ).state
        state = Ladder.step(
            evaluation: Self.evaluation(restricted: false), state: state,
            now: Self.t0.addingTimeInterval(600)
        ).state
        state = Ladder.step(
            evaluation: Self.evaluation(restricted: true), state: state,
            now: Self.t0.addingTimeInterval(1200)
        ).state
        #expect(state.recentEpisodes.count == 2)
    }

    @Test("a due warning is delivered once, not on every tick")
    func warningFiresOnce() {
        let due = BedtimePredicate.DueWarning(
            leadMinutes: 5, channel: "modal", windowId: "w1",
            boundaryAt: Self.t0.addingTimeInterval(300))
        let first = Ladder.step(
            evaluation: Self.evaluation(restricted: false, warnings: [due]),
            state: Ladder.State(), now: Self.t0)
        #expect(first.effects.contains { if case .deliverWarning = $0 { return true } else { return false } })

        let second = Ladder.step(
            evaluation: Self.evaluation(restricted: false, warnings: [due]),
            state: first.state, now: Self.t0.addingTimeInterval(60))
        #expect(!second.effects.contains { if case .deliverWarning = $0 { return true } else { return false } })
    }

    /// ⚠️ Keyed by lead minutes alone, "already warned at T-30" would survive
    /// into the following night and suppress it — a bedtime arriving with no
    /// notice at all.
    @Test("a NEW boundary re-arms the warnings")
    func newBoundaryReArms() {
        let tonight = Self.dueWarning(lead: 30, at: Self.t0.addingTimeInterval(1800))
        let first = Ladder.step(
            evaluation: Self.evaluation(restricted: false, warnings: [tonight]),
            state: Ladder.State(), now: Self.t0)
        #expect(first.effects.contains { if case .deliverWarning = $0 { return true } else { return false } })

        // Same lead minutes, 24 hours later — a different boundary.
        let tomorrow = Self.dueWarning(lead: 30, at: Self.t0.addingTimeInterval(88_200))
        let second = Ladder.step(
            evaluation: Self.evaluation(restricted: false, warnings: [tomorrow]),
            state: first.state, now: Self.t0.addingTimeInterval(86_400))
        #expect(
            second.effects.contains { if case .deliverWarning = $0 { return true } else { return false } },
            "tomorrow's warning must still fire")
    }

    static func dueWarning(lead: Int, at: Date) -> BedtimePredicate.DueWarning {
        BedtimePredicate.DueWarning(
            leadMinutes: lead, channel: "modal", windowId: "w1", boundaryAt: at)
    }

    @Test("a delivered warning clears the failure counter")
    func deliveryClearsFailures() {
        var state = Ladder.State()
        state.warningFailures = 3
        let d = Ladder.step(
            evaluation: Self.evaluation(restricted: true), state: state, now: Self.t0,
            previousWarning: (leadMinutes: 5, outcome: .delivered))
        #expect(d.state.warningFailures == 0)
        #expect(d.state.warningsDelivered.contains(5))
    }

    // MARK: - The standing test, as an exhaustive sweep

    /// ★ Whatever combination of failures, absences and breakers is thrown at
    /// it, a restricted window must produce a lock. This is the one property
    /// that, if it ever goes false, means bedtime can be bypassed.
    @Test("NOTHING prevents the lock while the predicate holds")
    func nothingPreventsTheLock() {
        let outcomes: [Ladder.WarningOutcome?] = [nil, .delivered, .failed, .noConsoleUser]
        for outcome in outcomes {
            for tripped in [false, true] {
                for failures in [0, 1, 99] {
                    for delivered in [Set<Int>(), Set([5])] {
                        var state = Ladder.State()
                        state.breakerTripped = tripped
                        state.warningFailures = failures
                        state.warningsDelivered = delivered
                        state.recentEpisodes = tripped ? (0..<9).map { _ in Self.t0 } : []

                        let d = Ladder.step(
                            evaluation: Self.evaluation(restricted: true),
                            state: state,
                            now: Self.t0,
                            previousWarning: outcome.map { (leadMinutes: 5, outcome: $0) })

                        #expect(
                            Self.hasLock(d),
                            Comment(
                                rawValue:
                                    "lock must fire: outcome=\(String(describing: outcome)) "
                                    + "tripped=\(tripped) failures=\(failures) "
                                    + "delivered=\(delivered)"))
                    }
                }
            }
        }
    }
}

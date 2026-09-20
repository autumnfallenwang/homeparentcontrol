import Foundation
import Testing

@testable import HPCCore

/// Shadow mode — the ONE path that deliberately does not enforce.
///
/// Every test here is the standing Invariant E question asked of a feature
/// whose honest answer is "yes, on purpose, for a bounded window": *can this
/// path result in the Mac staying usable past bedtime, for longer or more
/// often than intended?*
struct ShadowModeTests {

    static let t0 = Date(timeIntervalSince1970: 1_800_000_000)
    static let version = "0.2.0"

    static func soak(
        version: String = version,
        startedAt: Date = t0,
        deadline: Date? = nil
    ) -> ShadowMode.Soak {
        .init(
            version: version,
            startedAt: startedAt,
            deadline: deadline ?? startedAt.addingTimeInterval(ShadowMode.maxDurationS))
    }

    static func isShadowing(_ verdict: ShadowMode.Verdict) -> Bool {
        if case .shadowing = verdict { return true }
        return false
    }

    // MARK: - The only way in

    @Test("a fresh soak for the running version shadows")
    func shadowsWhenSoaking() {
        let verdict = ShadowMode.verdict(
            soak: Self.soak(), runningVersion: Self.version, now: Self.t0.addingTimeInterval(3_600))
        #expect(Self.isShadowing(verdict))
    }

    // ★ Property: every ambiguity resolves to ENFORCING.
    @Test("★ no soak marker at all means enforce")
    func noMarkerEnforces() {
        #expect(
            ShadowMode.verdict(soak: nil, runningVersion: Self.version, now: Self.t0)
                == .enforcing)
    }

    /// ★ Property 3. Otherwise "reinstall the agent" buys a free unenforced
    /// day, every time — which makes reinstalling the bypass.
    @Test("★ a marker for a DIFFERENT version enforces")
    func staleMarkerEnforces() {
        let verdict = ShadowMode.verdict(
            soak: Self.soak(version: "0.1.0"), runningVersion: "0.2.0", now: Self.t0)
        #expect(verdict == .enforcing)
    }

    /// ★ A rollback goes to a version that has already soaked. It must
    /// enforce immediately — the machine is already in trouble, and an
    /// unenforced day on top of it is the wrong direction.
    @Test("★ rolling back to an already-soaked version enforces at once")
    func rollbackEnforces() {
        // The supervisor rolled back to 0.1.0; the marker still names 0.2.0.
        let verdict = ShadowMode.verdict(
            soak: Self.soak(version: "0.2.0"), runningVersion: "0.1.0", now: Self.t0)
        #expect(verdict == .enforcing)
    }

    // MARK: - ★ The hard deadline

    /// ★ Property 1, and the one the spec does not state. Promotion is
    /// automatic on criteria; if the criteria can never be met — a child
    /// away for a week means no bedtime window ever completes — the deadline
    /// is the only thing that ends this.
    @Test("★ past the deadline it enforces, whatever the soak says")
    func deadlineEndsIt() {
        let soak = Self.soak()
        let verdict = ShadowMode.verdict(
            soak: soak, runningVersion: Self.version,
            now: soak.deadline.addingTimeInterval(1))
        #expect(verdict == .enforcing)
    }

    @Test("★ exactly at the deadline it enforces")
    func deadlineIsInclusive() {
        let soak = Self.soak()
        #expect(
            ShadowMode.verdict(soak: soak, runningVersion: Self.version, now: soak.deadline)
                == .enforcing)
    }

    /// ★ A marker whose deadline is further out than the maximum was edited,
    /// or written by a clock later corrected. An untrustworthy "do not
    /// enforce" instruction is refused.
    @Test("★ a deadline beyond the maximum is refused, not honoured")
    func overlongDeadlineRefused() {
        let soak = ShadowMode.Soak(
            version: Self.version,
            startedAt: Self.t0,
            // A year of shadow. This is what a tampered marker looks like.
            deadline: Self.t0.addingTimeInterval(365 * 86_400))
        #expect(
            ShadowMode.verdict(soak: soak, runningVersion: Self.version, now: Self.t0)
                == .enforcing)
    }

    @Test("★ a soak that starts in the future is refused")
    func futureStartRefused() {
        let start = Self.t0.addingTimeInterval(86_400)
        let soak = Self.soak(startedAt: start)
        #expect(
            ShadowMode.verdict(soak: soak, runningVersion: Self.version, now: Self.t0)
                == .enforcing)
    }

    /// ⚠️ A clock stepped backwards mid-soak must not extend it. The
    /// deadline is absolute and baked in at entry, so a backwards step just
    /// means more shadow time up to that fixed instant — bounded, never
    /// renewed.
    @Test("★ a clock stepped BACKWARD cannot renew the window")
    func backwardClockCannotRenew() {
        let soak = ShadowMode.Soak.begin(version: Self.version, at: Self.t0)
        // Even at the extreme, the deadline is the deadline.
        #expect(soak.deadline == Self.t0.addingTimeInterval(ShadowMode.maxDurationS))
        #expect(
            ShadowMode.verdict(
                soak: soak, runningVersion: Self.version,
                now: soak.deadline.addingTimeInterval(1)) == .enforcing)
    }

    /// ★ The whole point, stated as a bound: shadow can never last longer
    /// than `maxDurationS` from the moment it began, under any input.
    @Test("★ EXHAUSTIVE — shadow never outlives its maximum")
    func neverOutlivesMaximum() {
        let starts = [Self.t0, Self.t0.addingTimeInterval(-86_400)]
        let offsets: [TimeInterval] = [
            0, 3_600, ShadowMode.minDurationS, ShadowMode.maxDurationS - 1,
            ShadowMode.maxDurationS, ShadowMode.maxDurationS + 1, 10 * 86_400,
        ]
        for start in starts {
            let soak = ShadowMode.Soak.begin(version: Self.version, at: start)
            for offset in offsets {
                let now = start.addingTimeInterval(offset)
                let verdict = ShadowMode.verdict(
                    soak: soak, runningVersion: Self.version, now: now)
                if offset >= ShadowMode.maxDurationS {
                    #expect(
                        verdict == .enforcing,
                        Comment(rawValue: "still shadowing \(offset)s after start"))
                }
            }
        }
    }

    // MARK: - Promotion (can only shorten)

    static func evidence(
        elapsedS: TimeInterval = ShadowMode.minDurationS + 60,
        windows: Int = 1, crashes: Int = 0, gaps: Int = 0, divergences: Int = 0
    ) -> ShadowMode.SoakEvidence {
        .init(
            elapsedS: elapsedS, completedBedtimeWindows: windows, crashes: crashes,
            heartbeatGaps: gaps, unexpectedDivergences: divergences)
    }

    @Test("a clean soak past 24 h with a bedtime window promotes")
    func cleanSoakPromotes() {
        #expect(ShadowMode.promotion(Self.evidence()) == .promote)
    }

    @Test("under 24 h does not promote")
    func tooEarly() {
        #expect(ShadowMode.promotion(Self.evidence(elapsedS: 3_600)) != .promote)
    }

    /// ★ "≥1 FULL bedtime window". A soak that never saw the thing the agent
    /// exists to do has tested nothing that matters.
    @Test("★ no completed bedtime window does not promote, however long")
    func noBedtimeWindow() {
        #expect(ShadowMode.promotion(Self.evidence(elapsedS: 10 * 86_400, windows: 0)) != .promote)
    }

    @Test("a crash, a gap or an unexplained divergence each block promotion")
    func anyFailureBlocks() {
        #expect(ShadowMode.promotion(Self.evidence(crashes: 1)) != .promote)
        #expect(ShadowMode.promotion(Self.evidence(gaps: 1)) != .promote)
        #expect(ShadowMode.promotion(Self.evidence(divergences: 1)) != .promote)
    }

    /// ★ Promotion NEVER extends. A soak that cannot promote still ends at
    /// the deadline — `verdict` does not consult evidence at all, which is
    /// what makes that structural rather than careful.
    @Test("★ a soak that can never promote still ends at the deadline")
    func unpromotableStillEnds() {
        // Crashing for ever: promotion is impossible.
        #expect(ShadowMode.promotion(Self.evidence(crashes: 99)) != .promote)
        let soak = ShadowMode.Soak.begin(version: Self.version, at: Self.t0)
        #expect(
            ShadowMode.verdict(
                soak: soak, runningVersion: Self.version,
                now: soak.deadline.addingTimeInterval(1)) == .enforcing)
    }

    // MARK: - The report

    @Test("a shadow decision records what it WOULD have done")
    func shadowDecisionShape() {
        let data = ShadowMode.shadowDecision(
            would: ["lock"], windowId: "w1", version: Self.version,
            deadline: Self.t0.addingTimeInterval(3_600))
        #expect(data["would"] as? [String] == ["lock"])
        #expect(data["shadow_version"] as? String == Self.version)
        #expect(data["window_id"] as? String == "w1")
        #expect(data["shadow_until"] != nil)
    }

    @Test("a release can declare an expected divergence")
    func expectedDivergence() {
        let soak = ShadowMode.Soak(
            version: Self.version, startedAt: Self.t0,
            deadline: Self.t0.addingTimeInterval(ShadowMode.maxDurationS),
            expectDivergence: true, divergenceReason: "fixes the DST off-by-one")
        #expect(soak.expectDivergence)
        #expect(soak.divergenceReason?.isEmpty == false)
        // ⚠️ And it changes nothing about the deadline.
        #expect(
            ShadowMode.verdict(
                soak: soak, runningVersion: Self.version,
                now: soak.deadline.addingTimeInterval(1)) == .enforcing)
    }
}

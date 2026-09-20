import Foundation
import Testing

@testable import HPCCore

/// The monitoring half. The standing question here is the mirror of the
/// enforcement one: *can this path report time the child did not spend, or
/// lose time she did?*
struct SamplerTests {

    static let t0 = Date(timeIntervalSince1970: 1_800_000_000)
    static let config = PolicyDocument.Telemetry.fallback

    static func observation(
        at: TimeInterval = 60, uptime: TimeInterval = 1_060,
        user: String? = "501", locked: Bool = false,
        bundle: String? = "com.apple.Safari", cpu: Double? = 12.5, idle: Double = 1
    ) -> Sampler.Observation {
        .init(
            at: t0.addingTimeInterval(at), uptime: uptime, consoleUser: user,
            screenLocked: locked, frontmostBundleId: bundle, frontmostCpuPct: cpu, idleS: idle)
    }

    /// A settled state, one interval in, so tests are not all about the first
    /// observation.
    static func settled(
        bundle: String? = "com.apple.Safari", idle: Double = 1
    ) -> Sampler.State {
        let first = observation(at: 0, uptime: 1_000, bundle: bundle, idle: idle)
        return Sampler.sample(first, state: .init(), telemetry: config).state
    }

    static func usage(_ output: Sampler.Output) -> Sampler.Event? {
        output.events.first { $0.type == "app.usage_sample" }
    }
    static func session(_ output: Sampler.Output) -> Sampler.Event? {
        output.events.first { $0.type == "session.state" }
    }

    // MARK: - The first observation

    /// ★ Nothing can be attributed to an interval with no start. The first
    /// observation establishes the baseline and must not invent 60 seconds.
    @Test("★ the very first observation reports no usage")
    func firstObservationIsBaselineOnly() {
        let output = Sampler.sample(Self.observation(), state: .init(), telemetry: Self.config)
        #expect(Self.usage(output) == nil)
        // It does establish the session state, which is a transition from nil.
        #expect(Self.session(output)?.text["state"] == "active")
    }

    // MARK: - ★ The meter (A.33)

    @Test("an active interval reports its full span")
    func activeInterval() {
        let output = Sampler.sample(
            Self.observation(idle: 1), state: Self.settled(), telemetry: Self.config)
        let sample = Self.usage(output)
        #expect(sample?.data["foreground_s"] == 60)
        #expect(sample?.data["active_s"] == 59)
        #expect(sample?.text["bundle_id"] == "com.apple.Safari")
    }

    /// ★ "An idle Spotify window left open overnight must not burn an hour of
    /// a budget." Once idle exceeds the interval, nothing in it was input.
    @Test("★ an interval spent entirely idle reports zero active_s")
    func idleIntervalBurnsNothing() {
        let output = Sampler.sample(
            Self.observation(idle: 3_600), state: Self.settled(), telemetry: Self.config)
        let sample = Self.usage(output)
        #expect(sample?.data["foreground_s"] == 60, "the window was still frontmost")
        #expect(sample?.data["active_s"] == 0, "but nobody was there")
    }

    @Test("active_s is never negative and never exceeds the span")
    func activeIsBounded() {
        for idle in [0.0, 1, 30, 59.9, 60, 61, 100_000] {
            let value = Sampler.activeSeconds(in: 60, idleS: idle)
            #expect(value >= 0)
            #expect(value <= 60)
        }
    }

    // MARK: - ★ Clock traps

    /// ★ A clock step must not inject usage. Elapsed time is measured on the
    /// MONOTONIC clock, so the wall clock can do whatever it likes.
    @Test("★ a one-hour clock jump forward does not report an hour of usage")
    func clockStepForwardInventsNothing() {
        var state = Self.settled()
        state.lastAt = Self.t0.addingTimeInterval(-3_600)  // wall clock jumped
        let output = Sampler.sample(
            Self.observation(at: 0, uptime: 1_060), state: state, telemetry: Self.config)
        #expect(Self.usage(output)?.data["foreground_s"] == 60, "monotonic says 60 s")
    }

    @Test("★ a clock step BACKWARD does not produce negative usage")
    func clockStepBackward() {
        var state = Self.settled()
        state.lastAt = Self.t0.addingTimeInterval(86_400)
        let output = Sampler.sample(
            Self.observation(at: 0, uptime: 1_060), state: state, telemetry: Self.config)
        let sample = Self.usage(output)
        #expect((sample?.data["foreground_s"] ?? -1) >= 0)
    }

    /// ★ A missed timer — a debugger pause, a stalled probe, a suspended
    /// process — must not land as one enormous sample.
    @Test("★ a very long gap is clamped, not reported whole")
    func longGapIsClamped() {
        let output = Sampler.sample(
            Self.observation(at: 100_000, uptime: 100_000), state: Self.settled(),
            telemetry: Self.config)
        #expect(Self.usage(output)?.data["foreground_s"] == Sampler.maxIntervalS)
    }

    /// Uptime going backwards means a reboot the daemon did not notice.
    @Test("uptime running backwards contributes nothing")
    func uptimeWentBackwards() {
        let output = Sampler.sample(
            Self.observation(at: 60, uptime: 5), state: Self.settled(), telemetry: Self.config)
        #expect(Self.usage(output) == nil)
    }

    /// ★ `systemUptime` does not advance while the Mac sleeps, so a wall
    /// clock that moved much further than the monotonic one IS a sleep.
    @Test("★ a wall/monotonic divergence is reported as asleep")
    func sleepIsInferred() {
        var state = Self.settled()
        state.lastAt = Self.t0.addingTimeInterval(-8 * 3_600)
        state.lastUptime = 1_000
        let output = Sampler.sample(
            Self.observation(at: 0, uptime: 1_060), state: state, telemetry: Self.config)
        #expect(output.events.contains { $0.text["state"] == "asleep" })
    }

    @Test("a normal interval is not mistaken for sleep")
    func noFalseSleep() {
        let output = Sampler.sample(
            Self.observation(), state: Self.settled(), telemetry: Self.config)
        #expect(!output.events.contains { $0.text["state"] == "asleep" })
    }

    // MARK: - ★ Session state is a transition, not a duration

    /// ★ The contract says "a transition, not a duration", and the projector
    /// derives each span's end from the NEXT transition. Emitting every tick
    /// would write 1,440 rows a day that all say the same thing and produce a
    /// stream of zero-length spans.
    @Test("★ an unchanged session state emits nothing")
    func stateOnlyOnTransition() {
        var state = Self.settled()
        for tick in 1...5 {
            let output = Sampler.sample(
                Self.observation(at: Double(tick) * 60, uptime: 1_000 + Double(tick) * 60),
                state: state, telemetry: Self.config)
            state = output.state
            #expect(Self.session(output) == nil, "tick \(tick) re-emitted an unchanged state")
        }
    }

    @Test("going idle transitions active → awake")
    func activeToAwake() {
        let output = Sampler.sample(
            Self.observation(idle: 600), state: Self.settled(), telemetry: Self.config)
        #expect(Self.session(output)?.text["state"] == "awake")
    }

    @Test("locking transitions to locked and carries the console user")
    func locking() {
        let output = Sampler.sample(
            Self.observation(locked: true), state: Self.settled(), telemetry: Self.config)
        #expect(Self.session(output)?.text["state"] == "locked")
    }

    @Test("no console user is the login window, which is locked")
    func loginWindowIsLocked() {
        let output = Sampler.sample(
            Self.observation(user: nil), state: Self.settled(), telemetry: Self.config)
        #expect(Self.session(output)?.text["state"] == "locked")
    }

    // MARK: - ★ Nothing is attributed while locked

    /// ★ A locked Mac has no frontmost app in any meaningful sense. Crediting
    /// one would put a whole night of "Safari" in a report — and `lsappinfo`
    /// will happily keep naming the last app that was frontmost.
    @Test("★ a locked screen reports no app usage at all")
    func lockedReportsNoUsage() {
        let output = Sampler.sample(
            Self.observation(locked: true), state: Self.settled(), telemetry: Self.config)
        #expect(Self.usage(output) == nil)
    }

    @Test("an unknown frontmost app reports no usage rather than a blank one")
    func noBundleNoSample() {
        for bundle in [nil, ""] {
            let output = Sampler.sample(
                Self.observation(bundle: bundle), state: Self.settled(), telemetry: Self.config)
            #expect(Self.usage(output) == nil)
        }
    }

    @Test("cpu_pct is omitted when it could not be read, not reported as zero")
    func missingCpuIsAbsent() {
        let output = Sampler.sample(
            Self.observation(cpu: nil), state: Self.settled(), telemetry: Self.config)
        #expect(Self.usage(output)?.data["cpu_pct"] == nil)
    }

    // MARK: - ★ The telemetry block

    @Test("★ telemetry disabled emits nothing at all")
    func disabledEmitsNothing() {
        var config = PolicyDocument.Telemetry.fallback
        config = .init(
            enabled: false, sampleIntervalS: 60, flushIntervalS: 300, collect: config.collect,
            maxQueueEvents: 1, maxQueueBytes: 1, maxQueueAgeDays: 1, auditRetentionDays: 1)
        let output = Sampler.sample(
            Self.observation(), state: Self.settled(), telemetry: config)
        #expect(output.events.isEmpty)
    }

    @Test("a collect list that omits app usage still emits session state")
    func collectFiltersPerType() {
        let config = PolicyDocument.Telemetry(
            enabled: true, sampleIntervalS: 60, flushIntervalS: 300,
            collect: ["session.state"], maxQueueEvents: 1, maxQueueBytes: 1,
            maxQueueAgeDays: 1, auditRetentionDays: 1)
        let output = Sampler.sample(
            Self.observation(locked: true), state: Self.settled(), telemetry: config)
        #expect(Self.session(output) != nil)
        #expect(Self.usage(output) == nil)
    }
}

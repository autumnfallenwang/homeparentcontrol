import Foundation

/// Turning one observation of the machine into telemetry events (§4.1, A.33).
///
/// ⚠️ **This is the monitoring half of the product**, and until it existed the
/// projector, `usage_hourly`, `usage_daily` and every report page consumed
/// event types that nothing on the device produced. Phase 3's five steps are
/// enforcer, V-series, sync, supervisor, deadfall; the sampler is in none of
/// them, and no milestone owned it.
///
/// ⚠️ **It can never touch enforcement.** It runs inside the sync daemon —
/// which §3.1's table marks "contains enforcement logic: ❌ none" — on its own
/// fixed timer, and writes only to `queue.sqlite`. It is not in the enforcer
/// because a sampler bug must not be able to crash the one process whose job
/// is locking the Mac.
public enum Sampler {

    /// What the machine looked like at one instant. All of it is cheap to
    /// read and none of it needs a TCC grant — the permission-free tier.
    public struct Observation: Equatable, Sendable {
        public let at: Date
        /// ⚠️ Monotonic, and the reason the estimator below is safe. See
        /// `elapsed(since:)`.
        public let uptime: TimeInterval
        /// Nil when nobody is at the console (the login window).
        public let consoleUser: String?
        public let screenLocked: Bool
        public let frontmostBundleId: String?
        public let frontmostCpuPct: Double?
        /// `HIDIdleTime`, in SECONDS. The ioreg value is nanoseconds.
        public let idleS: Double

        public init(
            at: Date, uptime: TimeInterval, consoleUser: String?, screenLocked: Bool,
            frontmostBundleId: String?, frontmostCpuPct: Double?, idleS: Double
        ) {
            self.at = at
            self.uptime = uptime
            self.consoleUser = consoleUser
            self.screenLocked = screenLocked
            self.frontmostBundleId = frontmostBundleId
            self.frontmostCpuPct = frontmostCpuPct
            self.idleS = idleS
        }
    }

    /// The four `session_spans.kind` values.
    public enum SessionState: String, Equatable, Sendable {
        case awake, active, locked, asleep
    }

    public struct State: Equatable, Sendable {
        public var lastAt: Date?
        public var lastUptime: TimeInterval?
        public var sessionState: SessionState?
        public init() {}
    }

    public struct Event: Equatable, Sendable {
        public let type: String
        public let at: Date
        public let data: [String: Double]
        public let text: [String: String]
    }

    public struct Output: Equatable, Sendable {
        public var events: [Event] = []
        public var state: State
    }

    /// Below this, the session counts as `active` rather than merely `awake`.
    /// 📄 The same 5 minutes macOS itself uses for "user is idle".
    public static let idleThresholdS: Double = 300

    /// ⚠️ A single interval may never contribute more than this. A clock step,
    /// a debugger pause or a missed timer must not inject an hour of
    /// "Minecraft" into a child's day.
    public static let maxIntervalS: TimeInterval = 300

    /// A wall-clock gap this much larger than the monotonic gap means the
    /// machine was asleep in between.
    public static let sleepDetectionSlackS: TimeInterval = 30

    /// Interval length, measured MONOTONICALLY.
    ///
    /// ⚠️ `Date` is the wrong clock for a duration here, twice over. A clock
    /// step — NTP, a DST bug, a child changing the date — would make an
    /// interval negative or enormous. And `systemUptime` does not advance
    /// while the Mac is asleep, which is exactly the semantics wanted: eight
    /// hours of sleep accrued no foreground time and must not be reported as
    /// if it did.
    public static func elapsed(_ observation: Observation, since state: State) -> TimeInterval {
        guard let last = state.lastUptime else { return 0 }
        let delta = observation.uptime - last
        // A negative delta means uptime went backwards, which means a reboot
        // the daemon did not notice. Contribute nothing rather than guess.
        guard delta > 0 else { return 0 }
        return min(delta, maxIntervalS)
    }

    /// Fold one observation into events.
    ///
    /// Pure: an observation and the previous state in, events and the next
    /// state out. No commands, no files, no clock of its own.
    public static func sample(
        _ observation: Observation, state: State, telemetry: PolicyDocument.Telemetry
    ) -> Output {
        var state = state
        var events: [Event] = []

        let span = elapsed(observation, since: state)

        // ── Did the machine sleep through this interval?
        //
        // Wall clock advanced but the monotonic clock did not. Emitted before
        // the current state so the span ordering in `session_spans` is right.
        if let lastAt = state.lastAt, span > 0 || state.lastUptime != nil {
            let wall = observation.at.timeIntervalSince(lastAt)
            let monotonic = observation.uptime - (state.lastUptime ?? observation.uptime)
            if wall - monotonic > sleepDetectionSlackS,
               telemetry.collects("session.state"),
               state.sessionState != .asleep
            {
                events.append(
                    Event(
                        type: "session.state", at: lastAt,
                        data: ["gap_s": wall - monotonic],
                        text: ["state": SessionState.asleep.rawValue]))
            }
        }

        // ── The current session state, emitted only on a TRANSITION.
        //
        // The contract is explicit: "`session.state` → `session_spans`. A
        // transition, not a duration." Emitting every tick would write 1,440
        // rows a day that all say the same thing, and the projector derives
        // each span's end from the NEXT transition — so a stream of identical
        // states produces a stream of zero-length spans.
        let current = classify(observation)
        if current != state.sessionState, telemetry.collects("session.state") {
            var text = ["state": current.rawValue]
            if let user = observation.consoleUser { text["console_user"] = user }
            events.append(
                Event(type: "session.state", at: observation.at, data: [:], text: text))
        }
        state.sessionState = current

        // ── Foreground usage.
        //
        // Nothing is attributed while locked or logged out: there is no
        // frontmost app, and crediting one would put a night of "Safari" in
        // a report.
        if span > 0, current != .locked, let bundle = observation.frontmostBundleId,
           !bundle.isEmpty, telemetry.collects("app.usage_sample")
        {
            var data: [String: Double] = [
                "foreground_s": span,
                "active_s": activeSeconds(in: span, idleS: observation.idleS),
            ]
            if let cpu = observation.frontmostCpuPct { data["cpu_pct"] = cpu }
            events.append(
                Event(
                    type: "app.usage_sample", at: observation.at, data: data,
                    text: ["bundle_id": bundle]))
        }

        state.lastAt = observation.at
        state.lastUptime = observation.uptime
        return Output(events: events, state: state)
    }

    /// ★ A.33 — the meter. "An idle Spotify window left open overnight must
    /// not burn an hour of a budget."
    ///
    /// `HIDIdleTime` says how long ago the last input was, so `span - idleS`
    /// is the part of the interval that certainly contained input.
    ///
    /// ⚠️ **This is an estimator and it is stated as one.** A single sample
    /// cannot know the middle of an interval: someone who typed once at the
    /// start and once at the end reads as fully active. What it gets exactly
    /// right is the case the rule exists for — sustained idleness reads as
    /// zero, because once `idleS >= span` nothing in the interval was input.
    /// A binary "idle or not" threshold gets that case right too and the
    /// boundary wrong; this gets both as right as one sample allows.
    public static func activeSeconds(in span: TimeInterval, idleS: Double) -> Double {
        max(0, min(span, span - idleS))
    }

    static func classify(_ observation: Observation) -> SessionState {
        // No console user is the login window. `locked` is the honest
        // mapping: the machine is on and nobody can use it.
        guard observation.consoleUser != nil, !observation.screenLocked else { return .locked }
        return observation.idleS < idleThresholdS ? .active : .awake
    }
}

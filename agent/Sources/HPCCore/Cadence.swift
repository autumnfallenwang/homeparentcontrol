import Foundation

/// The sync daemon's one timer, and every rule about its period (§4.2).
///
/// > "The agent has exactly one timer; everything below is that timer changing
/// > its period. **The server owns it** — every response carries
/// > `next_poll_after_ms`, clamped by the agent to `[1000, 300000]`. The
/// > agent's own boundary logic can only ever *shorten* the interval, never
/// > lengthen it, so a server bug cannot slow the agent past 5 minutes and a
/// > cold policy cannot make it hammer."
///
/// ⚠️ **None of this can reach enforcement.** The enforcer is a separate
/// daemon with its own unconditional 60 s tick, so an agent in 300-second
/// backoff still locks at 21:30 on time. That separation is the reason backoff
/// is allowed to be this aggressive.
public enum Cadence {

    /// §4.2's table. `backoff` is not a mode the server can ask for — it is
    /// what consecutive failures produce.
    public enum Mode: String, Equatable, Sendable {
        case base, boundary, attended, backoff
    }

    // The clamp. Both ends are load-bearing and neither is ours to relax: the
    // floor stops a server bug turning the agent into a hammer, the ceiling
    // stops one making it silent.
    public static let floorMs = 1_000
    public static let ceilingMs = 300_000

    public static let baseMs = 60_000
    public static let boundaryMs = 15_000
    /// `poll.boundary_lead_s` — how close to a transition counts as "near".
    public static let boundaryLeadS: TimeInterval = 900

    /// Full jitter, 1 s doubling to the 300 s ceiling. 📄 AWS's "Exponential
    /// Backoff and Jitter": full jitter, not equal jitter — with one client
    /// the thundering herd is irrelevant, but full jitter is also what keeps a
    /// restarting agent from re-synchronising with a restarting server.
    public static let backoffFloorMs = 1_000

    public struct Decision: Equatable, Sendable {
        public let mode: Mode
        public let intervalMs: Int
        /// Why, for the log line. A cadence nobody can explain is a cadence
        /// nobody can debug at 21:29.
        public let reason: String
    }

    /// Everything that can influence the next period.
    public struct Inputs: Sendable {
        /// `next_poll_after_ms` from the last 200. Nil when we never got one.
        public var serverSuggestionMs: Int?
        /// `Retry-After`, in seconds, from a 429 or 503. Always wins.
        public var retryAfterS: Int?
        /// Consecutive failed syncs. Zero on any success.
        public var consecutiveFailures: Int
        /// The enforcer's next warn-or-enforce transition, if the sync daemon
        /// has a policy to read it from.
        public var nextBoundaryAt: Date?

        public init(
            serverSuggestionMs: Int? = nil,
            retryAfterS: Int? = nil,
            consecutiveFailures: Int = 0,
            nextBoundaryAt: Date? = nil
        ) {
            self.serverSuggestionMs = serverSuggestionMs
            self.retryAfterS = retryAfterS
            self.consecutiveFailures = consecutiveFailures
            self.nextBoundaryAt = nextBoundaryAt
        }
    }

    /// Decide the next period.
    ///
    /// `randomBelow` is injected so the jitter is testable — a backoff you
    /// cannot write a deterministic test for is a backoff nobody tests.
    public static func next(
        _ inputs: Inputs,
        now: Date,
        randomBelow: (Int) -> Int = { $0 <= 0 ? 0 : Int.random(in: 0..<$0) }
    ) -> Decision {
        // ── Backoff first, and it outranks everything.
        if inputs.consecutiveFailures > 0 {
            // `Retry-After` always wins — the server is telling us something
            // the exponent cannot know. Still clamped: a hostile or broken
            // `Retry-After: 86400` must not silence the agent for a day.
            if let retryAfterS = inputs.retryAfterS {
                return Decision(
                    mode: .backoff,
                    intervalMs: clamp(retryAfterS * 1_000),
                    reason: "retry_after")
            }
            // 1 s, 2 s, 4 s … capped at the ceiling, then full jitter across
            // the whole window: `random(0, cap)`, not `cap/2 + random(cap/2)`.
            let exponent = min(inputs.consecutiveFailures - 1, 20)
            let window = min(ceilingMs, backoffFloorMs << exponent)
            return Decision(
                mode: .backoff,
                intervalMs: clamp(randomBelow(window)),
                reason: "backoff_\(inputs.consecutiveFailures)")
        }

        // ── The server's number is the baseline. Its absence means base.
        var mode: Mode = .base
        var interval = clamp(inputs.serverSuggestionMs ?? baseMs)
        var reason = inputs.serverSuggestionMs == nil ? "default" : "server"

        // A server asking for 5 s is the `attended` sticky flag; we do not
        // model that flag ourselves, we just report what the period means.
        if let suggested = inputs.serverSuggestionMs, suggested <= 10_000 {
            mode = .attended
            reason = "server_attended"
        }

        // ── ⚠️ ONE-WAY. The boundary rule may only ever SHORTEN.
        //
        // Written as `min`, not as an assignment, because the difference is
        // the whole guarantee: if the server says 5 s because a parent has the
        // page open, being 900 s from bedtime must not push us back out to
        // 15 s. Every local rule is a `min` against what the server asked for.
        if let boundary = inputs.nextBoundaryAt,
           boundary > now,
           boundary.timeIntervalSince(now) <= boundaryLeadS,
           boundaryMs < interval
        {
            interval = boundaryMs
            mode = .boundary
            reason = "boundary_lead"
        }

        return Decision(mode: mode, intervalMs: interval, reason: reason)
    }

    public static func clamp(_ ms: Int) -> Int { min(ceilingMs, max(floorMs, ms)) }
}

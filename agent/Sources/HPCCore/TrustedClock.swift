import Foundation

/// What time it really is, when the Mac's own clock cannot be believed
/// (§3.2 step 4, §4.6 class E, ADR 0015).
///
/// ⚠️ **Found the hard way, 2026-10-03.** Ivy set her Mac's clock 23 hours
/// ahead at 00:00; the predicate was fed `Date()`, decided the 00:45 shutdown
/// was a day away, and she used Chrome straight through it. Step 4 had been in
/// the tick's comment since the start and in no code at all.
///
/// Three witnesses, and two must agree (ADR 0015):
///
/// - **wall** — `Date()`. The child sets it.
/// - **server** — the `server_time` of the last sync, carried forward on the
///   continuous clock. The only absolute reference, but our server can be
///   wrong too, and a wrongful 19:00 lockout is the worst failure this
///   project has (§4.6).
/// - **own** — our last trusted instant carried forward on the continuous
///   clock (`mach_continuous_time`: counts sleep, unmoved by any clock change,
///   reset only by a reboot). Across a reboot: the error last measured,
///   re-applied — the RTC keeps her change — and never behind the high-water
///   mark, because time does not run backwards across a reboot.
///
/// ⚠️ **`own` only outvotes the server when it has been confirmed by the
/// server at least once.** An anchor seeded from the wall clock is a copy of
/// the wall clock, not a second witness: on a fresh install over a clock that
/// is already wrong, wall and own would "agree" and outvote the truth for ever.
///
/// Pure: a reading, the server's anchor and the persisted state in; the
/// instant to enforce on and the next state out. Never throws, never returns
/// "unknown" — every branch lands on a time to enforce on (Invariant E: a
/// clock we cannot trust is a reason to enforce on a better one, never a
/// reason not to enforce).
public enum TrustedClock {

    /// §3.2 step 4: "|Δrealtime − Δcontinuous| > 30 s ⇒ clock.stepped".
    public static let tolerance: TimeInterval = 30

    /// Offline, wall and continuous drift apart by ~1.7 s/day (measured,
    /// 2026-10-03). Agreement this close re-anchors to the wall so the drift
    /// never accumulates into a false step. A creep slower than this per tick
    /// goes unseen offline — and is caught by the server the moment it syncs.
    public static let reanchorWithin: TimeInterval = 2

    public struct Reading: Equatable, Sendable {
        public let wall: Date
        /// Seconds since boot, counting sleep.
        public let continuous: TimeInterval
        /// `kern.bootsessionuuid` — which boot `continuous` counts from.
        public let bootSession: String

        public init(wall: Date, continuous: TimeInterval, bootSession: String) {
            self.wall = wall
            self.continuous = continuous
            self.bootSession = bootSession
        }
    }

    /// A trusted instant pinned to a point on one boot's continuous clock.
    public struct Anchor: Codable, Equatable, Sendable {
        public var utc: Date
        public var continuous: TimeInterval
        public var bootSession: String
        /// The server stands behind this lineage. Only a confirmed anchor may
        /// outvote the server — see the type's header.
        public var confirmed: Bool

        public init(utc: Date, continuous: TimeInterval, bootSession: String, confirmed: Bool) {
            self.utc = utc
            self.continuous = continuous
            self.bootSession = bootSession
            self.confirmed = confirmed
        }

        /// This anchor carried forward to `reading`; nil on another boot.
        public func project(_ reading: Reading) -> Date? {
            guard bootSession == reading.bootSession else { return nil }
            return utc.addingTimeInterval(reading.continuous - continuous)
        }

        enum CodingKeys: String, CodingKey {
            case utc, continuous = "continuous_s", bootSession = "boot_session", confirmed
        }
    }

    /// What survives a restart of the enforcer, or of the Mac.
    public struct State: Codable, Equatable, Sendable {
        public var anchor: Anchor?
        /// The latest trusted instant used. Offline, nothing earlier is believed.
        public var highWater: Date?
        /// wall − trusted at the last resolution.
        public var offset: TimeInterval = 0
        /// The offset last reported as a step, so each change is reported once.
        public var reportedOffset: TimeInterval = 0
        /// The server was outvoted last time — reported once per episode.
        public var serverOutvoted = false

        public init() {}

        enum CodingKeys: String, CodingKey {
            case anchor, highWater = "high_water", offset = "offset_s"
            case reportedOffset = "reported_offset_s", serverOutvoted = "server_outvoted"
        }

        public init(from decoder: Decoder) throws {
            // ⚠️ Tolerant: a half-understood state file degrades to "fresh",
            // which means enforcing on the server's time or the wall's —
            // never to not enforcing.
            let c = try decoder.container(keyedBy: CodingKeys.self)
            anchor = try? c.decodeIfPresent(Anchor.self, forKey: .anchor)
            highWater = try? c.decodeIfPresent(Date.self, forKey: .highWater)
            offset = (try? c.decodeIfPresent(Double.self, forKey: .offset)) ?? 0
            reportedOffset = (try? c.decodeIfPresent(Double.self, forKey: .reportedOffset)) ?? 0
            serverOutvoted = (try? c.decodeIfPresent(Bool.self, forKey: .serverOutvoted)) ?? false
        }
    }

    public enum Source: String, Sendable {
        case server, own, wall
    }

    /// The wall clock's error moved: `from` and `to` are wall − trusted.
    public struct Step: Equatable, Sendable {
        public let from: TimeInterval
        public let to: TimeInterval
    }

    public struct Resolution: Equatable, Sendable {
        /// The instant to enforce on.
        public let now: Date
        public let source: Source
        /// wall − now. Positive: the Mac's clock is ahead.
        public let offset: TimeInterval
        /// Set once per change of more than `tolerance`.
        public let step: Step?
        /// The server disagreed with both other witnesses and was ignored.
        public let serverOutvoted: Bool
        /// True on the first resolution of an outvoted episode only.
        public let serverOutvotedStarted: Bool
        /// The server's time agrees with a reckoning the server confirmed
        /// earlier — consistent with itself, not just the only voice. The
        /// sync daemon sets the Mac's clock from our server only then.
        public let serverCorroborated: Bool
        public let state: State

        /// The Mac's clock is wrong by more than the tolerance.
        public var clockUntrusted: Bool { abs(offset) > TrustedClock.tolerance }

        /// `now` carried forward to a later reading on the same boot.
        public func project(_ reading: Reading) -> Date {
            state.anchor?.project(reading) ?? reading.wall.addingTimeInterval(-offset)
        }
    }

    /// The server's `server_time`, pinned to the continuous clock.
    ///
    /// The API stamps `server_time` as it builds the response, so the reply
    /// is roughly half a round trip old when it lands. The round trip is
    /// measured on the continuous clock — a step mid-request must not poison
    /// it. (A cached reply would: `URLSession` served a stale `GET /health`
    /// after every backwards step in the POC. Sync is a POST, never cached.)
    public static func serverAnchor(
        serverTime: Date, sentContinuous: TimeInterval, receivedContinuous: TimeInterval,
        bootSession: String
    ) -> Anchor {
        let roundTrip = max(0, receivedContinuous - sentContinuous)
        return Anchor(
            utc: serverTime.addingTimeInterval(roundTrip / 2), continuous: receivedContinuous,
            bootSession: bootSession, confirmed: true)
    }

    public static func resolve(reading: Reading, server: Anchor?, state incoming: State)
        -> Resolution
    {
        var state = incoming
        let wall = reading.wall
        let serverNow = server?.project(reading)

        // Our own reckoning, and whether the server ever stood behind it.
        let own: (at: Date, confirmed: Bool)?
        if let anchor = state.anchor, let projected = anchor.project(reading) {
            own = (projected, anchor.confirmed)
        } else if state.anchor != nil || state.highWater != nil {
            // A new boot: the error we last measured survived in the RTC.
            var carried = wall.addingTimeInterval(-state.offset)
            if let highWater = state.highWater, carried < highWater { carried = highWater }
            own = (carried, state.anchor?.confirmed ?? false)
        } else {
            own = nil  // first run ever
        }

        func agree(_ a: Date?, _ b: Date?) -> Bool {
            guard let a, let b else { return false }
            return abs(a.timeIntervalSince(b)) <= tolerance
        }

        let now: Date
        let source: Source
        var outvoted = false
        let corroborated = own?.confirmed == true && agree(serverNow, own?.at)
        if let serverNow, agree(serverNow, own?.at) || agree(serverNow, wall) {
            now = serverNow
            source = .server
        } else if let own, own.confirmed, agree(own.at, wall), serverNow != nil {
            // Two independent witnesses against the server: it is the one that is wrong.
            now = abs(own.at.timeIntervalSince(wall)) <= reanchorWithin ? wall : own.at
            source = .own
            outvoted = true
        } else if let serverNow {
            // Nobody agrees, or only an unconfirmed (wall-seeded) reckoning
            // agrees with the wall: the server is the only absolute reference.
            now = serverNow
            source = .server
        } else if let own {
            // Offline. Close to the wall: take the wall, absorbing drift. Far
            // from it: the wall was moved, and the continuous clock was not.
            if abs(own.at.timeIntervalSince(wall)) <= reanchorWithin {
                now = wall
                source = .wall
            } else {
                now = own.at
                source = .own
            }
        } else {
            now = wall
            source = .wall
        }

        // ── Carry the decision forward.
        switch source {
        case .server:
            state.anchor = Anchor(
                utc: now, continuous: reading.continuous, bootSession: reading.bootSession,
                confirmed: true)
            // The server is the authority on absolute time: a high-water mark
            // it contradicts was itself wrong (an offline boot that believed a
            // clock set ahead), and must not pin us in the future.
            state.highWater = now
        case .own, .wall:
            state.anchor = Anchor(
                utc: now, continuous: reading.continuous, bootSession: reading.bootSession,
                confirmed: own?.confirmed ?? false)
            state.highWater = max(state.highWater ?? now, now)
        }

        let offset = wall.timeIntervalSince(now)
        state.offset = offset
        var step: Step?
        if abs(offset - state.reportedOffset) > tolerance {
            step = Step(from: state.reportedOffset, to: offset)
            state.reportedOffset = offset
        }
        let outvotedStarted = outvoted && !state.serverOutvoted
        state.serverOutvoted = outvoted

        return Resolution(
            now: now, source: source, offset: offset, step: step, serverOutvoted: outvoted,
            serverOutvotedStarted: outvotedStarted, serverCorroborated: corroborated, state: state)
    }
}

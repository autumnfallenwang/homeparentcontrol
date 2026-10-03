import Foundation
import Testing

@testable import HPCCore

/// `TrustedClock` — three witnesses, two must agree (ADR 0015).
///
/// Every case is a way the Mac's clock, our server, or our own reckoning can
/// be wrong, and the assertion is always the same question: *which instant do
/// the rules get asked about?*
struct TrustedClockTests {

    static let t0 = Date(timeIntervalSince1970: 1_790_000_000)
    static let boot = "boot-A"

    static func reading(
        realOffset elapsed: TimeInterval, wallError: TimeInterval = 0, boot: String = boot,
        bootedAt: TimeInterval = 0
    ) -> TrustedClock.Reading {
        TrustedClock.Reading(
            wall: t0.addingTimeInterval(elapsed + wallError), continuous: elapsed - bootedAt,
            bootSession: boot)
    }

    /// The server, heard at `elapsed`, telling the truth (or `error` off it).
    static func server(at elapsed: TimeInterval, error: TimeInterval = 0, boot: String = boot)
        -> TrustedClock.Anchor
    {
        TrustedClock.Anchor(
            utc: t0.addingTimeInterval(elapsed + error), continuous: elapsed, bootSession: boot,
            confirmed: true)
    }

    static func real(_ elapsed: TimeInterval) -> Date { t0.addingTimeInterval(elapsed) }

    /// Run a sequence of readings through the clock, threading state.
    static func run(
        _ steps: [(reading: TrustedClock.Reading, server: TrustedClock.Anchor?)],
        from start: TrustedClock.State = .init()
    ) -> [TrustedClock.Resolution] {
        var state = start
        return steps.map { step in
            let resolution = TrustedClock.resolve(
                reading: step.reading, server: step.server, state: state)
            state = resolution.state
            return resolution
        }
    }

    // MARK: - The incident

    @Test("tonight: the wall jumps 23 h; server and own reckoning agree, and win")
    func incident() {
        let r = Self.run([
            (Self.reading(realOffset: 0), Self.server(at: 0)),
            (Self.reading(realOffset: 60, wallError: 23 * 3600), Self.server(at: 0)),
        ])
        #expect(r[1].now == Self.real(60))
        #expect(r[1].source == .server)
        #expect(r[1].clockUntrusted)
        #expect(r[1].step == TrustedClock.Step(from: 0, to: 23 * 3600))
        #expect(r[1].serverCorroborated)
    }

    @Test("offline: the wall moves, the continuous clock does not, and the timer wins")
    func offlineStep() {
        let r = Self.run([
            (Self.reading(realOffset: 0), nil),
            (Self.reading(realOffset: 60, wallError: -7200), nil),
            (Self.reading(realOffset: 120, wallError: -7200), nil),
        ])
        #expect(r[1].now == Self.real(60))
        #expect(r[1].source == .own)
        #expect(r[2].now == Self.real(120))
        #expect(r[1].step != nil)
        #expect(r[2].step == nil)  // reported once, not every tick
    }

    @Test("a step back to the real time is reported too — the 'clock put right' line")
    func stepBack() {
        let r = Self.run([
            (Self.reading(realOffset: 0), Self.server(at: 0)),
            (Self.reading(realOffset: 60, wallError: 3600), Self.server(at: 0)),
            (Self.reading(realOffset: 120), Self.server(at: 0)),
        ])
        #expect(r[2].step == TrustedClock.Step(from: 3600, to: 0))
        #expect(!r[2].clockUntrusted)
    }

    // MARK: - Two of three

    @Test("the server jumps an hour: wall and our confirmed reckoning outvote it")
    func serverOutvoted() {
        let r = Self.run([
            (Self.reading(realOffset: 0), Self.server(at: 0)),
            (Self.reading(realOffset: 60), Self.server(at: 60, error: 3600)),
            (Self.reading(realOffset: 120), Self.server(at: 120, error: 3600)),
        ])
        #expect(abs(r[1].now.timeIntervalSince(Self.real(60))) < 1)
        #expect(r[1].serverOutvoted)
        #expect(r[1].serverOutvotedStarted)
        #expect(!r[2].serverOutvotedStarted)  // once per episode
        #expect(abs(r[2].now.timeIntervalSince(Self.real(120))) < 1)
    }

    /// ⚠️ THE REGRESSION GUARD for the independence rule. Ivy's Mac at the
    /// moment of install: clock 22 h ahead, no state, server not yet heard.
    /// The first tick can only take the wall; the anchor that leaves is a
    /// COPY of the wall. When the server arrives, that copy must not "agree"
    /// with the wall and outvote the truth for ever.
    @Test("a fresh install on a wrong clock: a wall-seeded reckoning cannot outvote the server")
    func freshInstallOnWrongClock() {
        let r = Self.run([
            (Self.reading(realOffset: 0, wallError: 22 * 3600), nil),
            (Self.reading(realOffset: 30, wallError: 22 * 3600), Self.server(at: 20)),
            (Self.reading(realOffset: 90, wallError: 22 * 3600), Self.server(at: 80)),
        ])
        #expect(r[0].source == .wall)  // nothing better exists yet
        #expect(r[1].now == Self.real(30))
        #expect(r[1].source == .server)
        #expect(!r[1].serverOutvoted)
        #expect(!r[1].serverCorroborated)  // only voice: do not set the clock from it yet
        #expect(r[2].serverCorroborated)   // consistent with itself a minute later
    }

    @Test("all three agree: enforce on the server's time, and nothing is flagged")
    func allAgree() {
        let r = Self.run([
            (Self.reading(realOffset: 0), Self.server(at: 0)),
            (Self.reading(realOffset: 60), Self.server(at: 60, error: 0.3)),
        ])
        #expect(r[1].source == .server)
        #expect(!r[1].clockUntrusted)
        #expect(r[1].step == nil)
        #expect(!r[1].serverOutvoted)
    }

    // MARK: - Reboots

    @Test("clock forward, offline, restart: the error measured before survives the reboot")
    func carryAcrossReboot() {
        let before = Self.run([
            (Self.reading(realOffset: 0), Self.server(at: 0)),
            (Self.reading(realOffset: 60, wallError: 840), nil),
        ])
        // New boot: continuous restarts, the server anchor is from the old boot.
        let after = TrustedClock.resolve(
            reading: Self.reading(realOffset: 120, wallError: 840, boot: "boot-B", bootedAt: 100),
            server: Self.server(at: 0), state: before[1].state)
        #expect(after.now == Self.real(120))
        #expect(after.source == .own)
    }

    @Test("clock back, offline, restart: never earlier than the high-water mark")
    func highWaterAcrossReboot() {
        var state = TrustedClock.State()
        state.highWater = Self.real(3600)
        state.anchor = Self.server(at: 3600, boot: "boot-old")
        state.offset = 0  // the step happened while the agent was not looking
        let r = TrustedClock.resolve(
            reading: Self.reading(realOffset: 3700, wallError: -7200, boot: "boot-new"),
            server: nil, state: state)
        #expect(r.now >= Self.real(3600))
        #expect(r.clockUntrusted)
    }

    @Test("the server overrides a high-water mark it contradicts — no pinning in the future")
    func serverResetsHighWater() {
        var state = TrustedClock.State()
        state.highWater = Self.real(22 * 3600)  // believed a clock set ahead, offline
        let r = TrustedClock.resolve(
            reading: Self.reading(realOffset: 60, wallError: 22 * 3600), server: Self.server(at: 50),
            state: state)
        #expect(r.now == Self.real(60))
        #expect(r.state.highWater == Self.real(60))
    }

    // MARK: - Not false alarms

    @Test("offline drift under two seconds re-anchors to the wall instead of accumulating")
    func driftAbsorbed() {
        let r = Self.run([
            (Self.reading(realOffset: 0), nil),
            (Self.reading(realOffset: 60, wallError: 1.5), nil),
            (Self.reading(realOffset: 120, wallError: 3.0), nil),
        ])
        #expect(r.allSatisfy { $0.step == nil })
        #expect(r[2].source == .wall)
    }

    @Test("a 25-second-a-minute creep is caught by the second minute")
    func creepCaught() {
        let r = Self.run([
            (Self.reading(realOffset: 0), nil),
            (Self.reading(realOffset: 60, wallError: -25), nil),
            (Self.reading(realOffset: 120, wallError: -50), nil),
        ])
        #expect(r[2].step != nil)
        #expect(r[2].now == Self.real(120))
    }

    // MARK: - The server anchor

    @Test("server_time is placed half a round trip before it landed")
    func serverAnchorHalfRoundTrip() {
        let anchor = TrustedClock.serverAnchor(
            serverTime: Self.t0, sentContinuous: 10, receivedContinuous: 10.4, bootSession: "b")
        #expect(abs(anchor.utc.timeIntervalSince(Self.t0) - 0.2) < 1e-6)
        #expect(anchor.continuous == 10.4)
        #expect(anchor.confirmed)
    }

    @Test("a state file this build half-understands degrades to fresh, never to a throw")
    func tolerantState() throws {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let state = try decoder.decode(
            TrustedClock.State.self, from: Data(#"{"anchor": 7, "offset_s": "x"}"#.utf8))
        #expect(state.anchor == nil)
        #expect(state.offset == 0)
    }
}

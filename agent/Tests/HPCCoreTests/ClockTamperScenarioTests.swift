import Foundation
import Testing

@testable import HPCCore

/// Every way a child can move the clock, second by second, through the REAL
/// `BedtimePredicate` and `Ladder` with Ivy's real schedule (ADR 0015).
///
/// The POC's matrix (`tools/verify/clock-tamper`, 2026-10-03), kept as a
/// test. The question each scenario asks: on the night she tampers, does the
/// Mac still shut down when it would have on a night she didn't?
///
/// ★ It also runs the agent as it was — `Date()` — and asserts that version
/// FAILS. A harness that cannot see the bug proves nothing about the fix
/// ([[falsify-the-gate]]).
struct ClockTamperScenarioTests {

    // MARK: - Ivy's schedule, policy v8, IDs replaced

    static let policy: PolicyDocument = {
        let warnings = """
            [{"channel":"banner","lead_minutes":30},{"channel":"banner","lead_minutes":15},
             {"channel":"modal","lead_minutes":5},{"channel":"modal","lead_minutes":1}]
            """
        let json = """
            {"policy_version":8,"issued_at":"2026-10-01T12:00:00.000Z",
             "device_id":"00000000-0000-7000-8000-000000000001",
             "subject":{"child_id":"00000000-0000-7000-8000-000000000002","display_name":"Ivy"},
             "timezone":"America/New_York","overrides":[],
             "schedule":{"kind":"windows","windows":[
              {"id":"weekdays","label":"Weekdays","days":["mon","tue","wed","thu","sun"],
               "restricted_from":"23:45","restricted_until":"23:55","action":"shutdown",
               "action_options":{"shutdown_grace_s":300,"escalate_after_failures":3},
               "warnings":\(warnings)},
              {"id":"weekends","label":"Weekends","days":["fri","sat"],
               "restricted_from":"00:45","restricted_until":"00:55","action":"shutdown",
               "action_options":{"shutdown_grace_s":300,"escalate_after_failures":3},
               "warnings":\(warnings)}]}}
            """
        return try! PolicyDocument.decode(from: Data(json.utf8))
    }()

    static func at(_ text: String) -> Date {
        let formatter = DateFormatter()
        formatter.timeZone = TimeZone(identifier: "America/New_York")
        formatter.dateFormat = "yyyy-MM-dd HH:mm:ss"
        return formatter.date(from: text)!
    }

    // MARK: - The model

    enum Move {
        case shift(TimeInterval)   // the child moves the clock by Δ
        case set(String)           // the child types a time
        case restart(off: TimeInterval)
        case wifi(Bool)
    }

    enum Basis: Equatable {
        case wall                              // the agent before ADR 0015
        case trusted(server: Bool, fix: Bool)  // ADR 0015, with or without a network
    }

    /// Real time of the first shutdown, or nil if none came.
    static func run(
        _ start: String, _ end: String, _ moves: [(String, Move)], basis: Basis
    ) -> Date? {
        var real = at(start)
        let stop = at(end)
        var wallError: TimeInterval = 0
        var continuous: TimeInterval = 4 * 3600
        var boot = 1
        var online = true
        var offUntil: Date?
        var script = moves.map { (at($0.0), $0.1) }

        var clockState = TrustedClock.State()
        var serverAnchor: TrustedClock.Anchor?
        var ladder = Ladder.State()
        var pending: (Int, Ladder.WarningOutcome)?
        var tickSecond = 4    // the enforcer ticks at :04, as on Ivy's Mac
        var syncSecond = 34   // sync lands half a minute later

        while real <= stop {
            while let (when, move) = script.first, when <= real {
                script.removeFirst()
                switch move {
                case .shift(let delta): wallError += delta
                case .set(let text): wallError = at(text).timeIntervalSince(real)
                case .wifi(let on): online = on
                case .restart(let off): offUntil = real.addingTimeInterval(off)
                }
            }
            if let until = offUntil {
                if real < until {
                    real += 1
                    continue
                }
                // Power-on: a new boot, new processes. The RTC kept the error.
                offUntil = nil
                boot += 1
                continuous = 0
                ladder = Ladder.State()
                pending = nil
                tickSecond = 20
                syncSecond = 35
            }
            let reading = TrustedClock.Reading(
                wall: real.addingTimeInterval(wallError), continuous: continuous,
                bootSession: "boot-\(boot)")
            let second = Int(real.timeIntervalSince1970) % 60

            if case .trusted(let server, let fix) = basis, server, online, second == syncSecond {
                serverAnchor = TrustedClock.Anchor(
                    utc: real, continuous: continuous, bootSession: reading.bootSession,
                    confirmed: true)
                // The sync daemon turning automatic time back on.
                if fix, abs(wallError) > 60 { wallError = 0 }
            }

            if second == tickSecond {
                let now: Date
                switch basis {
                case .wall:
                    now = reading.wall
                case .trusted:
                    let resolution = TrustedClock.resolve(
                        reading: reading, server: serverAnchor, state: clockState)
                    clockState = resolution.state
                    now = resolution.now
                }
                let step = Ladder.step(
                    evaluation: BedtimePredicate.evaluate(policy: policy, now: now),
                    state: ladder, now: now, previousWarning: pending)
                ladder = step.state
                pending = nil
                for effect in step.effects {
                    if case .deliverWarning(let lead, _, _, _) = effect { pending = (lead, .delivered) }
                    if effect == .shutdown { return real }
                }
            }
            real += 1
            continuous += 1
        }
        return nil
    }

    // MARK: - The matrix

    struct Scenario: CustomTestStringConvertible, Sendable {
        let id: String
        let start: String
        let end: String
        let moves: [(String, Move)]
        var testDescription: String { id }
    }

    static let sun = "2026-10-04"
    static let late = "2026-10-05 03:00:00"

    static func sunday(_ id: String, _ moves: [(String, Move)]) -> Scenario {
        Scenario(id: id, start: "\(sun) 23:00:00", end: late, moves: moves)
    }

    static let scenarios: [Scenario] = [
        sunday("S0 control", []),
        Scenario(
            id: "S1 tonight: 00:00 → Sat 23:00, then back 1 h", start: "2026-10-02 23:50:00",
            end: "2026-10-03 03:00:00",
            moves: [
                ("2026-10-03 00:00:30", .set("2026-10-03 23:00:24")),
                ("2026-10-03 00:55:00", .shift(-3600)),
            ]),
        sunday("S2 T−30, back 2 h", [("\(sun) 23:15:00", .shift(-7200))]),
        sunday("S3 T−10, back 30 min", [("\(sun) 23:35:00", .shift(-1800))]),
        sunday("S4 T−5, back 10 min", [("\(sun) 23:40:00", .shift(-600))]),
        sunday("S5 T−1, back 5 min", [("\(sun) 23:44:10", .shift(-300))]),
        sunday("S6 in the grace, back 1 h", [("\(sun) 23:47:00", .shift(-3600))]),
        sunday("S7 forward past the window", [("\(sun) 23:46:00", .shift(600))]),
        sunday(
            "S8 back 2 h, restart",
            [("\(sun) 23:30:00", .shift(-7200)), ("\(sun) 23:31:00", .restart(off: 60))]),
        sunday(
            "S9 Wi-Fi off, back 2 h",
            [("\(sun) 23:20:00", .wifi(false)), ("\(sun) 23:30:00", .shift(-7200))]),
        sunday(
            "S10 Wi-Fi off, back 2 h, restart",
            [
                ("\(sun) 23:20:00", .wifi(false)), ("\(sun) 23:30:00", .shift(-7200)),
                ("\(sun) 23:31:00", .restart(off: 60)),
            ]),
        sunday(
            "S11 Wi-Fi off, forward to 23:57, restart",
            [
                ("\(sun) 23:20:00", .wifi(false)), ("\(sun) 23:43:00", .shift(840)),
                ("\(sun) 23:43:30", .restart(off: 30)),
            ]),
        sunday(
            "S12 creep 25 s a minute",
            (0..<45).map { (String(format: "\(sun) 23:%02d:40", $0), Move.shift(-25)) }),
    ]

    /// When the same night, untouched, shuts down.
    static func due(_ scenario: Scenario) -> Date {
        run(scenario.start, scenario.end, [], basis: .wall)!
    }

    @Test(
        "trusted time shuts down on time, whatever she does to the clock",
        arguments: scenarios,
        [
            Basis.trusted(server: true, fix: true), .trusted(server: true, fix: false),
            .trusted(server: false, fix: false),
        ])
    func trustedHolds(_ scenario: Scenario, basis: Basis) throws {
        let off = try #require(
            Self.run(scenario.start, scenario.end, scenario.moves, basis: basis),
            "never shut down")
        // A restart costs the boot itself (~20 s); nothing else may be late.
        #expect(off.timeIntervalSince(Self.due(scenario)) < 60)
        #expect(off.timeIntervalSince(Self.due(scenario)) > -60)
    }

    // MARK: - Falsification: the harness can see the bug

    @Test("the agent as it was: tonight's move and a forward jump each skip the shutdown")
    func wallClockBypassed() {
        for id in ["S1", "S7", "S11"] {
            let scenario = Self.scenarios.first { $0.id.hasPrefix(id + " ") }!
            #expect(
                Self.run(scenario.start, scenario.end, scenario.moves, basis: .wall) == nil,
                "\(id) should have bypassed the wall-clock agent")
        }
    }

    @Test("the agent as it was: setting the clock back delays the shutdown by exactly that much")
    func wallClockDelayed() throws {
        let scenario = Self.scenarios.first { $0.id.hasPrefix("S3 ") }!
        let off = try #require(
            Self.run(scenario.start, scenario.end, scenario.moves, basis: .wall))
        #expect(abs(off.timeIntervalSince(Self.due(scenario)) - 1800) < 60)
    }
}

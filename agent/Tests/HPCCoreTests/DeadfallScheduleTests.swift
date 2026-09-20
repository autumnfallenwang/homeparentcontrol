import Foundation
import Testing

@testable import HPCCore

/// §4.6's class-A backstop: if both daemons are dead, bedtime still happens.
struct DeadfallScheduleTests {

    static let ny = TimeZone(identifier: "America/New_York")!
    static let honolulu = TimeZone(identifier: "Pacific/Honolulu")!

    /// Monday 2026-09-21, 12:00 New York.
    static let monday = PredicateTests.ny("2026-09-21 12:00")

    static func entries(
        _ policy: PolicyDocument, now: Date = monday, zone: TimeZone = ny
    ) -> [DeadfallSchedule.Entry] {
        DeadfallSchedule.entries(policy: policy, now: now, systemZone: zone)
    }

    // MARK: - The basics

    @Test("a nightly 21:30 window schedules a 21:30 wake-up")
    func schedulesTheBoundary() {
        let policy = PredicateTests.schoolNights(
            days: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"])
        let result = Self.entries(policy)
        #expect(result.contains(where: { $0.hour == 21 && $0.minute == 30 }))
    }

    @Test("a school-nights policy covers exactly its five nights")
    func onlyScheduledDays() {
        let policy = PredicateTests.schoolNights(days: ["sun", "mon", "tue", "wed", "thu"])
        let weekdays = Set(
            Self.entries(policy).filter { $0.hour == 21 && $0.minute == 30 }.map(\.weekday))
        // Calendar weekdays: 1 = Sunday … 5 = Thursday.
        #expect(weekdays == [1, 2, 3, 4, 5])
    }

    @Test("no windows means no wake-ups at all")
    func emptySchedule() throws {
        let json = """
            {"policy_version":1,"issued_at":"2026-09-20T12:00:00.000Z",
             "device_id":"018f2a4c-7b31-7c9e-9d2a-3f5b7c1e4a60",
             "subject":{"child_id":"018f2a4b-6a20-7b8d-8c1f-2e4a6b8d0f31","display_name":"Lucy"},
             "timezone":"America/New_York","schedule":{"kind":"windows","windows":[]},
             "overrides":[]}
            """
        let policy = try PolicyDocument.decode(from: Data(json.utf8))
        #expect(Self.entries(policy).isEmpty)
    }

    // MARK: - ★ The timezone trap

    /// ★ `StartCalendarInterval` is evaluated in the SYSTEM zone; A.30 says the
    /// POLICY's zone wins. A child who moves the Mac to Honolulu would shift
    /// every naive wall-clock entry by six hours — a bypass reachable from
    /// System Settings without admin. Resolving to an instant first is what
    /// closes it.
    @Test("★ a system timezone different from the policy's does not move bedtime")
    func systemZoneDoesNotMoveBedtime() {
        let policy = PredicateTests.schoolNights(
            days: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"])

        let inNY = Self.entries(policy, zone: Self.ny)
        let inHonolulu = Self.entries(policy, zone: Self.honolulu)

        // Same instants, so the wall-clock rendering MUST differ — that is the
        // proof they were resolved rather than copied.
        #expect(inNY.contains { $0.hour == 21 && $0.minute == 30 })
        #expect(inHonolulu.contains { $0.hour == 15 && $0.minute == 30 })
        #expect(!inHonolulu.contains { $0.hour == 21 && $0.minute == 30 })
    }

    /// The same instant in Honolulu is 15:30 on the SAME day here, but for a
    /// zone east of the policy it rolls onto the next weekday — which the
    /// instant-first approach gets right and a wall-clock copy does not.
    @Test("★ a zone east of the policy's rolls the weekday correctly")
    func weekdayRollsOver() {
        let policy = PredicateTests.schoolNights(days: ["mon"])
        let tokyo = TimeZone(identifier: "Asia/Tokyo")!
        let result = Self.entries(policy, zone: tokyo)
        // Monday 21:30 New York is Tuesday 10:30 Tokyo.
        #expect(result.contains { $0.weekday == 3 && $0.hour == 10 && $0.minute == 30 })
    }

    // MARK: - ★ Scheduling is permissive; deciding is the predicate's job

    /// ★ A suspended window still gets a wake-up. The grant can be revoked
    /// before tonight, and the deadfall re-reads `overrides[]` when it fires;
    /// baking the override into the plist would turn a stale file into a
    /// bypass that survives the grant it came from.
    @Test("★ an override does not remove the wake-up it relaxes")
    func overrideDoesNotRemoveTheWakeup() {
        let overrides = """
            [{"id":"018f2a4b-7c31-7d9e-9a2b-3c5d7e9f1a99","type":"suspend",
              "effective_date":"2026-09-21",
              "expires_at":"2026-09-22T12:00:00.000Z"}]
            """
        let policy = PredicateTests.schoolNights(days: ["mon"], overrides: overrides)
        #expect(Self.entries(policy).contains { $0.hour == 21 && $0.minute == 30 })
    }

    // MARK: - Follow-ups and DST

    /// launchd runs a missed `StartCalendarInterval` once on wake, not once
    /// per miss. The follow-ups cost two entries and buy three chances.
    @Test("each boundary carries its follow-up wake-ups")
    func followUps() {
        let policy = PredicateTests.schoolNights(days: ["mon"])
        let result = Self.entries(policy)
        #expect(result.contains { $0.hour == 21 && $0.minute == 35 })
        #expect(result.contains { $0.hour == 21 && $0.minute == 50 })
    }

    /// ⚠️ Spring-forward: 2026-03-08 in New York. A wall-clock plist is simply
    /// wrong for the week around a transition; instants are not.
    @Test("★ the week spanning spring-forward still schedules every night")
    func acrossSpringForward() {
        let policy = PredicateTests.schoolNights(
            days: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"])
        let result = DeadfallSchedule.entries(
            policy: policy, now: PredicateTests.ny("2026-03-05 12:00"), systemZone: Self.ny)
        let nights = Set(result.filter { $0.hour == 21 && $0.minute == 30 }.map(\.weekday))
        #expect(nights.count == 7)
    }

    /// The horizon runs 8 days, one more than a weekly cycle, so a boundary
    /// that has already passed today is re-supplied by next week's. Rebuilding
    /// the plist at 23:00 therefore never loses a night — which is what makes
    /// "rewritten by the sync daemon whenever the schedule changes" safe to do
    /// at any hour.
    @Test("★ rebuilding after tonight's boundary still schedules that weekday")
    func horizonOutlastsAWeek() {
        let policy = PredicateTests.schoolNights(days: ["mon"])
        let before = DeadfallSchedule.entries(
            policy: policy, now: PredicateTests.ny("2026-09-21 12:00"), systemZone: Self.ny)
        let after = DeadfallSchedule.entries(
            policy: policy, now: PredicateTests.ny("2026-09-21 23:00"), systemZone: Self.ny)
        #expect(after == before)
        #expect(after.contains { $0.weekday == 2 && $0.hour == 21 && $0.minute == 30 })
    }

    // MARK: - The plist

    @Test("the plist carries every entry and does not run at load")
    func plistShape() {
        let policy = PredicateTests.schoolNights(days: ["mon"])
        let result = Self.entries(policy)
        let xml = DeadfallSchedule.plist(entries: result, programPath: "/usr/local/libexec/hpc-deadfall")

        #expect(xml.contains("<key>Label</key><string>com.hpc.deadfall</string>"))
        #expect(xml.contains("/usr/local/libexec/hpc-deadfall"))
        // ⚠️ RunAtLoad true would evaluate — and possibly lock — at 14:00 on a
        // Tuesday merely because a parent moved bedtime by five minutes.
        #expect(xml.contains("<key>RunAtLoad</key><false/>"))
        #expect(xml.components(separatedBy: "<key>Weekday</key>").count - 1 == result.count)
    }

    @Test("the generated plist actually parses as a property list")
    func plistParses() throws {
        let policy = PredicateTests.schoolNights()
        let xml = DeadfallSchedule.plist(
            entries: Self.entries(policy), programPath: "/usr/local/libexec/hpc-deadfall")
        let parsed = try PropertyListSerialization.propertyList(
            from: Data(xml.utf8), format: nil) as? [String: Any]
        #expect(parsed?["Label"] as? String == "com.hpc.deadfall")
        #expect((parsed?["StartCalendarInterval"] as? [[String: Any]])?.isEmpty == false)
    }
}

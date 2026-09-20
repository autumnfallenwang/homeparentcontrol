import Foundation
import Testing

@testable import HPCCore

/// The bedtime predicate. Every test here answers the standing Invariant E
/// question: *can this path result in the Mac staying usable past bedtime?*
struct PredicateTests {

    // MARK: - Fixtures

    /// School nights 21:30 → 07:00, New York, with the four standard warnings.
    static func schoolNights(
        timezone: String = "America/New_York",
        from: String = "21:30",
        until: String = "07:00",
        days: [String] = ["sun", "mon", "tue", "wed", "thu"],
        action: String = "lock",
        overrides: String = "[]"
    ) -> PolicyDocument {
        let json = """
            {
              "policy_version": 1,
              "issued_at": "2026-09-20T12:00:00.000Z",
              "not_before": "2026-09-20T12:00:00.000Z",
              "device_id": "018f2a4c-7b31-7c9e-9d2a-3f5b7c1e4a60",
              "subject": { "child_id": "018f2a4b-6a20-7b8d-8c1f-2e4a6b8d0f31",
                           "display_name": "Lucy" },
              "timezone": "\(timezone)",
              "confirm_immediate_effect": false,
              "schedule": { "kind": "windows", "windows": [{
                  "id": "018f2a4b-7c31-7d9e-9a2b-3c5d7e9f1a42",
                  "label": "School nights",
                  "days": [\(days.map { "\"\($0)\"" }.joined(separator: ","))],
                  "restricted_from": "\(from)",
                  "restricted_until": "\(until)",
                  "action": "\(action)",
                  "action_options": { "shutdown_grace_s": 300, "escalate_after_failures": 3 },
                  "warnings": [
                    { "lead_minutes": 30, "channel": "banner" },
                    { "lead_minutes": 15, "channel": "banner" },
                    { "lead_minutes": 5,  "channel": "modal"  },
                    { "lead_minutes": 1,  "channel": "modal"  }
                  ]
              }]},
              "overrides": \(overrides)
            }
            """
        return try! PolicyDocument.decode(from: Data(json.utf8))
    }

    /// An instant from a New York wall-clock reading.
    static func ny(_ text: String) -> Date {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd HH:mm"
        f.timeZone = TimeZone(identifier: "America/New_York")
        return f.date(from: text)!
    }

    // MARK: - The predicate itself

    @Test("outside the window on a school night evening")
    func outsideBefore() {
        let e = Predicate.evaluate(policy: Self.schoolNights(), now: Self.ny("2026-09-21 20:00"))
        #expect(!e.isRestricted)
    }

    @Test("restricted the moment the window opens")
    func atBoundary() {
        // Half-open [from, until) — 21:30 itself is inside.
        let e = Predicate.evaluate(policy: Self.schoolNights(), now: Self.ny("2026-09-21 21:30"))
        #expect(e.isRestricted)
    }

    @Test("restricted one minute before it opens? No.")
    func justBefore() {
        let e = Predicate.evaluate(policy: Self.schoolNights(), now: Self.ny("2026-09-21 21:29"))
        #expect(!e.isRestricted)
    }

    /// ★ The midnight crossing. A window 21:30 → 07:00 is still restricting at
    /// 02:00, and 02:00 belongs to YESTERDAY's window. Evaluating only today
    /// is the off-by-one-night bug.
    @Test("still restricted after midnight, from the previous day's window")
    func acrossMidnight() {
        let e = Predicate.evaluate(policy: Self.schoolNights(), now: Self.ny("2026-09-22 02:00"))
        #expect(e.isRestricted)
    }

    @Test("released exactly at the end of the window")
    func atEnd() {
        // 07:00 is the exclusive end — she can log in.
        let e = Predicate.evaluate(policy: Self.schoolNights(), now: Self.ny("2026-09-22 07:00"))
        #expect(!e.isRestricted)
    }

    @Test("restricted one minute before the end")
    func justBeforeEnd() {
        let e = Predicate.evaluate(policy: Self.schoolNights(), now: Self.ny("2026-09-22 06:59"))
        #expect(e.isRestricted)
    }

    @Test("a Friday night is free when Friday is not in the window's days")
    func notToday() {
        // Friday 2026-09-25 at 22:00 — the window runs sun..thu.
        let e = Predicate.evaluate(policy: Self.schoolNights(), now: Self.ny("2026-09-25 22:00"))
        #expect(!e.isRestricted)
    }

    /// ⚠️ But Friday MORNING is still restricted, by Thursday night's window.
    @Test("Friday morning is still Thursday's window")
    func fridayMorning() {
        let e = Predicate.evaluate(policy: Self.schoolNights(), now: Self.ny("2026-09-25 02:00"))
        #expect(e.isRestricted)
    }

    @Test("a non-wrapping window behaves normally")
    func nonWrapping() {
        let policy = Self.schoolNights(from: "13:00", until: "15:00", days: ["mon"])
        #expect(Predicate.evaluate(policy: policy, now: Self.ny("2026-09-21 14:00")).isRestricted)
        #expect(!Predicate.evaluate(policy: policy, now: Self.ny("2026-09-21 12:00")).isRestricted)
        #expect(!Predicate.evaluate(policy: policy, now: Self.ny("2026-09-21 16:00")).isRestricted)
    }

    // MARK: - A.30, the timezone

    /// ⚠️ The POLICY's zone decides, never the machine's. A child who changes
    /// the Mac's timezone must not move her own bedtime.
    @Test("the policy timezone decides, not the host's")
    func policyZoneWins() {
        let taipei = Self.schoolNights(timezone: "Asia/Taipei")
        // 2026-09-21T14:00Z is 22:00 in Taipei (restricted) and 10:00 in NY.
        let at = ISO8601DateFormatter().date(from: "2026-09-21T14:00:00Z")!
        #expect(Predicate.evaluate(policy: taipei, now: at).isRestricted)
        #expect(!Predicate.evaluate(policy: Self.schoolNights(), now: at).isRestricted)
    }

    /// A typo'd zone must not silently become UTC and shift bedtime by hours.
    @Test("an unknown timezone yields no restriction, loudly upstream")
    func unknownZone() {
        let e = Predicate.evaluate(
            policy: Self.schoolNights(timezone: "Mars/Olympus"), now: Self.ny("2026-09-21 22:00"))
        #expect(!e.isRestricted)
        #expect(e.restrictedUntil == nil)
    }

    // MARK: - DST, which §3.2 calls "the entire DST answer"

    /// Spring forward: 2026-03-08, 02:00 EST → 03:00 EDT. A window that opens
    /// 21:30 the night before must still close at 07:00, an hour shorter.
    @Test("spring forward: the window still opens and still closes")
    func springForward() {
        let policy = Self.schoolNights(days: ["sat", "sun"])
        #expect(Predicate.evaluate(policy: policy, now: Self.ny("2026-03-07 23:00")).isRestricted)
        // 04:00 EDT on transition night is inside the window.
        #expect(Predicate.evaluate(policy: policy, now: Self.ny("2026-03-08 04:00")).isRestricted)
        #expect(!Predicate.evaluate(policy: policy, now: Self.ny("2026-03-08 08:00")).isRestricted)
    }

    /// Fall back: 2026-11-01, 02:00 EDT → 01:00 EST. The 01:00 hour happens
    /// twice; a cron would fire twice, a predicate simply keeps answering.
    @Test("fall back: the repeated hour is still restricted, once")
    func fallBack() {
        let policy = Self.schoolNights(days: ["sat", "sun"])
        #expect(Predicate.evaluate(policy: policy, now: Self.ny("2026-10-31 23:00")).isRestricted)
        #expect(Predicate.evaluate(policy: policy, now: Self.ny("2026-11-01 01:30")).isRestricted)
        #expect(!Predicate.evaluate(policy: policy, now: Self.ny("2026-11-01 08:00")).isRestricted)
    }

    /// ★ A window whose START falls in the skipped hour. 02:30 does not exist
    /// on 2026-03-08; it must snap FORWARD, so restriction begins, not never.
    @Test("a window starting inside the spring-forward gap still starts")
    func startInsideGap() {
        let policy = Self.schoolNights(from: "02:30", until: "08:00", days: ["sun"])
        // Any time after the gap on that morning is inside the window.
        #expect(Predicate.evaluate(policy: policy, now: Self.ny("2026-03-08 05:00")).isRestricted)
    }

    // MARK: - Overrides, and the Invariant E questions they raise

    @Test("a live extend pushes the start later")
    func extendGrant() {
        let json = """
            [{"id":"018f2a4d-1122-7a3b-8c4d-5e6f7a8b9c0d","type":"extend",
              "window_id":"018f2a4b-7c31-7d9e-9a2b-3c5d7e9f1a42","minutes":30,
              "effective_date":"2026-09-21","expires_at":"2026-09-22T12:00:00.000Z",
              "granted_via":"ui"}]
            """
        let policy = Self.schoolNights(overrides: json)
        // 21:45 would normally be restricted; +30 min moves the start to 22:00.
        #expect(!Predicate.evaluate(policy: policy, now: Self.ny("2026-09-21 21:45")).isRestricted)
        #expect(Predicate.evaluate(policy: policy, now: Self.ny("2026-09-21 22:05")).isRestricted)
    }

    /// ★ A.8 — the load-bearing constraint. An expired grant relaxes NOTHING,
    /// and the agent checks that itself every tick, not only the server at
    /// compile time. This is what makes a cached policy safe to keep enforcing
    /// indefinitely.
    @Test("an EXPIRED extend relaxes nothing")
    func expiredGrant() {
        let json = """
            [{"id":"018f2a4d-1122-7a3b-8c4d-5e6f7a8b9c0d","type":"extend",
              "window_id":"018f2a4b-7c31-7d9e-9a2b-3c5d7e9f1a42","minutes":180,
              "effective_date":"2026-09-21","expires_at":"2026-09-21T00:00:00.000Z",
              "granted_via":"ui"}]
            """
        let policy = Self.schoolNights(overrides: json)
        #expect(Predicate.evaluate(policy: policy, now: Self.ny("2026-09-21 21:45")).isRestricted)
    }

    @Test("a grant for another day relaxes nothing")
    func wrongDayGrant() {
        let json = """
            [{"id":"018f2a4d-1122-7a3b-8c4d-5e6f7a8b9c0d","type":"extend",
              "window_id":"018f2a4b-7c31-7d9e-9a2b-3c5d7e9f1a42","minutes":180,
              "effective_date":"2026-09-19","expires_at":"2026-12-31T00:00:00.000Z",
              "granted_via":"ui"}]
            """
        let policy = Self.schoolNights(overrides: json)
        #expect(Predicate.evaluate(policy: policy, now: Self.ny("2026-09-21 21:45")).isRestricted)
    }

    @Test("a grant for another window relaxes nothing")
    func wrongWindowGrant() {
        let json = """
            [{"id":"018f2a4d-1122-7a3b-8c4d-5e6f7a8b9c0d","type":"extend",
              "window_id":"00000000-0000-4000-8000-000000000000","minutes":180,
              "effective_date":"2026-09-21","expires_at":"2026-12-31T00:00:00.000Z",
              "granted_via":"ui"}]
            """
        let policy = Self.schoolNights(overrides: json)
        #expect(Predicate.evaluate(policy: policy, now: Self.ny("2026-09-21 21:45")).isRestricted)
    }

    /// ★ Invariant E, in the one place a payload could carry a bypass. An
    /// unknown override type must relax NOTHING — a server one version ahead,
    /// or a tampered cache, must not be able to invent a way out.
    @Test("an UNKNOWN override type relaxes nothing")
    func unknownOverrideType() {
        let json = """
            [{"id":"018f2a4d-1122-7a3b-8c4d-5e6f7a8b9c0d","type":"disable_enforcement",
              "window_id":null,"minutes":600,
              "effective_date":"2026-09-21","expires_at":"2026-12-31T00:00:00.000Z",
              "granted_via":"ui"}]
            """
        let policy = Self.schoolNights(overrides: json)
        #expect(Predicate.evaluate(policy: policy, now: Self.ny("2026-09-21 22:00")).isRestricted)
    }

    /// `grant_minutes` needs elapsed accounting that D.4 defers, so it must
    /// not be honoured as if it were an extend.
    @Test("grant_minutes relaxes nothing until budgets exist")
    func grantMinutes() {
        let json = """
            [{"id":"018f2a4d-1122-7a3b-8c4d-5e6f7a8b9c0d","type":"grant_minutes",
              "window_id":null,"minutes":600,
              "effective_date":"2026-09-21","expires_at":"2026-12-31T00:00:00.000Z",
              "granted_via":"ui"}]
            """
        let policy = Self.schoolNights(overrides: json)
        #expect(Predicate.evaluate(policy: policy, now: Self.ny("2026-09-21 22:00")).isRestricted)
    }

    @Test("a live suspend means no bedtime tonight")
    func suspendGrant() {
        let json = """
            [{"id":"018f2a4d-1122-7a3b-8c4d-5e6f7a8b9c0d","type":"suspend",
              "window_id":null,"minutes":null,
              "effective_date":"2026-09-21","expires_at":"2026-09-22T12:00:00.000Z",
              "granted_via":"ui"}]
            """
        let policy = Self.schoolNights(overrides: json)
        #expect(!Predicate.evaluate(policy: policy, now: Self.ny("2026-09-21 22:00")).isRestricted)
    }

    // MARK: - Warnings, computed in absolute time

    /// ⚠️ "Resolve the boundary to an instant FIRST, then subtract minutes in
    /// UTC. Doing `21:30 − 15` as strings and resolving afterwards is the bug
    /// that fires a warning an hour early on transition night."
    @Test("the 30-minute warning is due at 21:00, not before")
    func warningTiming() {
        let policy = Self.schoolNights()
        let early = Predicate.evaluate(policy: policy, now: Self.ny("2026-09-21 20:55"))
        #expect(early.dueWarnings.isEmpty)

        let due = Predicate.evaluate(policy: policy, now: Self.ny("2026-09-21 21:05"))
        #expect(due.dueWarnings.contains { $0.leadMinutes == 30 })
    }

    @Test("closer to the boundary, more warnings are due, most urgent first")
    func warningOrder() {
        let e = Predicate.evaluate(policy: Self.schoolNights(), now: Self.ny("2026-09-21 21:29"))
        #expect(e.dueWarnings.first?.leadMinutes == 1)
        #expect(e.dueWarnings.count == 4)
    }

    @Test("no warnings are due once the boundary has passed")
    func noWarningsInside() {
        let e = Predicate.evaluate(policy: Self.schoolNights(), now: Self.ny("2026-09-21 21:31"))
        #expect(e.dueWarnings.isEmpty)
        #expect(e.isRestricted)
    }

    @Test("the next boundary is reported for the adaptive poll")
    func nextBoundary() {
        let e = Predicate.evaluate(policy: Self.schoolNights(), now: Self.ny("2026-09-21 19:00"))
        // The soonest boundary is the 30-minute warning at 21:00.
        #expect(e.nextBoundaryAt == Self.ny("2026-09-21 21:00"))
    }

    // MARK: - Empty and degenerate policies

    /// §4.6 class B — no rules means do not lock, and say so loudly. That is
    /// fail-open on IGNORANCE, which is the one place it is correct.
    @Test("a policy with no windows never restricts")
    func noWindows() {
        let json = """
            {"policy_version":1,"issued_at":"2026-09-20T12:00:00.000Z",
             "device_id":"018f2a4c-7b31-7c9e-9d2a-3f5b7c1e4a60",
             "subject":{"child_id":"018f2a4b-6a20-7b8d-8c1f-2e4a6b8d0f31","display_name":"L"},
             "timezone":"America/New_York","schedule":{"kind":"windows","windows":[]},
             "overrides":[]}
            """
        let policy = try! PolicyDocument.decode(from: Data(json.utf8))
        #expect(!Predicate.evaluate(policy: policy, now: Self.ny("2026-09-21 23:00")).isRestricted)
    }

    /// ⚠️ R5 degrades DOWNWARD-SAFE: an unrecognised action becomes `lock`,
    /// never `warn_only`. Degrading to warn_only would make any unknown value
    /// a bypass.
    @Test("an unknown action degrades to lock, not to warn_only")
    func unknownActionDegrades() {
        let policy = Self.schoolNights(action: "please_do_nothing")
        #expect(policy.schedule.windows[0].action == "lock")
    }

    /// ⚠️ X12 — a grace of zero silently reconstitutes bare shutdown.
    @Test("shutdown_grace_s is clamped to at least 60 on the agent too")
    func graceClamped() {
        let json = """
            {"shutdown_grace_s": 0, "escalate_after_failures": 3}
            """
        let opts = try! JSONDecoder().decode(
            PolicyDocument.ActionOptions.self, from: Data(json.utf8))
        #expect(opts.shutdownGraceS == 60)
    }
}

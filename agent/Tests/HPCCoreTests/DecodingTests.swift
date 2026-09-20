import Foundation
import Testing

@testable import HPCCore

/// ★ Where tolerance is allowed to point.
///
/// R1 asks for a tolerant reader, and every instinct while writing one is to
/// reach for `(try? decode) ?? default`. On this codebase that instinct is a
/// loaded gun: half these fields default toward LESS enforcement, and a
/// default that leaves the Mac usable past bedtime is lever #7 whether it
/// arrives by malice or by a typo in a JSON file.
///
/// The rule these tests pin: **tolerate what you do not understand; never
/// default toward less enforcement.**
struct DecodingTests {

    static func document(schedule: String, overrides: String = "[]") -> String {
        """
        {"policy_version":1,"issued_at":"2026-09-20T12:00:00.000Z",
         "device_id":"018f2a4c-7b31-7c9e-9d2a-3f5b7c1e4a60",
         "subject":{"child_id":"018f2a4b-6a20-7b8d-8c1f-2e4a6b8d0f31","display_name":"L"},
         "timezone":"America/New_York","schedule":\(schedule),"overrides":\(overrides)}
        """
    }

    static let goodWindow = """
        {"id":"w1","label":"School nights","days":["mon"],
         "restricted_from":"21:30","restricted_until":"07:00","action":"lock",
         "action_options":{"shutdown_grace_s":300,"escalate_after_failures":3},
         "warnings":[]}
        """

    // MARK: - Strict where it matters

    /// ⚠️ THE REGRESSION GUARD. An earlier draft decoded `days` with
    /// `(try? …) ?? []`, so a malformed days list became a window matching no
    /// day — a policy that parses cleanly and enforces nothing. Found only
    /// because a broken test fixture produced exactly that JSON.
    @Test("a malformed `days` FAILS the document; it must not become an empty list")
    func malformedDaysThrows() {
        let bad = """
            {"kind":"windows","windows":[{"id":"w1","days":"monday",
             "restricted_from":"21:30","restricted_until":"07:00"}]}
            """
        #expect(throws: (any Error).self) {
            try PolicyDocument.decode(from: Data(Self.document(schedule: bad).utf8))
        }
    }

    @Test("a missing `days` FAILS the document")
    func missingDaysThrows() {
        let bad = """
            {"kind":"windows","windows":[{"id":"w1",
             "restricted_from":"21:30","restricted_until":"07:00"}]}
            """
        #expect(throws: (any Error).self) {
            try PolicyDocument.decode(from: Data(Self.document(schedule: bad).utf8))
        }
    }

    @Test("a malformed `windows` FAILS the document; it must not become no windows")
    func malformedWindowsThrows() {
        #expect(throws: (any Error).self) {
            try PolicyDocument.decode(
                from: Data(Self.document(schedule: #"{"kind":"windows","windows":"none"}"#).utf8))
        }
    }

    @Test("a missing boundary time FAILS the document")
    func missingBoundaryThrows() {
        let bad = """
            {"kind":"windows","windows":[{"id":"w1","days":["mon"],"restricted_from":"21:30"}]}
            """
        #expect(throws: (any Error).self) {
            try PolicyDocument.decode(from: Data(Self.document(schedule: bad).utf8))
        }
    }

    // MARK: - Tolerant where it is safe

    /// An absent schedule is a genuine state (a child with no rules yet), and
    /// it errs toward no enforcement — but visibly, not by swallowing an error.
    @Test("an ABSENT schedule is fine; an unparseable one is not")
    func absentScheduleIsFine() throws {
        let json = """
            {"policy_version":1,"issued_at":"2026-09-20T12:00:00.000Z",
             "device_id":"018f2a4c-7b31-7c9e-9d2a-3f5b7c1e4a60",
             "subject":{"child_id":"c","display_name":"L"},
             "timezone":"America/New_York","overrides":[]}
            """
        let doc = try PolicyDocument.decode(from: Data(json.utf8))
        #expect(doc.schedule.windows.isEmpty)
    }

    /// ⚠️ Overrides are the SAFE direction: dropping a relaxation means more
    /// enforcement, so tolerance is correct here and only here.
    @Test("a malformed override is dropped, not fatal — it errs toward enforcement")
    func malformedOverrideIsDropped() throws {
        let doc = try PolicyDocument.decode(
            from: Data(
                Self.document(
                    schedule: #"{"kind":"windows","windows":[\#(Self.goodWindow)]}"#,
                    overrides: #"[{"id":"o1","type":"extend","minutes":"lots"}]"#
                ).utf8))
        #expect(doc.overrides.isEmpty)
        #expect(doc.schedule.windows.count == 1)
    }

    @Test("an unknown top-level field is ignored — R1")
    func unknownFieldIgnored() throws {
        let json = """
            {"policy_version":1,"issued_at":"2026-09-20T12:00:00.000Z",
             "device_id":"018f2a4c-7b31-7c9e-9d2a-3f5b7c1e4a60",
             "subject":{"child_id":"c","display_name":"L"},
             "timezone":"America/New_York","overrides":[],
             "some_future_field":{"we":"do not know this"},
             "schedule":{"kind":"windows","windows":[\(Self.goodWindow)]}}
            """
        let doc = try PolicyDocument.decode(from: Data(json.utf8))
        #expect(doc.schedule.windows.count == 1)
    }

    /// ⚠️ X11 removed `fail_mode` and X1c forbids `staleness.max_age`. If a
    /// payload carries either, it must be IGNORED — not honoured as a way out.
    @Test("fail_mode and staleness.max_age in a payload are ignored, not honoured")
    func removedFieldsIgnored() throws {
        let json = """
            {"policy_version":1,"issued_at":"2026-09-20T12:00:00.000Z",
             "device_id":"018f2a4c-7b31-7c9e-9d2a-3f5b7c1e4a60",
             "subject":{"child_id":"c","display_name":"L"},
             "timezone":"America/New_York","overrides":[],
             "fail_mode":"open","staleness":{"max_age_s":1,"behaviour_after_max_age":"stop"},
             "schedule":{"kind":"windows","windows":[\(Self.goodWindow)]}}
            """
        let doc = try PolicyDocument.decode(from: Data(json.utf8))
        // It parses, the window survives, and nothing in the decoded type can
        // express "stop enforcing".
        #expect(doc.schedule.windows.count == 1)
    }

    // MARK: - Both RFC 3339 spellings

    @Test("instants parse with and without fractional seconds")
    func bothInstantSpellings() throws {
        for stamp in ["2026-09-20T12:00:00.000Z", "2026-09-20T12:00:00Z"] {
            let json = """
                {"policy_version":1,"issued_at":"\(stamp)",
                 "device_id":"018f2a4c-7b31-7c9e-9d2a-3f5b7c1e4a60",
                 "subject":{"child_id":"c","display_name":"L"},
                 "timezone":"America/New_York","overrides":[],
                 "schedule":{"kind":"windows","windows":[]}}
                """
            let doc = try PolicyDocument.decode(from: Data(json.utf8))
            #expect(doc.policyVersion == 1)
        }
    }
}

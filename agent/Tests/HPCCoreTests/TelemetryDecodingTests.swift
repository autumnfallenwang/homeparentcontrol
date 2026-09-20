import Foundation
import Testing

@testable import HPCCore

/// The one field in `PolicyDocument` whose tolerance runs toward *more* data
/// rather than more enforcement, and why that is not an inconsistency.
struct TelemetryDecodingTests {

    static func policy(telemetry: String?) -> PolicyDocument {
        let block = telemetry.map { ",\n  \"telemetry\": \($0)" } ?? ""
        let json = """
            {
              "policy_version": 1,
              "issued_at": "2026-09-20T12:00:00.000Z",
              "device_id": "018f2a4c-7b31-7c9e-9d2a-3f5b7c1e4a60",
              "subject": { "child_id": "018f2a4b-6a20-7b8d-8c1f-2e4a6b8d0f31",
                           "display_name": "Lucy" },
              "timezone": "America/New_York",
              "schedule": { "kind": "windows", "windows": [] },
              "overrides": []\(block)
            }
            """
        return try! PolicyDocument.decode(from: Data(json.utf8))
    }

    // MARK: - ★ Absence means collect

    /// ★ The projector, `usage_hourly`, `usage_daily` and every report page
    /// read `app.usage_sample` and `session.state`. A missing block that
    /// defaulted to "collect nothing" would starve all of them, and the
    /// symptom is a report that renders perfectly with no data in it — which
    /// reads as "a quiet week", not as a bug.
    @Test("★ a policy with no telemetry block collects everything")
    func absentBlockCollects() {
        let telemetry = Self.policy(telemetry: nil).telemetry
        #expect(telemetry.enabled)
        #expect(telemetry.collects("app.usage_sample"))
        #expect(telemetry.collects("session.state"))
        #expect(telemetry.collects("enforcement.action_taken"))
    }

    @Test("★ an unreadable telemetry block collects everything too")
    func garbageBlockCollects() {
        #expect(Self.policy(telemetry: "\"not an object\"").telemetry.collects("app.usage_sample"))
        #expect(Self.policy(telemetry: "[]").telemetry.collects("session.state"))
    }

    /// ★ An EMPTY list is not an opt-out. §4.3 gives `collect` only as a
    /// populated example and never says what an empty one means.
    @Test("★ an empty collect list means everything, not nothing")
    func emptyCollectMeansEverything() {
        let telemetry = Self.policy(telemetry: "{\"collect\": []}").telemetry
        #expect(telemetry.collects("app.usage_sample"))
    }

    /// ★ But an explicit `false` is a parent's decision, not an absence.
    @Test("★ enabled:false is honoured exactly")
    func disabledIsHonoured() {
        let telemetry = Self.policy(telemetry: "{\"enabled\": false}").telemetry
        #expect(!telemetry.enabled)
        #expect(!telemetry.collects("app.usage_sample"))
        #expect(!telemetry.collects("enforcement.action_taken"))
    }

    // MARK: - Patterns

    @Test("a wildcard suffix matches a whole family")
    func wildcardSuffix() {
        let telemetry = Self.policy(
            telemetry: "{\"collect\": [\"enforcement.*\", \"power.*\"]}").telemetry
        #expect(telemetry.collects("enforcement.action_taken"))
        #expect(telemetry.collects("power.sleep"))
        #expect(!telemetry.collects("app.usage_sample"))
    }

    @Test("an exact name matches only itself")
    func exactMatch() {
        let telemetry = Self.policy(telemetry: "{\"collect\": [\"session.state\"]}").telemetry
        #expect(telemetry.collects("session.state"))
        #expect(!telemetry.collects("session.stateful"))
    }

    @Test("a bare star matches everything")
    func bareStar() {
        #expect(Self.policy(telemetry: "{\"collect\": [\"*\"]}").telemetry.collects("anything"))
    }

    // MARK: - ★ The caps reach the device

    /// ★ Until the block was decoded these were build constants, so a parent
    /// lowering `max_queue_events` changed a row in Postgres and nothing at
    /// all on the Mac — a control that looks like a control.
    @Test("★ the queue caps come from the policy, not from the build")
    func capsAreRead() {
        let telemetry = Self.policy(
            telemetry: """
                {"max_queue_events": 1234, "max_queue_bytes": 5678,
                 "max_queue_age_days": 3, "audit_retention_days": 30}
                """).telemetry
        #expect(telemetry.maxQueueEvents == 1234)
        #expect(telemetry.maxQueueBytes == 5678)
        #expect(telemetry.maxQueueAgeDays == 3)
        #expect(telemetry.auditRetentionDays == 30)
    }

    @Test("a partially-specified block keeps the defaults for the rest")
    func partialBlock() {
        let telemetry = Self.policy(telemetry: "{\"max_queue_events\": 10}").telemetry
        #expect(telemetry.maxQueueEvents == 10)
        #expect(telemetry.maxQueueBytes == PolicyDocument.Telemetry.fallback.maxQueueBytes)
        #expect(telemetry.sampleIntervalS == 60)
    }

    /// ⚠️ §5.7's retention invariant is the SERVER's to keep, but the agent's
    /// own two ladders have to stay in the same order or a long outage sheds
    /// enforcement records before usage detail.
    @Test("audit retention outlives queue age in the defaults")
    func auditOutlivesSamples() {
        let telemetry = PolicyDocument.Telemetry.fallback
        #expect(telemetry.auditRetentionDays > telemetry.maxQueueAgeDays)
    }

    /// The whole point of adding this: decoding it must not have made a
    /// policy that previously parsed stop parsing.
    @Test("★ adding the block did not make any existing policy fail to decode")
    func stillTolerant() {
        #expect(Self.policy(telemetry: nil).policyVersion == 1)
        #expect(Self.policy(telemetry: "{\"enabled\": \"yes please\"}").telemetry.enabled)
    }
}

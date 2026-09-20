import Foundation
import Testing

@testable import HPCSyncKit

/// §4.7's `hpc_action` vocabulary, and the one member of it that can leave a
/// Mac usable past bedtime.
struct ClientTests {

    static func interpret(
        _ status: Int, action: String?, retryAfter: String? = nil, allowDecommission: Bool
    ) -> Client.Problem {
        var body: [String: Any] = ["title": "nope"]
        if let action { body["hpc_action"] = action }
        return Client.interpret(
            status: status, body: body, retryAfter: retryAfter,
            allowDecommission: allowDecommission)
    }

    // MARK: - ★ Only /sync may decommission

    /// ★ A.7: `decommission` is "the one exception" to the rule that the wire
    /// protocol has no stop-enforcing verb. It must therefore be reachable
    /// from exactly one authenticated endpoint and nowhere else.
    @Test("★ a 410 on /sync does decommission")
    func syncMayDecommission() {
        let problem = Self.interpret(410, action: "decommission", allowDecommission: true)
        #expect(problem.action == .decommission)
    }

    /// ★ §5.5 returns 410 from `/enroll` for an already-consumed code, and
    /// `/enroll` is unauthenticated. Under §4.7's global table that is a
    /// `decommission` — an uninstall triggered by anyone able to answer a
    /// plain-HTTP request (X4).
    @Test("★ a 410 anywhere else is downgraded to halt_sync_keep_enforcing")
    func enrolMayNotDecommission() {
        let problem = Self.interpret(410, action: "decommission", allowDecommission: false)
        #expect(problem.action == .haltSyncKeepEnforcing)
        #expect(problem.action != .decommission)
    }

    @Test("★ a 410 on /events cannot decommission either")
    func eventsMayNotDecommission() {
        // `/events` deliberately accepts from a decommissioned device, so a
        // 410 here would be a routing mistake, not an instruction.
        #expect(
            Self.interpret(410, action: "decommission", allowDecommission: false).action
                == .haltSyncKeepEnforcing)
    }

    // MARK: - The rest of the vocabulary

    @Test("every hpc_action the contract defines parses")
    func vocabularyParses() {
        let all = [
            "drop_batch", "halt_sync_keep_enforcing", "reenroll", "decommission",
            "halve_batch", "backoff",
        ]
        for raw in all {
            #expect(
                Client.Action(rawValue: raw) != nil,
                Comment(rawValue: "`\(raw)` is in the contract but not in the agent"))
        }
    }

    @Test("an hpc_action this build does not know is nil, not a crash")
    func unknownActionIsNil() {
        #expect(Self.interpret(418, action: "self_destruct", allowDecommission: true).action == nil)
    }

    @Test("a problem with no hpc_action at all is still a problem")
    func missingAction() {
        let problem = Self.interpret(500, action: nil, allowDecommission: true)
        #expect(problem.action == nil)
        #expect(problem.status == 500)
    }

    @Test("Retry-After is carried through to the cadence")
    func retryAfterParsed() {
        #expect(Self.interpret(429, action: "backoff", retryAfter: "30",
                               allowDecommission: true).retryAfterS == 30)
    }

    @Test("a non-numeric Retry-After is ignored rather than fatal")
    func retryAfterHttpDate() {
        // §4.7 does not say which of RFC 9110's two forms the server uses.
        // An unparseable one falls back to the exponent, which is correct.
        #expect(
            Self.interpret(
                429, action: "backoff", retryAfter: "Wed, 21 Oct 2026 07:28:00 GMT",
                allowDecommission: true
            ).retryAfterS == nil)
    }

    // MARK: - Timeouts

    /// ★ V5: "server accepts then hangs 120 s → locks at the boundary,
    /// **proving total sync timeout < one tick**". The enforcer's tick is 60 s.
    @Test("★ the total client timeout is under one enforcer tick")
    func timeoutUnderOneTick() {
        let config = Client.Config(baseURL: URL(string: "http://localhost")!)
        // The semaphore backstop is `resourceTimeout + 5`; that is the real
        // worst case a single request can occupy.
        #expect(config.resourceTimeout + 5 < 60)
        #expect(config.requestTimeout < config.resourceTimeout)
    }
}

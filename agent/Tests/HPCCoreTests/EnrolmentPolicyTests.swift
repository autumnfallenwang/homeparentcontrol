import Testing

@testable import HPCCore

/// The smoke test's hour-long household lockout, as a table.
struct EnrolmentPolicyTests {

    @Test(
        "a dead code is never retried — expired, used, unknown, malformed",
        arguments: [410, 409, 404, 400])
    func deadCodes(status: Int) {
        #expect(EnrolmentPolicy.classify(status: status) == .rejected)
    }

    @Test("429 waits, it does not give up — the code may be good")
    func rateLimited() {
        #expect(EnrolmentPolicy.classify(status: 429) == .rateLimited)
    }

    @Test(
        "no answer or a server fault keeps the code and backs off",
        arguments: [nil, 500, 502, 503] as [Int?])
    func transient(status: Int?) {
        #expect(EnrolmentPolicy.classify(status: status) == .transient)
    }
}

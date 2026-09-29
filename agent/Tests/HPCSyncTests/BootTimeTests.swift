import Foundation
import Testing

@testable import HPCAgentIO

/// `kern.boottime` is what `agent.started` now carries (ADR 0014).
struct BootTimeTests {

    @Test("★ the kernel boot time reads, and is never after now − uptime")
    func readsAndIsConsistent() throws {
        let boot = try #require(BootTime.kernel())
        // Uptime pauses in sleep, so now − uptime can only be LATER than the
        // real boot, never earlier. Two seconds of slack for the two reads.
        let fromUptime = Date(timeIntervalSinceNow: -ProcessInfo.processInfo.systemUptime)
        #expect(boot <= fromUptime.addingTimeInterval(2))
        #expect(boot > Date(timeIntervalSince1970: 1_577_836_800))  // after 2020
        #expect(boot < Date())
    }

    @Test("it travels as an ISO-8601 instant")
    func iso() throws {
        let text = try #require(BootTime.kernelISO())
        #expect(ISO8601DateFormatter().date(from: text) != nil)
    }
}

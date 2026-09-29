import Foundation
import Testing

@testable import HPCAgentIO

/// `kern.boottime` is what `agent.started` now carries (ADR 0014).
struct BootTimeTests {

    @Test("★ the kernel boot time reads, and is close to or before now − uptime")
    func readsAndIsConsistent() throws {
        let boot = try #require(BootTime.kernel())
        // Uptime pauses in sleep, so after a sleep now − uptime is LATER than
        // the boot. ⚠️ Without one it can be a few seconds EARLIER: uptime's
        // clock starts at power-on, before the kernel stamps `kern.boottime`
        // — 6 s on this Mac, right after the 28 Sep reboot, when a 2 s slack
        // failed. 60 s still catches a garbage reading.
        let fromUptime = Date(timeIntervalSinceNow: -ProcessInfo.processInfo.systemUptime)
        #expect(boot <= fromUptime.addingTimeInterval(60))
        #expect(boot > Date(timeIntervalSince1970: 1_577_836_800))  // after 2020
        #expect(boot < Date())
    }

    @Test("it travels as an ISO-8601 instant")
    func iso() throws {
        let text = try #require(BootTime.kernelISO())
        #expect(ISO8601DateFormatter().date(from: text) != nil)
    }
}

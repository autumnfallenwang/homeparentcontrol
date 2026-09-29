import Darwin
import Foundation

/// The kernel's own boot time — `kern.boottime` — which names the boot this
/// process is running in (ADR 0014).
///
/// ⚠️ **Not `Date() − ProcessInfo.systemUptime`.** Uptime pauses while the
/// Mac sleeps, so that value drifts forward by the length of every sleep —
/// observed on Ivy's Mac on 2026-09-28, whose "boot time" moved 15 minutes
/// after a 15-minute sleep. `kern.boottime` is set once, at boot; only a change
/// of the wall clock moves it.
///
/// ⚠️ And not the agent's `boot_id`: each daemon invents that per PROCESS.
public enum BootTime {
    public static func kernel() -> Date? {
        var mib: [Int32] = [CTL_KERN, KERN_BOOTTIME]
        var value = timeval()
        var size = MemoryLayout<timeval>.stride
        guard sysctl(&mib, 2, &value, &size, nil, 0) == 0, value.tv_sec > 0 else { return nil }
        return Date(timeIntervalSince1970: Double(value.tv_sec) + Double(value.tv_usec) / 1_000_000)
    }

    /// `kern.boottime` as the ISO-8601 instant `agent.started` carries.
    public static func kernelISO() -> String? {
        kernel().map { ISO8601DateFormatter().string(from: $0) }
    }
}

import Foundation
import HPCAgentIO
import HPCCore

/// Reading the machine, for `Sampler` to interpret.
///
/// Every source here was probed directly on this hardware before being
/// written down — [[verify-macos-claims]], and §4.1's table is marked "✅ all
/// probed directly, several from bash".
///
/// ⚠️ **Permission-free tier only.** App identity, CPU, HID idle, console
/// user, power. Anything richer needs a TCC grant, and TCC grants die on
/// every agent rebuild under ad-hoc signing (D.7) — so a sampler that needed
/// one would work until the first update and then silently stop.
///
/// ⚠️ **No AppKit.** 📄 Apple states daemons are not allowed to use
/// `NSWorkspace.willSleepNotification` and "should not even be LINKING
/// against AppKit". `lsappinfo` is the daemon-safe route to the frontmost
/// app, and sleep is inferred from the monotonic clock rather than observed.
public enum SampleSource {

    /// ⚠️ Short. These are subprocesses on a 60 s timer; a hung `lsappinfo`
    /// must cost one sample, not the sampler. Enforcement is in another
    /// process entirely and cannot be affected either way.
    public static let probeTimeout: TimeInterval = 5

    public static func observe(now: Date = Date()) -> Sampler.Observation {
        let uid = Effects.consoleUser()
        let idleS = hidIdleSeconds() ?? 0

        var bundleId: String?
        var cpu: Double?
        // ⚠️ Only ask about the frontmost app when somebody is actually at
        // the console. `lsappinfo` at the login window is a subprocess that
        // returns nothing, once a minute, for ever.
        if let uid {
            let front = frontmost(uid: uid)
            bundleId = front?.bundleId
            cpu = front?.pid.flatMap(cpuPercent(pid:))
        }

        return Sampler.Observation(
            at: now,
            uptime: ProcessInfo.processInfo.systemUptime,
            consoleUser: uid.map(String.init),
            screenLocked: screenIsLocked(uid: uid),
            frontmostBundleId: bundleId,
            frontmostCpuPct: cpu,
            idleS: idleS)
    }

    // MARK: - Frontmost app

    /// `lsappinfo front` → an ASN, then `lsappinfo info -only …` → the fields.
    ///
    /// ⚠️ Two calls, because `front` returns only an Application Serial
    /// Number (`ASN:0x0-0x36036:`). Probed on macOS 26.6.2: the second call
    /// returns `"CFBundleIdentifier"="com.microsoft.VSCode"`, quoted, which
    /// is why the parse below strips quotes rather than splitting on `=`
    /// alone.
    ///
    /// ⚠️ Run as the CONSOLE USER, not as root. `lsappinfo` talks to the
    /// per-session Launch Services server, and root's bootstrap namespace is
    /// not the user's. `Effects.asUser` (`launchctl asuser`) is the same
    /// mechanism the warning banners already use and that M2 verified works
    /// from a root daemon. **Verified for `osascript`, ASSUMED for
    /// `lsappinfo`** — V-SAMPLE-1 in `agent/scripts/v-series.md`.
    static func frontmost(uid: uid_t) -> (bundleId: String?, pid: Int32?)? {
        let asn = asUserOutput(uid, ["/usr/bin/lsappinfo", "front"])
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !asn.isEmpty else { return nil }

        let info = asUserOutput(
            uid, ["/usr/bin/lsappinfo", "info", "-only", "bundleid", "-only", "pid", asn])
        return (bundleId: value(named: "CFBundleIdentifier", in: info),
                pid: value(named: "pid", in: info).flatMap(Int32.init))
    }

    /// Pull `"key"="value"` or `"key"=123` out of `lsappinfo`'s output.
    static func value(named key: String, in text: String) -> String? {
        guard let range = text.range(of: "\"\(key)\"=") else { return nil }
        let rest = text[range.upperBound...]
        let raw = rest.prefix { $0 != "\n" && $0 != " " }
        let trimmed = raw.trimmingCharacters(in: CharacterSet(charactersIn: "\"") )
        return trimmed.isEmpty ? nil : trimmed
    }

    /// ★ `ps -o %cpu` on macOS is a DECAYING average, not a lifetime one.
    ///
    /// Probed 2026-09-20: the same pid, 39 hours old, read 0.9 then 0.2 three
    /// seconds apart. A lifetime average over 39 hours cannot move that far
    /// that fast. This matters because Linux's `ps %cpu` *is* a lifetime
    /// average, and under that reading the number would be useless for
    /// "PlayCap-style activity gating" — a long-running app would be pinned
    /// near its historical mean for ever.
    static func cpuPercent(pid: Int32) -> Double? {
        let output = run(["/bin/ps", "-p", String(pid), "-o", "%cpu="])
        return Double(output.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    // MARK: - Idle and lock

    /// `ioreg -c IOHIDSystem` → `HIDIdleTime`.
    ///
    /// ⚠️ **Nanoseconds.** Probed: `"HIDIdleTime" = 235161083` on a machine
    /// in active use — 0.235 s. Reading it as seconds would make every
    /// machine look idle for seven years and `active_s` would be zero for
    /// ever, which presents as "the child never used the Mac".
    static func hidIdleSeconds() -> Double? {
        let output = run(["/usr/sbin/ioreg", "-c", "IOHIDSystem"])
        guard let line = output.split(separator: "\n").first(where: {
            $0.contains("HIDIdleTime")
        }),
            let raw = line.split(separator: "=").last,
            let nanos = Double(raw.trimmingCharacters(in: .whitespaces))
        else { return nil }
        return nanos / 1_000_000_000
    }

    /// Is the screen locked?
    ///
    /// Re-executes this binary as the console user in `--session-probe` mode,
    /// because `CGSessionCopyCurrentDictionary()` reads the *calling
    /// process's* window-server session and a root daemon has none. See
    /// `SessionProbe` for the three routes that were probed and rejected.
    ///
    /// ⚠️ Unknown resolves to **not locked**, deliberately. Guessing wrong
    /// this way over-counts a usage report by one sample; guessing the other
    /// way silently erases real usage, which is far harder to notice — a
    /// report that is quietly 40 % low looks like a quiet week.
    static func screenIsLocked(uid: uid_t?) -> Bool {
        guard let uid else { return true }
        let output = asUserOutput(uid, [selfPath, SessionProbe.flag])
        return SessionProbe.parse(output) ?? false
    }

    /// This executable's own path, for the re-exec.
    static var selfPath: String {
        CommandLine.arguments.first.flatMap { argv0 in
            argv0.hasPrefix("/") ? argv0 : nil
        } ?? "\(Paths.libexec)/hpc-sync"
    }

    // MARK: - Plumbing

    /// Run a command in the console user's session.
    ///
    /// ⚠️ `launchctl asuser` needs root, and only root needs it. When the
    /// sampler is ALREADY running as the console user — which is how the
    /// whole path gets exercised without a LaunchDaemon — the hop is not
    /// just unnecessary, it fails with EPERM and silently returns nothing.
    /// Skipping it makes the code testable and strictly more robust; it
    /// cannot weaken anything, because a process already in the right
    /// session is the thing `asuser` is trying to produce.
    static func asUserOutput(_ uid: uid_t, _ argv: [String]) -> String {
        if getuid() == uid { return run(argv) }
        return run(["/bin/launchctl", "asuser", String(uid)] + argv)
    }

    /// A subprocess with a hard deadline. ⚠️ `Process.waitUntilExit` alone
    /// can block for ever; a sampler stuck on a hung `lsappinfo` would stop
    /// producing telemetry silently.
    static func run(_ argv: [String]) -> String {
        guard let first = argv.first else { return "" }
        let task = Process()
        task.executableURL = URL(fileURLWithPath: first)
        task.arguments = Array(argv.dropFirst())
        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = FileHandle.nullDevice
        guard (try? task.run()) != nil else { return "" }

        let deadline = Date().addingTimeInterval(probeTimeout)
        // Read first: a child that fills the pipe buffer blocks on write and
        // never exits, so waiting before reading deadlocks on exactly the
        // large outputs `ioreg` produces.
        let data = (try? pipe.fileHandleForReading.readToEnd()) ?? Data()
        while task.isRunning && Date() < deadline { usleep(20_000) }
        if task.isRunning { task.terminate() }
        return String(decoding: data, as: UTF8.self)
    }
}

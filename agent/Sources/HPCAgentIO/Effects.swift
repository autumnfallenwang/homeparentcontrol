import Foundation
import HPCCore

/// The things that actually touch the machine.
///
/// Everything here is deliberately thin: the decision was already taken by
/// `Ladder`, which is pure and tested. This file only carries it out.
public enum Effects {

    // MARK: - The session bridge

    /// The console user, or nil when nobody is logged in.
    ///
    /// ⚠️ `uid >= 501` excludes the login window and fast-user-switch's empty
    /// console. That case is a **no-op, not a skip** (X10): there is nobody
    /// using the Mac and nothing to warn — and it must never be confused with
    /// "the warning failed", which is how lever #6 got written.
    public static func consoleUser() -> uid_t? {
        var info = stat()
        guard stat("/dev/console", &info) == 0 else { return nil }
        return info.st_uid >= 501 ? info.st_uid : nil
    }

    /// Run a command as the console user.
    ///
    /// ⚖️ Fire-and-forget through `launchctl asuser`, rather than a
    /// long-lived LaunchAgent: **a LaunchAgent runs as the child and is
    /// unloadable by her; the root daemon is not.**
    @discardableResult
    public static func asUser(_ uid: uid_t, _ argv: [String], timeout: TimeInterval = 20) -> Int32 {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        task.arguments = ["asuser", String(uid)] + argv
        task.standardOutput = FileHandle.nullDevice
        task.standardError = FileHandle.nullDevice
        do { try task.run() } catch { return -1 }

        // ⚠️ Bounded. A notifier that hangs must not hang the tick — the tick
        // is the heartbeat, and a stuck warning would make a live agent look
        // silent.
        let deadline = Date().addingTimeInterval(timeout)
        while task.isRunning && Date() < deadline {
            usleep(100_000)
        }
        if task.isRunning {
            task.terminate()
            return -2
        }
        return task.terminationStatus
    }

    // MARK: - Warnings (§3.3)

    /// Both surfaces are observed working on this build, including from a root
    /// daemon. Returns the outcome the ladder needs — and the three cases stay
    /// distinct all the way up.
    public static func warn(leadMinutes: Int, channel: String, displayName: String)
        -> Ladder.WarningOutcome
    {
        guard let uid = consoleUser() else { return .noConsoleUser }

        let message = leadMinutes == 1
            ? "Bedtime in 1 minute. Save your work now."
            : "Bedtime in \(leadMinutes) minutes."

        let status: Int32
        if channel == "banner" {
            let script = "display notification \(quoted(message)) with title \(quoted("Bedtime"))"
            status = asUser(uid, ["/usr/bin/osascript", "-e", script])
        } else {
            // ⚖️ `CFUserNotification`, not `UNUserNotificationCenter`: it is a
            // DIALOG, not a notification, so Focus cannot suppress it and the
            // child has no toggle to find. No bundle, no entitlement, no $99.
            status = asUser(uid, [
                "/usr/bin/osascript", "-e",
                "display dialog \(quoted(message)) with title \(quoted("Bedtime")) "
                    + "buttons {\"OK\"} default button 1 giving up after 60 with icon caution",
            ])
        }

        // ⚠️ Never swallow a failed warning — `CGWindowList`-class APIs fail
        // SILENTLY on macOS and the same posture applies here. But a failure
        // is a health signal, not a gate: the lock has already been decided.
        return status == 0 ? .delivered : .failed
    }

    private static func quoted(_ s: String) -> String {
        "\"" + s.replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"") + "\""
    }

    // MARK: - The lock

    /// ⚖️ **Two independent paths plus a boot-time self-test.**
    /// `ScreenSaverEngine.app` is the next `CGSession` — the same class of
    /// undocumented internal artefact, and a Hammerspoon issue filed on macOS
    /// 27's release date already reports the `CGSession` path gone. Replacing
    /// one undocumented dependency with another is not closing the problem, so
    /// ship both and find out at boot which still works.
    public enum LockPath: String, CaseIterable {
        /// Documented-ish, and the one Apple's own menu item uses.
        case pmsetDisplaySleep
        /// The classic. Reported gone on macOS 27.
        case cgSession

        public var argv: [String] {
            switch self {
            case .pmsetDisplaySleep:
                return ["/usr/bin/pmset", "displaysleepnow"]
            case .cgSession:
                return [
                    "/System/Library/CoreServices/Menu Extras/User.menu/Contents/Resources/CGSession",
                    "-suspend",
                ]
            }
        }
    }

    /// Assert the lock. Idempotent — already locked is a success, which is
    /// what makes re-locking every tick safe.
    public static func lock() -> Bool {
        for path in LockPath.allCases {
            let task = Process()
            task.executableURL = URL(fileURLWithPath: path.argv[0])
            task.arguments = Array(path.argv.dropFirst())
            task.standardOutput = FileHandle.nullDevice
            task.standardError = FileHandle.nullDevice
            guard (try? task.run()) != nil else { continue }
            task.waitUntilExit()
            if task.terminationStatus == 0 { return true }
        }
        return false
    }

    /// Which lock paths exist on this machine, checked once at boot so a
    /// missing one is discovered in daylight rather than at 21:30.
    public static func lockSelfTest() -> [String: Bool] {
        Dictionary(
            uniqueKeysWithValues: LockPath.allCases.map {
                ($0.rawValue, FileManager.default.isExecutableFile(atPath: $0.argv[0]))
            })
    }

    // MARK: - Shutdown

    /// ⚠️ **COMPILE-TIME ONLY.** `DEV_ENFORCEMENT` replaces the real shutdown
    /// with a log line. There is deliberately **no env var, no plist key and
    /// no config field** — on a machine where the child has admin, a runtime
    /// switch for "do not actually shut down" is lever #7.
    ///
    /// Build the safe variant with:
    ///     swift build -Xswiftc -DDEV_ENFORCEMENT
    public static func shutdown() -> Bool {
        #if DEV_ENFORCEMENT
            FileHandle.standardError.write(
                Data("DEV_ENFORCEMENT: shutdown suppressed (would have powered off)\n".utf8))
            return true
        #else
            let task = Process()
            task.executableURL = URL(fileURLWithPath: "/sbin/shutdown")
            task.arguments = ["-h", "now"]
            guard (try? task.run()) != nil else { return false }
            task.waitUntilExit()
            return task.terminationStatus == 0
        #endif
    }
}

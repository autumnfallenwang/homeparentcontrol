import CoreGraphics
import Foundation

/// Is the screen locked?
///
/// ⚠️ **This has to run inside the console user's GUI session**, which is why
/// it is a separately-invocable mode rather than a function the daemon calls.
/// `CGSessionCopyCurrentDictionary()` reads the *calling process's* window
/// server session, and a root LaunchDaemon has none — it returns nil there,
/// which would read as "not locked" for ever.
///
/// The route not taken, and why:
///
/// - **PyObjC.** §4.1 suggests `kCGSSessionOnConsoleKey`, and the obvious
///   one-liner is `python3 -c "import Quartz…"`. Probed 2026-09-20:
///   `ModuleNotFoundError: No module named 'Quartz'`. Apple's bundled python3
///   has no PyObjC, so that line would have failed silently on every device
///   and reported "never locked".
/// - **`IODisplayWrangler`.** The classic display-power node. Probed: absent
///   on Apple Silicon, and `pmset -g powerstate IODisplayWrangler` answers
///   "Internal failure: Failed to get power state information".
/// - **`pgrep ScreenSaverEngine`.** Only true when the screensaver is
///   actually running, not when the machine is locked without it.
///
/// ⚠️ `CGSSessionScreenIsLocked` is **absent** when unlocked, not `false` —
/// probed directly. Treating absence as "unknown" rather than "unlocked"
/// would make every unlocked machine indeterminate.
public enum SessionProbe {

    /// The argument that puts an executable into probe mode.
    public static let flag = "--session-probe"

    /// One line on stdout: `locked=0 onconsole=1`.
    public static func report() -> String {
        guard let dictionary = CGSessionCopyCurrentDictionary() as? [String: Any] else {
            // No window server session — this is what a root daemon sees, and
            // it is the case the whole re-exec exists to avoid.
            return "locked=unknown onconsole=unknown"
        }
        let locked = (dictionary["CGSSessionScreenIsLocked"] as? Bool) == true
            || (dictionary["CGSSessionScreenIsLocked"] as? Int) == 1
        let onConsole = (dictionary["kCGSSessionOnConsoleKey"] as? Bool) == true
            || (dictionary["kCGSSessionOnConsoleKey"] as? Int) == 1
        return "locked=\(locked ? 1 : 0) onconsole=\(onConsole ? 1 : 0)"
    }

    /// Parse what `report()` printed. Nil when the probe could not tell.
    public static func parse(_ output: String) -> Bool? {
        for field in output.split(separator: " ") where field.hasPrefix("locked=") {
            let value = field.dropFirst("locked=".count)
            if value == "1" { return true }
            if value == "0" { return false }
            return nil
        }
        return nil
    }
}

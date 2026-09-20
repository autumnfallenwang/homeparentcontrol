import Foundation

/// `/var/db/homeparentcontrol/DISABLE` — §3.7, C2 corrected.
///
/// T3 justified this as parent-only *because the child is non-admin*. **She
/// has admin (AR.1).** The rationale was wrong; the control is still worth
/// having, hardened — and its honest limit is stated once: `sudo touch
/// …/DISABLE` is a total bypass in one command, and so is `launchctl bootout`.
/// Nothing here resists an admin child. The tell is that any attempt to
/// interfere at all lands in `tripwires`, and the parent finds out tonight
/// rather than in March.
public enum KillSwitch {

    public struct Status {
        public let present: Bool
        /// Nil when the file is empty — accepted, but logged as `indefinite`,
        /// because "one film night" must not silently become "permanently off".
        public let until: Date?
        public let indefinite: Bool
        /// True when the check itself failed. See `check()`.
        public let checkThrew: Bool

        public init(present: Bool, until: Date?, indefinite: Bool, checkThrew: Bool) {
            self.present = present
            self.until = until
            self.indefinite = indefinite
            self.checkThrew = checkThrew
        }
    }

    /// ⚠️ Read FRESH FROM DISK every tick, never cached — otherwise it is not
    /// an emergency control. Called FIRST, at the top of the enforcement path,
    /// so a bug later in the path cannot skip it.
    ///
    /// ⚠️ **Fails safe toward NOT enforcing, which is the one deliberate
    /// exception to "degrade toward enforcement" in this codebase.** §3.7: "if
    /// the check throws, treat as present — a bug in the guard must never
    /// *cause* a lockout." That is not lever #7: the same bypass already
    /// exists in one command for anyone with admin, and unlike a lever this
    /// one is loud — it raises `kill_switch_present` and shows in the UI as
    /// "enforcement disabled locally since 20:14".
    public static func check(now: Date = Date(), path: String = Paths.killSwitch) -> Status {
        guard FileManager.default.fileExists(atPath: path) else {
            return Status(present: false, until: nil, indefinite: false, checkThrew: false)
        }

        guard let data = FileManager.default.contents(atPath: path) else {
            // Exists but unreadable. Treat as present, per §3.7.
            return Status(present: true, until: nil, indefinite: true, checkThrew: true)
        }

        // An empty file is accepted.
        let text = String(decoding: data, as: UTF8.self).trimmingCharacters(
            in: .whitespacesAndNewlines)
        if text.isEmpty {
            return Status(present: true, until: nil, indefinite: true, checkThrew: false)
        }

        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let untilText = object["until"] as? String,
              let until = ISO8601DateFormatter.hpcParse(untilText)
        else {
            // Present but unparseable — still present.
            return Status(present: true, until: nil, indefinite: true, checkThrew: true)
        }

        // ⚠️ Time-boxed. An EXPIRED kill switch is not a kill switch: it stops
        // suppressing enforcement the moment it lapses, without anyone having
        // to remember to delete the file.
        if until <= now {
            return Status(present: false, until: until, indefinite: false, checkThrew: false)
        }
        return Status(present: true, until: until, indefinite: false, checkThrew: false)
    }
}

extension ISO8601DateFormatter {
    fileprivate static func hpcParse(_ text: String) -> Date? {
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return withFraction.date(from: text) ?? plain.date(from: text)
    }
}

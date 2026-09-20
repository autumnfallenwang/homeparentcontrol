import Foundation
import HPCCore

/// Reading and writing §6.5's shadow-mode marker.
///
/// ⚠️ **The supervisor writes this; the enforcer only reads it.** One writer,
/// and it is the component that just performed the install — because the
/// only legitimate reason to enter shadow mode is "a new version was just
/// installed", and the supervisor is the only thing that knows that.
///
/// ⚠️ Every failure to read resolves to **nil**, and `ShadowMode.verdict`
/// turns nil into `.enforcing`. A corrupt, truncated, half-written or
/// deleted marker therefore enforces. That direction is not an accident:
/// this is the one file whose *presence* can stop a Mac locking.
public enum SoakMarker {

    public static func read(path: String = Paths.soakMarker) -> ShadowMode.Soak? {
        guard let data = FileManager.default.contents(atPath: path),
              let row = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let version = row["version"] as? String,
              let startedAt = (row["started_at"] as? String).flatMap(ISO8601DateFormatter.hpcParse),
              let deadline = (row["deadline"] as? String).flatMap(ISO8601DateFormatter.hpcParse)
        else { return nil }

        return ShadowMode.Soak(
            version: version,
            startedAt: startedAt,
            deadline: deadline,
            expectDivergence: row["expect_divergence"] as? Bool ?? false,
            divergenceReason: row["divergence_reason"] as? String)
    }

    public static func write(_ soak: ShadowMode.Soak, path: String = Paths.soakMarker) throws {
        let formatter = ISO8601DateFormatter()
        var row: [String: Any] = [
            "version": soak.version,
            "started_at": formatter.string(from: soak.startedAt),
            "deadline": formatter.string(from: soak.deadline),
            "expect_divergence": soak.expectDivergence,
        ]
        if let reason = soak.divergenceReason { row["divergence_reason"] = reason }
        let data = try JSONSerialization.data(withJSONObject: row, options: [.sortedKeys])
        try data.write(to: URL(fileURLWithPath: path), options: .atomic)
    }

    /// Promotion. ⚠️ Removing the file is the whole of it — there is no
    /// "promoted: true" state, because a state machine with two ways to be
    /// enforcing has two ways to get stuck not enforcing.
    public static func clear(path: String = Paths.soakMarker) {
        try? FileManager.default.removeItem(atPath: path)
    }

    /// Versions that have already completed a soak, so one is never re-run.
    ///
    /// ⚠️ Property 3 of `ShadowMode`: without this, reinstalling the agent
    /// buys another unenforced day, every time.
    public static func soaked(path: String = Paths.root + "/soaked.json") -> Set<String> {
        guard let data = FileManager.default.contents(atPath: path),
              let rows = try? JSONSerialization.jsonObject(with: data) as? [String]
        else { return [] }
        return Set(rows)
    }

    public static func recordSoaked(_ version: String, path: String = Paths.root + "/soaked.json") {
        var all = soaked(path: path)
        all.insert(version)
        guard let data = try? JSONSerialization.data(
            withJSONObject: Array(all).sorted(), options: [.sortedKeys]) else { return }
        try? data.write(to: URL(fileURLWithPath: path), options: .atomic)
    }
}

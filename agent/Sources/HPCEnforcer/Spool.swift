import Foundation

/// The NDJSON spool, and the health file.
///
/// ⚠️ §3.2 step 8: "**THE DECISION IS TAKEN BEFORE THIS WRITE**, so a failed
/// write drops telemetry and never affects enforcement." Nothing in this file
/// may throw into the enforcement path, and nothing in the enforcement path
/// may await its result. A full disk loses reporting; it does not buy an extra
/// hour of Minecraft.
enum Spool {

    /// Append one event. Failures are swallowed on purpose — see above.
    static func append(kind: String, detail: [String: String], tickSeq: Int) {
        var row: [String: Any] = [
            "ts": ISO8601DateFormatter().string(from: Date()),
            "event": kind,
            "seq": tickSeq,
        ]
        if !detail.isEmpty { row["detail"] = detail }

        guard let data = try? JSONSerialization.data(withJSONObject: row),
              var line = String(data: data, encoding: .utf8)
        else { return }
        line.append("\n")

        let path = Paths.spool
        let directory = (path as NSString).deletingLastPathComponent
        try? FileManager.default.createDirectory(
            atPath: directory, withIntermediateDirectories: true)

        if let handle = FileHandle(forWritingAtPath: path) {
            defer { try? handle.close() }
            _ = try? handle.seekToEnd()
            try? handle.write(contentsOf: Data(line.utf8))
        } else {
            try? Data(line.utf8).write(to: URL(fileURLWithPath: path))
        }
    }

    /// §3.2 step 9 — `enforcer.health {ts, tick_seq, version, last_decision}`.
    ///
    /// ⚠️ X8 ruled this is **the supervisor's input and an observability
    /// signal, never the enforcer's gate.** The enforcer writes it and never
    /// reads it back to decide anything.
    static func writeHealth(tickSeq: Int, lastDecision: String, version: String) {
        let row: [String: Any] = [
            "ts": ISO8601DateFormatter().string(from: Date()),
            "tick_seq": tickSeq,
            "version": version,
            "last_decision": lastDecision,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: row) else { return }
        try? data.write(to: URL(fileURLWithPath: Paths.health), options: .atomic)
    }

    // MARK: - Clean exit (§3.8)

    /// ⚠️ **The file is load-bearing; the event is not.** The pre-sleep window
    /// is short and not guaranteed to survive a network round-trip, so if
    /// every `agent.stopping` POST is lost the *next* `agent.started` still
    /// carries `clean_exit_previous_run` and the shutdown is classified
    /// retrospectively. Do not build the design on the dying breath arriving.
    static func writeCleanExit(clean: Bool, reason: String?, bootId: String) {
        var row: [String: Any] = ["clean": clean, "boot_id": bootId]
        if clean {
            row["stopped_at"] = ISO8601DateFormatter().string(from: Date())
            row["reason"] = reason ?? "signal"
        } else {
            row["started_at"] = ISO8601DateFormatter().string(from: Date())
        }
        guard let data = try? JSONSerialization.data(withJSONObject: row) else { return }
        // fsync, because the machine is about to stop existing.
        try? data.write(to: URL(fileURLWithPath: Paths.cleanExit), options: [.atomic])
    }

    /// Read the previous run's marker, to report on the FIRST tick.
    static func readPreviousCleanExit() -> (clean: Bool, reason: String?)? {
        guard let data = FileManager.default.contents(atPath: Paths.cleanExit),
              let row = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let clean = row["clean"] as? Bool
        else { return nil }
        return (clean, row["reason"] as? String)
    }
}

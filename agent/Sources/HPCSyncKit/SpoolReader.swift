import Foundation
import HPCAgentIO
import HPCCore

/// Moving the enforcer's NDJSON spool into `queue.sqlite`.
///
/// ⚠️ **V6 is the constraint that shapes this whole file**: "byte-identical
/// enforcer logs with and without sync running — *the direct proof* that
/// enforcement is independent of the network". So the reader must be
/// invisible to the enforcer.
///
/// The classic way to get this wrong is copy-truncate: read the file, then
/// `truncate()` it. Between those two calls the enforcer appends, and that
/// append is destroyed — a lost lock record, in exactly the log a parent
/// reads to find out what happened.
///
/// **`rename(2)` instead.** It is atomic, and `Spool.append` resolves the path
/// on every call (`FileHandle(forWritingAtPath:)`), so:
///
/// - rename lands before the enforcer's open → it creates a fresh spool, and
///   nothing is lost;
/// - rename lands after the open → that one append goes to the renamed inode,
///   which is the file we are about to read, and nothing is lost.
///
/// There is no interleaving that drops a line, and the enforcer never blocks,
/// never checks a return value, and never learns this happened.
public enum SpoolReader {

    /// Event types that are `class: "audit"`. Everything else is a `sample`.
    ///
    /// ⚠️ Derived from `ENFORCEMENT_LOG_KINDS` in `packages/contract` — these
    /// are the types that become an `enforcement_log` row, which is precisely
    /// the set that must outlive a queue overrun. Audit retention is 90 days
    /// against a sample's 14, and eviction takes samples first, so a type
    /// misfiled here is an enforcement action silently downgraded to
    /// droppable.
    public static let auditTypes: Set<String> = [
        "enforcement.warning_shown", "enforcement.warning_failed",
        "enforcement.action_taken", "enforcement.action_failed",
        "enforcement.kill_switch_present",
        "policy.applied", "policy.rejected", "policy.unsigned",
        "agent.degraded", "agent.started", "agent.stopping",
        "clock.stepped", "override.granted", "override.expired",
        "queue.evicted", "agent.kill_switch_present",
        "agent.lock_self_test", "agent.decommissioned",
        "supervisor.installed", "supervisor.install_failed", "supervisor.rollback",
    ]

    /// Rotate the live spool out of the way and hand back the segment path.
    /// Nil when there is nothing to take.
    public static func rotate(
        spool: String = Paths.spool, stamp: String = String(Int(Date().timeIntervalSince1970))
    ) -> String? {
        let manager = FileManager.default
        guard let attributes = try? manager.attributesOfItem(atPath: spool),
              (attributes[.size] as? Int ?? 0) > 0
        else { return nil }

        // ⚠️ Beside the spool it came from, not at a fixed path. A rotation
        // that moves a file ACROSS directories is not the atomic `rename(2)`
        // this whole design rests on — it can land on another filesystem and
        // silently become copy-then-unlink, which is exactly the lossy
        // behaviour the comment above rules out.
        let directory = (spool as NSString).deletingLastPathComponent
        let segment = "\(directory)/enforcer.\(stamp).ndjson"
        // An existing segment means a previous run died between rotating and
        // ingesting. Leave it — `pending()` will pick it up — and wait a
        // second rather than overwrite unsent telemetry.
        guard !manager.fileExists(atPath: segment) else { return nil }
        guard (try? manager.moveItem(atPath: spool, toPath: segment)) != nil else { return nil }
        return segment
    }

    /// Every rotated segment still awaiting ingest, oldest first. Includes
    /// segments a previous run left behind after a crash.
    public static func pending(directory: String = Paths.spoolDirectory) -> [String] {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: directory)) ?? []
        return names
            .filter { $0.hasPrefix("enforcer.") && $0.hasSuffix(".ndjson")
                && $0 != "enforcer.ndjson" }
            .sorted()
            .map { "\(directory)/\($0)" }
    }

    /// Parse one segment into queue rows.
    ///
    /// ⚠️ **R8 applied on the agent's side of the wire.** A line this build
    /// does not understand is still forwarded verbatim: the type goes up as
    /// written and `data` carries whatever `detail` held. Dropping unknown
    /// lines here would make every future event type require an agent release
    /// before the server could ever see one.
    public static func parse(segment: String, bootId: String) -> [Queue.Row] {
        guard let text = try? String(contentsOfFile: segment, encoding: .utf8) else { return [] }
        var rows: [Queue.Row] = []
        let segmentName = (segment as NSString).lastPathComponent

        for (index, line) in text.split(separator: "\n").enumerated() {
            guard !line.isEmpty,
                  let object = try? JSONSerialization.jsonObject(with: Data(line.utf8)),
                  let row = object as? [String: Any],
                  let type = row["event"] as? String
            else { continue }

            let ts = (row["ts"] as? String).flatMap(ISO8601DateFormatter.hpcParse) ?? Date()
            let detail = row["detail"] as? [String: Any] ?? [:]
            // ⚠️ `seq: -1` is the deadfall's marker (it has no tick counter).
            // Forwarded as-is rather than normalised away, because "which
            // process locked this Mac" is the first question a parent asks.
            let seq = row["seq"] as? Int

            // ★ Deterministic, so re-parsing a segment after a crash between
            // `enqueue` and `unlink` collides on the queue's UNIQUE index
            // instead of minting a second id for the same event. The segment
            // name plus the line's ordinal is stable across re-reads and
            // unique within the boot, which is exactly the property needed.
            let seed = "\(bootId)|\(segmentName)|\(index)|\(line)"

            rows.append(
                Queue.Row(
                    eventId: EventID.derived(from: seed, at: ts),
                    ts: ts,
                    type: type,
                    cls: auditTypes.contains(type) ? .audit : .sample,
                    seq: seq,
                    bootId: bootId,
                    data: detail))
        }
        return rows
    }

    /// Rotate, ingest every pending segment, delete each only once its rows
    /// are durably in SQLite.
    @discardableResult
    public static func drain(into queue: Queue, bootId: String) throws -> Int {
        _ = rotate()
        var ingested = 0
        for segment in pending() {
            let rows = parse(segment: segment, bootId: bootId)
            // ⚠️ Enqueue FIRST, delete second. The other order loses the
            // segment if the process dies between the two, and `event_id` is
            // UNIQUE so a repeat costs nothing.
            ingested += try queue.enqueue(rows)
            try? FileManager.default.removeItem(atPath: segment)
        }
        return ingested
    }
}

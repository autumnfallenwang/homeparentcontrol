import Foundation
import HPCCore
import Testing

@testable import HPCSyncKit

/// Draining the enforcer's spool. V6's constraint throughout: this must be
/// **invisible** to the enforcer.
struct SpoolReaderTests {

    static func temporaryDirectory() -> String {
        let path = NSTemporaryDirectory() + "hpc-spool-\(UUID().uuidString.lowercased())"
        try? FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)
        return path
    }

    static func write(_ lines: [String], to path: String) {
        try? (lines.joined(separator: "\n") + "\n").write(
            toFile: path, atomically: true, encoding: .utf8)
    }

    static func line(_ type: String, seq: Int = 1, detail: String = "{}") -> String {
        """
        {"ts":"2026-09-20T21:30:00.000Z","event":"\(type)","seq":\(seq),"detail":\(detail)}
        """
    }

    // MARK: - Parsing

    @Test("each NDJSON line becomes one queue row")
    func parsesLines() {
        let directory = Self.temporaryDirectory()
        let segment = "\(directory)/enforcer.1.ndjson"
        Self.write(
            [
                Self.line("enforcement.action_taken", detail: #"{"action":"lock"}"#),
                Self.line("app.usage_sample", seq: 2),
            ], to: segment)

        let rows = SpoolReader.parse(segment: segment, bootId: "boot-a")
        #expect(rows.count == 2)
        #expect(rows[0].type == "enforcement.action_taken")
        #expect(rows[0].data["action"] as? String == "lock")
        #expect(rows.allSatisfy { $0.bootId == "boot-a" })
    }

    /// ★ Classification decides retention (90 days vs 14) AND eviction order.
    /// A misfiled enforcement action is an enforcement action silently
    /// downgraded to droppable.
    @Test("★ enforcement events are audit class; samples are not")
    func classification() {
        let directory = Self.temporaryDirectory()
        let segment = "\(directory)/enforcer.1.ndjson"
        Self.write(
            [
                Self.line("enforcement.action_taken"),
                Self.line("agent.degraded"),
                Self.line("queue.evicted"),
                Self.line("app.usage_sample"),
                Self.line("session.state"),
            ], to: segment)

        let rows = SpoolReader.parse(segment: segment, bootId: "b")
        #expect(rows.filter { $0.cls == .audit }.count == 3)
        #expect(rows.filter { $0.cls == .sample }.count == 2)
    }

    /// ★ R8 on the agent's side. Dropping an unrecognised line here would
    /// make every new event type need an agent release before the server
    /// could see one.
    @Test("★ an event type this build has never heard of is still forwarded")
    func unknownTypeIsForwarded() {
        let directory = Self.temporaryDirectory()
        let segment = "\(directory)/enforcer.1.ndjson"
        Self.write([Self.line("something.invented.in.2029")], to: segment)

        let rows = SpoolReader.parse(segment: segment, bootId: "b")
        #expect(rows.count == 1)
        #expect(rows[0].type == "something.invented.in.2029")
        // Unknown means sample, so it is capped and evictable — never exempt.
        #expect(rows[0].cls == .sample)
    }

    @Test("a truncated final line is skipped and the rest survive")
    func toleratesTruncation() {
        let directory = Self.temporaryDirectory()
        let segment = "\(directory)/enforcer.1.ndjson"
        // A power cut mid-append leaves exactly this.
        try? (Self.line("enforcement.action_taken") + "\n" + #"{"ts":"2026-09-2"#)
            .write(toFile: segment, atomically: true, encoding: .utf8)
        #expect(SpoolReader.parse(segment: segment, bootId: "b").count == 1)
    }

    @Test("the deadfall's seq: -1 marker is preserved, not normalised away")
    func preservesDeadfallMarker() {
        let directory = Self.temporaryDirectory()
        let segment = "\(directory)/enforcer.1.ndjson"
        Self.write([Self.line("enforcement.action_taken", seq: -1)], to: segment)
        #expect(SpoolReader.parse(segment: segment, bootId: "b")[0].seq == -1)
    }

    // MARK: - ★ Deterministic ids

    /// ★ The crash-between-enqueue-and-unlink case. Re-parsing the same
    /// segment must produce the SAME ids, or the queue's UNIQUE index cannot
    /// catch the repeat and the server stores one event twice under two ids —
    /// where no later de-duplication could ever tell.
    @Test("★ re-parsing a segment yields byte-identical event ids")
    func parsingIsDeterministic() {
        let directory = Self.temporaryDirectory()
        let segment = "\(directory)/enforcer.1.ndjson"
        Self.write(
            [Self.line("enforcement.action_taken"), Self.line("app.usage_sample", seq: 2)],
            to: segment)

        let first = SpoolReader.parse(segment: segment, bootId: "boot-a").map(\.eventId)
        let second = SpoolReader.parse(segment: segment, bootId: "boot-a").map(\.eventId)
        #expect(first == second)
        #expect(Set(first).count == 2, "two different lines must not collide")
    }

    /// Two identical lines in one segment are two events, and must not
    /// collapse — the enforcer can legitimately log the same thing twice.
    @Test("identical lines at different offsets get different ids")
    func identicalLinesDiffer() {
        let directory = Self.temporaryDirectory()
        let segment = "\(directory)/enforcer.1.ndjson"
        Self.write([Self.line("agent.degraded"), Self.line("agent.degraded")], to: segment)
        let ids = SpoolReader.parse(segment: segment, bootId: "b").map(\.eventId)
        #expect(ids.count == 2)
        #expect(ids[0] != ids[1])
    }

    /// A different boot is a different event even for an identical line, so
    /// re-reading a stale segment after a reboot cannot silently merge.
    @Test("the same line under a different boot_id is a different event")
    func bootIdSeparates() {
        let directory = Self.temporaryDirectory()
        let segment = "\(directory)/enforcer.1.ndjson"
        Self.write([Self.line("agent.started")], to: segment)
        #expect(
            SpoolReader.parse(segment: segment, bootId: "boot-a")[0].eventId
                != SpoolReader.parse(segment: segment, bootId: "boot-b")[0].eventId)
    }

    // MARK: - Rotation

    @Test("rotate moves the live spool aside and leaves the path free")
    func rotateMovesAside() {
        let directory = Self.temporaryDirectory()
        let spool = "\(directory)/enforcer.ndjson"
        Self.write([Self.line("agent.started")], to: spool)

        let segment = SpoolReader.rotate(spool: spool, stamp: "111")
        #expect(segment != nil)
        // ★ The enforcer's next `FileHandle(forWritingAtPath:)` must find the
        // path free, so it creates a fresh file rather than appending into
        // one that is being drained.
        #expect(!FileManager.default.fileExists(atPath: spool))
    }

    @Test("rotating an empty or absent spool is a no-op")
    func rotateNothing() {
        let directory = Self.temporaryDirectory()
        #expect(SpoolReader.rotate(spool: "\(directory)/absent.ndjson", stamp: "1") == nil)
        FileManager.default.createFile(atPath: "\(directory)/enforcer.ndjson", contents: Data())
        #expect(SpoolReader.rotate(spool: "\(directory)/enforcer.ndjson", stamp: "1") == nil)
    }

    /// ★ A segment left behind by a crashed run must not be overwritten — it
    /// holds telemetry nobody has sent yet.
    @Test("★ rotate refuses to clobber an un-ingested segment")
    func rotateWillNotClobber() {
        let directory = Self.temporaryDirectory()
        let spool = "\(directory)/enforcer.ndjson"
        Self.write([Self.line("agent.started")], to: spool)
        // Simulate the leftover by pre-creating the destination this stamp
        // would choose.
        let stamp = "222"
        Self.write(
            [Self.line("enforcement.action_taken")], to: "\(directory)/enforcer.\(stamp).ndjson")

        #expect(SpoolReader.rotate(spool: spool, stamp: stamp) == nil)
        #expect(FileManager.default.fileExists(atPath: spool), "the live spool must survive")
    }

    @Test("pending lists rotated segments oldest first and skips the live one")
    func pendingOrdering() {
        let directory = Self.temporaryDirectory()
        for name in ["enforcer.ndjson", "enforcer.100.ndjson", "enforcer.200.ndjson"] {
            Self.write([Self.line("agent.started")], to: "\(directory)/\(name)")
        }
        let pending = SpoolReader.pending(directory: directory).map {
            ($0 as NSString).lastPathComponent
        }
        #expect(pending == ["enforcer.100.ndjson", "enforcer.200.ndjson"])
    }
}

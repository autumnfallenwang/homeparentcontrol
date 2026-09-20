import Foundation
import HPCAgentIO
import HPCCore
import SQLite3

private let sqliteTransient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

/// `queue.sqlite` — durable store-and-forward for telemetry (§2, §4.4).
///
/// ⚠️ **"the sync daemon owns it exclusively."** Nothing else opens this file.
/// The enforcer writes NDJSON to its spool and never learns whether anything
/// was delivered, which is the property that makes a full disk, a dead server
/// and a revoked credential all cost telemetry and never cost enforcement.
///
/// ⚠️ **Deletion is driven by `accepted_event_ids`, never by the fact that a
/// request returned 200.** §5.7: "a conflicting row is still *accepted* — it
/// is already durable." An event stays queued until the server names it.
public final class Queue {
    private var db: OpaquePointer?

    public init(path: String = Paths.queue) throws {
        try FileManager.default.createDirectory(
            atPath: (path as NSString).deletingLastPathComponent,
            withIntermediateDirectories: true)
        guard sqlite3_open_v2(
            path, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil)
            == SQLITE_OK
        else { throw Failure.open(String(cString: sqlite3_errmsg(db))) }

        // WAL so a crash mid-write loses at most the current transaction, and
        // NORMAL rather than FULL because this is telemetry: an fsync per
        // event would cost more than the data is worth. §3.2 step 8 — the
        // decision is already taken before anything reaches this file.
        try exec("PRAGMA journal_mode=WAL")
        try exec("PRAGMA synchronous=NORMAL")
        try exec("PRAGMA busy_timeout=5000")
        try migrate()
    }

    deinit { sqlite3_close(db) }

    public enum Failure: Error {
        case open(String)
        case sql(String)
    }

    // MARK: - Schema

    private func migrate() throws {
        // `event_id` is UNIQUE, so re-reading a spool segment after a crash
        // mid-ingest is idempotent rather than duplicating. The agent's own
        // de-duplication mirrors the server's `ON CONFLICT (device_id,
        // event_id) DO NOTHING`, one layer earlier.
        try exec("""
            CREATE TABLE IF NOT EXISTS events (
                rowid       INTEGER PRIMARY KEY AUTOINCREMENT,
                event_id    TEXT NOT NULL UNIQUE,
                queued_at   TEXT NOT NULL,
                ts          TEXT NOT NULL,
                type        TEXT NOT NULL,
                class       TEXT NOT NULL,
                seq         INTEGER,
                boot_id     TEXT,
                data        TEXT NOT NULL,
                bytes       INTEGER NOT NULL
            )
            """)
        try exec("CREATE INDEX IF NOT EXISTS events_class_rowid ON events(class, rowid)")
        try exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    }

    // MARK: - Writing

    public struct Row: Equatable, Sendable {
        public let eventId: String
        public let ts: Date
        public let type: String
        public let cls: QueuePolicy.Class
        public let seq: Int?
        public let bootId: String?
        public let data: [String: Any]

        public init(
            eventId: String = EventID.v7(), ts: Date = Date(), type: String,
            cls: QueuePolicy.Class, seq: Int? = nil, bootId: String? = nil,
            data: [String: Any] = [:]
        ) {
            self.eventId = eventId
            self.ts = ts
            self.type = type
            self.cls = cls
            self.seq = seq
            self.bootId = bootId
            self.data = data
        }

        public static func == (lhs: Row, rhs: Row) -> Bool { lhs.eventId == rhs.eventId }
    }

    /// Enqueue, ignoring an id already present.
    @discardableResult
    public func enqueue(_ rows: [Row]) throws -> Int {
        guard !rows.isEmpty else { return 0 }
        try exec("BEGIN IMMEDIATE")
        var inserted = 0
        do {
            for row in rows {
                let payload = (try? JSONSerialization.data(
                    withJSONObject: row.data, options: [.sortedKeys])) ?? Data("{}".utf8)
                let json = String(decoding: payload, as: UTF8.self)
                let statement = try prepare("""
                    INSERT OR IGNORE INTO events
                        (event_id, queued_at, ts, type, class, seq, boot_id, data, bytes)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """)
                defer { sqlite3_finalize(statement) }
                bind(statement, 1, row.eventId)
                bind(statement, 2, Self.iso.string(from: Date()))
                bind(statement, 3, Self.iso.string(from: row.ts))
                bind(statement, 4, row.type)
                bind(statement, 5, row.cls.rawValue)
                if let seq = row.seq {
                    sqlite3_bind_int64(statement, 6, Int64(seq))
                } else {
                    sqlite3_bind_null(statement, 6)
                }
                if let bootId = row.bootId {
                    bind(statement, 7, bootId)
                } else {
                    sqlite3_bind_null(statement, 7)
                }
                bind(statement, 8, json)
                // Approximate wire size, for the byte cap. Close enough to
                // budget with, and cheaper than serialising twice.
                sqlite3_bind_int64(statement, 9, Int64(json.utf8.count + row.type.utf8.count + 96))
                guard sqlite3_step(statement) == SQLITE_DONE else {
                    throw Failure.sql(String(cString: sqlite3_errmsg(db)))
                }
                inserted += Int(sqlite3_changes(db))
            }
            try exec("COMMIT")
        } catch {
            try? exec("ROLLBACK")
            throw error
        }
        return inserted
    }

    // MARK: - Reading

    /// The oldest `limit` events, oldest first.
    ///
    /// ⚠️ Ordered by `rowid`, not by `ts`. A stepped clock makes `ts`
    /// non-monotonic — that is the whole reason `clock.stepped` is an event —
    /// and a drain ordered by a clock the child can change is a drain that can
    /// be made to starve.
    public func batch(limit: Int) throws -> [Row] {
        let statement = try prepare("""
            SELECT event_id, ts, type, class, seq, boot_id, data
            FROM events ORDER BY rowid LIMIT ?
            """)
        defer { sqlite3_finalize(statement) }
        sqlite3_bind_int64(statement, 1, Int64(limit))

        var rows: [Row] = []
        while sqlite3_step(statement) == SQLITE_ROW {
            let json = text(statement, 6)
            let data = (try? JSONSerialization.jsonObject(with: Data(json.utf8)))
                as? [String: Any] ?? [:]
            rows.append(
                Row(
                    eventId: text(statement, 0),
                    ts: ISO8601DateFormatter.hpcParse(text(statement, 1)) ?? Date(),
                    type: text(statement, 2),
                    cls: QueuePolicy.Class(rawValue: text(statement, 3)) ?? .sample,
                    seq: sqlite3_column_type(statement, 4) == SQLITE_NULL
                        ? nil : Int(sqlite3_column_int64(statement, 4)),
                    bootId: sqlite3_column_type(statement, 5) == SQLITE_NULL
                        ? nil : text(statement, 5),
                    data: data))
        }
        return rows
    }

    /// Remove exactly the ids the server named. Nothing else is ever removed
    /// by a successful sync.
    @discardableResult
    public func acknowledge(_ ids: [String]) throws -> Int {
        guard !ids.isEmpty else { return 0 }
        try exec("BEGIN IMMEDIATE")
        do {
            for id in ids {
                let statement = try prepare("DELETE FROM events WHERE event_id = ?")
                defer { sqlite3_finalize(statement) }
                bind(statement, 1, id)
                guard sqlite3_step(statement) == SQLITE_DONE else {
                    throw Failure.sql(String(cString: sqlite3_errmsg(db)))
                }
            }
            try exec("COMMIT")
        } catch {
            try? exec("ROLLBACK")
            throw error
        }
        return ids.count
    }

    public func census() throws -> QueuePolicy.Census {
        var census = QueuePolicy.Census()
        let statement = try prepare("""
            SELECT class, COUNT(*), COALESCE(SUM(bytes), 0), MIN(queued_at)
            FROM events GROUP BY class
            """)
        defer { sqlite3_finalize(statement) }
        while sqlite3_step(statement) == SQLITE_ROW {
            let cls = QueuePolicy.Class(rawValue: text(statement, 0))
            let count = Int(sqlite3_column_int64(statement, 1))
            let bytes = Int(sqlite3_column_int64(statement, 2))
            let oldest = ISO8601DateFormatter.hpcParse(text(statement, 3))
            switch cls {
            case .sample:
                census.sampleCount = count
                census.sampleBytes = bytes
                census.oldestSampleAt = oldest
            case .audit:
                census.auditCount = count
                census.auditBytes = bytes
                census.oldestAuditAt = oldest
            case nil:
                // A class nothing recognises. Counted with samples so it is
                // still subject to a cap; never silently exempt.
                census.sampleCount += count
                census.sampleBytes += bytes
            }
        }
        return census
    }

    /// Apply a `QueuePolicy.Plan`, and return what was actually lost so the
    /// caller can enqueue the `queue.evicted` receipt.
    public struct Evicted: Equatable, Sendable {
        public var counts: [QueuePolicy.Class: Int] = [:]
        public var oldest: Date?
        public var newest: Date?
        public var total: Int { counts.values.reduce(0, +) }
    }

    public func evict(_ plan: QueuePolicy.Plan) throws -> Evicted {
        var evicted = Evicted()
        for eviction in plan.evictions {
            let victims: [(String, Date)]
            if let olderThan = eviction.olderThan {
                victims = try select(
                    "SELECT event_id, queued_at FROM events WHERE class = ? AND queued_at < ?",
                    [eviction.cls.rawValue, Self.iso.string(from: olderThan)])
            } else if eviction.rows > 0 {
                victims = try select(
                    "SELECT event_id, queued_at FROM events WHERE class = ? "
                        + "ORDER BY rowid LIMIT \(eviction.rows)",
                    [eviction.cls.rawValue])
            } else {
                continue
            }
            guard !victims.isEmpty else { continue }

            try acknowledge(victims.map(\.0))
            evicted.counts[eviction.cls, default: 0] += victims.count
            let stamps = victims.map(\.1)
            evicted.oldest = [evicted.oldest, stamps.min()].compactMap { $0 }.min()
            evicted.newest = [evicted.newest, stamps.max()].compactMap { $0 }.max()
        }
        return evicted
    }

    // MARK: - Meta

    public func meta(_ key: String) throws -> String? {
        let statement = try prepare("SELECT value FROM meta WHERE key = ?")
        defer { sqlite3_finalize(statement) }
        bind(statement, 1, key)
        return sqlite3_step(statement) == SQLITE_ROW ? text(statement, 0) : nil
    }

    public func setMeta(_ key: String, _ value: String) throws {
        let statement = try prepare(
            "INSERT INTO meta (key, value) VALUES (?, ?) "
                + "ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        defer { sqlite3_finalize(statement) }
        bind(statement, 1, key)
        bind(statement, 2, value)
        guard sqlite3_step(statement) == SQLITE_DONE else {
            throw Failure.sql(String(cString: sqlite3_errmsg(db)))
        }
    }

    // MARK: - Plumbing

    static let iso: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private func select(_ sql: String, _ args: [String]) throws -> [(String, Date)] {
        let statement = try prepare(sql)
        defer { sqlite3_finalize(statement) }
        for (index, arg) in args.enumerated() { bind(statement, Int32(index + 1), arg) }
        var rows: [(String, Date)] = []
        while sqlite3_step(statement) == SQLITE_ROW {
            rows.append((text(statement, 0), ISO8601DateFormatter.hpcParse(text(statement, 1)) ?? Date()))
        }
        return rows
    }

    private func prepare(_ sql: String) throws -> OpaquePointer? {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else {
            throw Failure.sql("\(String(cString: sqlite3_errmsg(db))) — \(sql)")
        }
        return statement
    }

    private func exec(_ sql: String) throws {
        guard sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK else {
            throw Failure.sql("\(String(cString: sqlite3_errmsg(db))) — \(sql)")
        }
    }

    private func bind(_ statement: OpaquePointer?, _ index: Int32, _ value: String) {
        sqlite3_bind_text(statement, index, value, -1, sqliteTransient)
    }

    private func text(_ statement: OpaquePointer?, _ column: Int32) -> String {
        guard let pointer = sqlite3_column_text(statement, column) else { return "" }
        return String(cString: pointer)
    }
}

import Foundation
import HPCCore
import Testing

@testable import HPCSyncKit

/// `queue.sqlite`. The exit criterion under test: *survives a server outage
/// of several hours and drains its queue without duplicating or losing
/// events.*
struct QueueTests {

    static func temporaryQueue() throws -> (Queue, String) {
        let path = NSTemporaryDirectory()
            + "hpc-queue-\(UUID().uuidString.lowercased()).sqlite"
        return (try Queue(path: path), path)
    }

    static func rows(_ count: Int, cls: QueuePolicy.Class = .sample, from: Date = Date())
        -> [Queue.Row]
    {
        (0..<count).map { index in
            Queue.Row(
                eventId: EventID.derived(from: "row-\(index)-\(cls.rawValue)", at: from),
                ts: from.addingTimeInterval(Double(index)),
                type: cls == .audit ? "enforcement.action_taken" : "app.usage_sample",
                cls: cls,
                seq: index,
                data: ["index": index])
        }
    }

    // MARK: - Round trip

    @Test("enqueue then batch returns what went in, oldest first")
    func roundTrip() throws {
        let (queue, _) = try Self.temporaryQueue()
        try queue.enqueue(Self.rows(5))
        let batch = try queue.batch(limit: 10)
        #expect(batch.count == 5)
        #expect(batch.map(\.seq) == [0, 1, 2, 3, 4])
    }

    @Test("a batch limit is respected")
    func batchLimit() throws {
        let (queue, _) = try Self.temporaryQueue()
        try queue.enqueue(Self.rows(50))
        #expect(try queue.batch(limit: 10).count == 10)
    }

    // MARK: - ★ Idempotency

    /// ★ The same event enqueued twice is one row. This is the agent's half of
    /// the server's `ON CONFLICT (device_id, event_id) DO NOTHING`.
    @Test("★ enqueueing the same event_id twice stores one row")
    func enqueueIsIdempotent() throws {
        let (queue, _) = try Self.temporaryQueue()
        let rows = Self.rows(3)
        #expect(try queue.enqueue(rows) == 3)
        #expect(try queue.enqueue(rows) == 0)
        #expect(try queue.batch(limit: 100).count == 3)
    }

    /// ★ §5.7's re-send-forever trap, from the agent's side: acknowledgement
    /// is driven by `accepted_event_ids`, not by "the request returned 200".
    /// An event the server did not name stays queued.
    @Test("★ only the ids the server named are removed")
    func acknowledgeIsExact() throws {
        let (queue, _) = try Self.temporaryQueue()
        let rows = Self.rows(5)
        try queue.enqueue(rows)

        try queue.acknowledge([rows[0].eventId, rows[2].eventId])
        let remaining = try queue.batch(limit: 100).map(\.eventId)
        #expect(remaining.count == 3)
        #expect(!remaining.contains(rows[0].eventId))
        #expect(remaining.contains(rows[1].eventId))
    }

    @Test("acknowledging an id that is not present is harmless")
    func acknowledgeUnknown() throws {
        let (queue, _) = try Self.temporaryQueue()
        try queue.enqueue(Self.rows(2))
        try queue.acknowledge(["018f2a4c-7b31-7c9e-9d2a-000000000000"])
        #expect(try queue.batch(limit: 100).count == 2)
    }

    // MARK: - ★ Survives an outage

    /// ★ The headline exit criterion, simulated: hours of events accumulate
    /// while every request fails, then the queue drains in batches with no
    /// duplicate and no loss.
    @Test("★ a four-hour outage drains without duplicating or losing an event")
    func survivesAnOutage() throws {
        let (queue, path) = try Self.temporaryQueue()
        let start = Date().addingTimeInterval(-4 * 3_600)

        // 60 s tick × 4 hours = 240 ticks, four events each.
        var minted: [String] = []
        for tick in 0..<240 {
            let at = start.addingTimeInterval(Double(tick) * 60)
            let batch = (0..<4).map { slot in
                Queue.Row(
                    eventId: EventID.derived(from: "tick-\(tick)-\(slot)", at: at),
                    ts: at, type: "app.usage_sample", cls: .sample, seq: tick,
                    data: ["tick": tick])
            }
            minted.append(contentsOf: batch.map(\.eventId))
            try queue.enqueue(batch)
        }
        #expect(minted.count == 960)
        #expect(Set(minted).count == 960, "the ids themselves must be unique")

        // Reopen: the outage may well have spanned a reboot.
        let reopened = try Queue(path: path)
        var delivered: [String] = []
        while true {
            let batch = try reopened.batch(limit: 100)
            if batch.isEmpty { break }
            delivered.append(contentsOf: batch.map(\.eventId))
            try reopened.acknowledge(batch.map(\.eventId))
        }

        #expect(delivered.count == 960, "lost events")
        #expect(Set(delivered).count == 960, "duplicated events")
        #expect(Set(delivered) == Set(minted))
    }

    /// ★ Ordering must not depend on a clock the child can change. §4.4 makes
    /// `ts` advisory for exactly this reason.
    @Test("★ a stepped clock does not reorder the drain")
    func orderingIgnoresTs() throws {
        let (queue, _) = try Self.temporaryQueue()
        let now = Date()
        try queue.enqueue([
            .init(eventId: EventID.derived(from: "a", at: now), ts: now, type: "a", cls: .audit),
            // The clock steps a year backwards between these two.
            .init(
                eventId: EventID.derived(from: "b", at: now),
                ts: now.addingTimeInterval(-365 * 86_400), type: "b", cls: .audit),
            .init(eventId: EventID.derived(from: "c", at: now), ts: now, type: "c", cls: .audit),
        ])
        #expect(try queue.batch(limit: 10).map(\.type) == ["a", "b", "c"])
    }

    // MARK: - Census and eviction

    @Test("the census counts each class separately")
    func census() throws {
        let (queue, _) = try Self.temporaryQueue()
        try queue.enqueue(Self.rows(7, cls: .sample))
        try queue.enqueue(Self.rows(3, cls: .audit))
        let census = try queue.census()
        #expect(census.sampleCount == 7)
        #expect(census.auditCount == 3)
        #expect(census.totalBytes > 0)
    }

    /// ★ The plan says "samples first"; this proves the store obeys it.
    @Test("★ eviction takes the oldest samples and leaves every audit")
    func evictionTakesSamplesFirst() throws {
        let (queue, _) = try Self.temporaryQueue()
        try queue.enqueue(Self.rows(100, cls: .sample))
        try queue.enqueue(Self.rows(10, cls: .audit))

        let limits = QueuePolicy.Limits(maxEvents: 100, maxBytes: 1 << 30)
        let plan = QueuePolicy.plan(census: try queue.census(), limits: limits, now: Date())
        let evicted = try queue.evict(plan)

        #expect(evicted.counts[.audit] == nil)
        #expect((evicted.counts[.sample] ?? 0) > 0)
        #expect(try queue.census().auditCount == 10)
        // Oldest first: seq 0 must be gone, the newest sample must remain.
        let survivors = try queue.batch(limit: 500).filter { $0.cls == .sample }.map(\.seq)
        #expect(!survivors.contains(0))
        #expect(survivors.contains(99))
    }

    @Test("an age-based eviction removes exactly the rows past the cutoff")
    func evictionByAge() throws {
        let (queue, _) = try Self.temporaryQueue()
        try queue.enqueue(Self.rows(4, cls: .sample))
        let plan = QueuePolicy.Plan(evictions: [
            .init(cls: .sample, rows: 0, olderThan: Date().addingTimeInterval(60),
                  reason: "max_age_days")
        ])
        let evicted = try queue.evict(plan)
        #expect(evicted.counts[.sample] == 4)
        #expect(try queue.census().sampleCount == 0)
    }

    @Test("eviction reports the span of what it lost")
    func evictionReportsSpan() throws {
        let (queue, _) = try Self.temporaryQueue()
        try queue.enqueue(Self.rows(10, cls: .sample))
        let plan = QueuePolicy.Plan(evictions: [
            .init(cls: .sample, rows: 4, olderThan: nil, reason: "max_events")
        ])
        let evicted = try queue.evict(plan)
        #expect(evicted.total == 4)
        #expect(evicted.oldest != nil)
        #expect(evicted.newest != nil)
    }

    // MARK: - Meta

    @Test("meta survives a reopen")
    func metaPersists() throws {
        let (queue, path) = try Self.temporaryQueue()
        try queue.setMeta("etag", "abc123")
        try queue.setMeta("etag", "def456")
        #expect(try Queue(path: path).meta("etag") == "def456")
        #expect(try queue.meta("absent") == nil)
    }
}

import Foundation
import Testing

@testable import HPCCore

/// Two-class eviction. The rule under test throughout: **audit events are the
/// product**, samples are the raw material, and a gap is itself data.
struct QueuePolicyTests {

    static let t0 = Date(timeIntervalSince1970: 1_800_000_000)
    static let limits = QueuePolicy.Limits()

    static func evictions(_ plan: QueuePolicy.Plan, _ cls: QueuePolicy.Class)
        -> [QueuePolicy.Eviction]
    {
        plan.evictions.filter { $0.cls == cls }
    }

    // MARK: - Nothing to do

    @Test("an empty queue evicts nothing")
    func emptyQueue() {
        let plan = QueuePolicy.plan(census: .init(), limits: Self.limits, now: Self.t0)
        #expect(plan.isEmpty)
    }

    @Test("a queue inside every cap evicts nothing")
    func underCap() {
        let census = QueuePolicy.Census(
            sampleCount: 1_000, sampleBytes: 360_000, auditCount: 50, auditBytes: 18_000,
            oldestSampleAt: Self.t0.addingTimeInterval(-3_600),
            oldestAuditAt: Self.t0.addingTimeInterval(-3_600))
        let plan = QueuePolicy.plan(census: census, limits: Self.limits, now: Self.t0)
        #expect(plan.isEmpty)
    }

    // MARK: - ★ Samples go first, audits go last

    @Test("★ over the event cap, only samples are evicted")
    func samplesAbsorbTheOverrun() {
        let census = QueuePolicy.Census(
            sampleCount: 49_000, sampleBytes: 17_640_000,
            auditCount: 2_000, auditBytes: 720_000)
        let plan = QueuePolicy.plan(census: census, limits: Self.limits, now: Self.t0)

        #expect(Self.evictions(plan, .audit).isEmpty)
        let samples = Self.evictions(plan, .sample)
        #expect(samples.count == 1)
        // 51,000 rows against a 47,500 target (95 % of 50,000).
        #expect(samples[0].rows == 3_500)
    }

    /// ★ The floor. Reaching it means ~50,000 audit events and no successful
    /// sync — but a queue that refused writes would push back into the
    /// enforcer's spool, so the oldest audits go rather than the newest.
    @Test("★ audits are evicted only once every sample is already gone")
    func auditsAreTheFloor() {
        let census = QueuePolicy.Census(
            sampleCount: 0, sampleBytes: 0, auditCount: 60_000, auditBytes: 21_600_000)
        let plan = QueuePolicy.plan(census: census, limits: Self.limits, now: Self.t0)

        #expect(Self.evictions(plan, .sample).isEmpty)
        let audits = Self.evictions(plan, .audit)
        #expect(audits.count == 1)
        #expect(audits[0].rows == 12_500)
        #expect(audits[0].reason == "max_events_audit_floor")
    }

    @Test("a mixed queue drains samples fully before touching an audit")
    func samplesFirstThenAudits() {
        let census = QueuePolicy.Census(
            sampleCount: 1_000, sampleBytes: 360_000,
            auditCount: 55_000, auditBytes: 19_800_000)
        let plan = QueuePolicy.plan(census: census, limits: Self.limits, now: Self.t0)

        #expect(Self.evictions(plan, .sample).first?.rows == 1_000)
        #expect(Self.evictions(plan, .audit).first!.rows > 0)
    }

    // MARK: - Bytes

    @Test("the byte cap evicts even when the row count is fine")
    func byteCap() {
        // 20,000 samples at 2 KB each is 40 MB against a 32 MB cap.
        let census = QueuePolicy.Census(sampleCount: 20_000, sampleBytes: 40_000_000)
        let plan = QueuePolicy.plan(census: census, limits: Self.limits, now: Self.t0)
        let samples = Self.evictions(plan, .sample)
        #expect(samples.first?.reason == "max_bytes")
        #expect(samples.first!.rows > 0)
    }

    // MARK: - Age, and the two different ladders

    @Test("samples older than max_queue_age_days go, by date not by count")
    func sampleAge() {
        let census = QueuePolicy.Census(
            sampleCount: 100, sampleBytes: 36_000,
            oldestSampleAt: Self.t0.addingTimeInterval(-20 * 86_400))
        let plan = QueuePolicy.plan(census: census, limits: Self.limits, now: Self.t0)
        let eviction = Self.evictions(plan, .sample).first
        #expect(eviction?.reason == "max_age_days")
        #expect(eviction?.rows == 0)
        #expect(eviction?.olderThan != nil)
    }

    /// ★ 14 days for a sample, 90 for an audit. A three-week outage sheds
    /// usage detail and keeps every enforcement action.
    @Test("★ an audit the same age as an evicted sample survives")
    func auditOutlivesSample() {
        let twentyDaysAgo = Self.t0.addingTimeInterval(-20 * 86_400)
        let census = QueuePolicy.Census(
            sampleCount: 100, sampleBytes: 36_000, auditCount: 100, auditBytes: 36_000,
            oldestSampleAt: twentyDaysAgo, oldestAuditAt: twentyDaysAgo)
        let plan = QueuePolicy.plan(census: census, limits: Self.limits, now: Self.t0)

        #expect(Self.evictions(plan, .sample).count == 1)
        #expect(Self.evictions(plan, .audit).isEmpty)
    }

    @Test("audits do go once past audit_retention_days")
    func auditAge() {
        let census = QueuePolicy.Census(
            auditCount: 100, auditBytes: 36_000,
            oldestAuditAt: Self.t0.addingTimeInterval(-100 * 86_400))
        let plan = QueuePolicy.plan(census: census, limits: Self.limits, now: Self.t0)
        #expect(Self.evictions(plan, .audit).first?.reason == "audit_retention_days")
    }

    // MARK: - ★ Termination

    /// ★ The synthetic `queue.evicted` event is itself an audit event enqueued
    /// into the queue that was just full. Without headroom it triggers the
    /// next pass, which enqueues another. This proves the loop terminates.
    @Test("★ evicting to 95 % leaves room for the queue.evicted event itself")
    func evictionTerminates() {
        var census = QueuePolicy.Census(
            sampleCount: 51_000, sampleBytes: 18_360_000, auditCount: 0, auditBytes: 0)
        let plan = QueuePolicy.plan(census: census, limits: Self.limits, now: Self.t0)

        // Apply the plan, then enqueue the audit event that records it.
        for eviction in plan.evictions where eviction.cls == .sample {
            census.sampleCount -= eviction.rows
            census.sampleBytes -= eviction.rows * 360
        }
        census.auditCount += 1
        census.auditBytes += 360

        let second = QueuePolicy.plan(census: census, limits: Self.limits, now: Self.t0)
        #expect(second.isEmpty, "a second pass would mean the eviction event never survives")
    }

    @Test("the eviction event records the size and the span of the hole")
    func evictedEventShape() {
        let data = QueuePolicy.evictedEvent(
            counts: [.sample: 3_500, .audit: 0],
            oldestLost: Self.t0.addingTimeInterval(-7_200),
            newestLost: Self.t0, reason: "max_events")
        #expect(data["sample_events"] as? Int == 3_500)
        #expect(data["audit_events"] as? Int == 0)
        #expect(data["reason"] as? String == "max_events")
        #expect(data["oldest_lost_at"] != nil)
        #expect(data["newest_lost_at"] != nil)
    }
}

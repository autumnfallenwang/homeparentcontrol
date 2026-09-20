import Foundation

/// What to drop when `queue.sqlite` is full, and what to say about it.
///
/// ⚠️ §5.7's first honesty rule is the whole reason this is a *policy* with
/// tests rather than a `DELETE … LIMIT`:
///
/// > "**Gaps are data.** `queue.evicted` is projected into `enforcement_log`
/// > as a first-class row… **Zero usage and no data look identical on a bar
/// > chart and mean opposite things.**"
///
/// So an eviction is not a silent `DELETE`. It leaves a record *of the hole*,
/// and that record is itself an `audit` event which therefore survives the
/// next eviction pass.
public enum QueuePolicy {

    /// The two classes, in eviction order. The order is the design:
    /// `audit` events are what become `enforcement_log` rows — "THIS IS THE
    /// PRODUCT, what a parent means when they ask *but what actually
    /// happened?*" — while `sample` events are the raw material of a rollup
    /// that degrades gracefully when thinned.
    public enum Class: String, Equatable, Sendable, CaseIterable {
        case sample
        case audit
    }

    /// `telemetry.*` from the policy document. Defaults are §4.3's.
    public struct Limits: Equatable, Sendable {
        public var maxEvents: Int
        public var maxBytes: Int
        public var maxAgeDays: Int
        public var auditRetentionDays: Int

        public init(
            maxEvents: Int = 50_000,
            maxBytes: Int = 33_554_432,
            maxAgeDays: Int = 14,
            auditRetentionDays: Int = 90
        ) {
            self.maxEvents = maxEvents
            self.maxBytes = maxBytes
            self.maxAgeDays = maxAgeDays
            self.auditRetentionDays = auditRetentionDays
        }
    }

    /// ⚠️ **Hysteresis, and it is not decoration.**
    ///
    /// Eviction *triggers* at the cap and *evicts down to* 95 % of it. Those
    /// have to be two different numbers. The synthetic `queue.evicted` event
    /// is itself an event, enqueued into the queue that was just trimmed — so
    /// if the trigger and the target were both "the cap", every pass would
    /// evict, enqueue its receipt, land back on the cap, and evict again. One
    /// row per pass, for ever, each pass writing an audit event that says a
    /// row was lost.
    ///
    /// `QueuePolicyTests.evictionTerminates` is that loop written down: it
    /// applies a plan, enqueues the receipt, and asserts the second pass is
    /// empty. It failed against a single-threshold implementation, which is
    /// how the gap layer was found rather than assumed.
    public static let evictionHeadroom = 0.95

    /// A queue's shape, as the store can cheaply report it.
    public struct Census: Equatable, Sendable {
        public var sampleCount: Int
        public var sampleBytes: Int
        public var auditCount: Int
        public var auditBytes: Int
        /// Oldest row per class, for the age rule.
        public var oldestSampleAt: Date?
        public var oldestAuditAt: Date?

        public init(
            sampleCount: Int = 0, sampleBytes: Int = 0,
            auditCount: Int = 0, auditBytes: Int = 0,
            oldestSampleAt: Date? = nil, oldestAuditAt: Date? = nil
        ) {
            self.sampleCount = sampleCount
            self.sampleBytes = sampleBytes
            self.auditCount = auditCount
            self.auditBytes = auditBytes
            self.oldestSampleAt = oldestSampleAt
            self.oldestAuditAt = oldestAuditAt
        }

        public var totalCount: Int { sampleCount + auditCount }
        public var totalBytes: Int { sampleBytes + auditBytes }
    }

    /// One class's share of an eviction pass.
    public struct Eviction: Equatable, Sendable {
        public let cls: Class
        /// Delete this many rows, oldest first. Zero means "untouched".
        ///
        /// Named `rows`, not `count`: this is a quantity to delete, not the
        /// size of a collection, and calling it `count` invites both a reader
        /// and `empty_count` to mistake it for one.
        public let rows: Int
        /// Delete everything in this class older than here, regardless of count.
        public let olderThan: Date?
        public let reason: String

        public init(cls: Class, rows: Int, olderThan: Date?, reason: String) {
            self.cls = cls
            self.rows = rows
            self.olderThan = olderThan
            self.reason = reason
        }
    }

    public struct Plan: Equatable, Sendable {
        public let evictions: [Eviction]

        public init(evictions: [Eviction]) { self.evictions = evictions }
        public var isEmpty: Bool { evictions.allSatisfy { $0.rows == 0 && $0.olderThan == nil } }
    }

    /// Decide what to drop.
    ///
    /// Pure: a census, some limits and a clock in; a list of deletions out. No
    /// database, so the rule that `audit` is evicted last is provable without
    /// one.
    public static func plan(census: Census, limits: Limits, now: Date) -> Plan {
        var evictions: [Eviction] = []

        // ── 1. Age, per class, and the two ladders are different on purpose.
        //
        // `max_queue_age_days` (14) is a *queue* bound: a sample from three
        // weeks ago describes a rollup the server has long since computed
        // without it. `audit_retention_days` (90) is a *record* bound, and it
        // is deliberately longer than the queue bound so that a long outage
        // sheds usage detail while keeping every enforcement action.
        //
        // ⚠️ §5.7's retention invariant runs the other way and is the server's
        // to keep: RAW_SAMPLE_RETENTION_DAYS (90) must exceed this 14, or
        // events arrive, are stored, and are pruned before projection.
        if let oldest = census.oldestSampleAt {
            let cutoff = now.addingTimeInterval(-Double(limits.maxAgeDays) * 86_400)
            if oldest < cutoff {
                evictions.append(
                    Eviction(cls: .sample, rows: 0, olderThan: cutoff, reason: "max_age_days"))
            }
        }
        if let oldest = census.oldestAuditAt {
            let cutoff = now.addingTimeInterval(-Double(limits.auditRetentionDays) * 86_400)
            if oldest < cutoff {
                evictions.append(
                    Eviction(
                        cls: .audit, rows: 0, olderThan: cutoff, reason: "audit_retention_days"))
            }
        }

        // ── 2. Size and count. Samples absorb the whole overrun first.
        //
        // Trigger at the cap; evict down to the headroom target. See
        // `evictionHeadroom` for why those must not be the same number.
        let overCap = census.totalCount > limits.maxEvents || census.totalBytes > limits.maxBytes

        let countTarget = Int(Double(limits.maxEvents) * evictionHeadroom)
        let byteTarget = Int(Double(limits.maxBytes) * evictionHeadroom)

        var overCount = overCap ? max(0, census.totalCount - countTarget) : 0
        var overBytes = overCap ? max(0, census.totalBytes - byteTarget) : 0

        if overCount > 0 || overBytes > 0 {
            // Mean bytes per sample, to translate a byte overrun into rows.
            let sampleMean = census.sampleCount > 0
                ? max(1, census.sampleBytes / census.sampleCount) : 1
            let byRows = overCount
            let byBytes = overBytes > 0 ? Int(ceil(Double(overBytes) / Double(sampleMean))) : 0
            let fromSamples = min(census.sampleCount, max(byRows, byBytes))

            if fromSamples > 0 {
                evictions.append(
                    Eviction(
                        cls: .sample, rows: fromSamples, olderThan: nil,
                        reason: overBytes > 0 && byBytes >= byRows ? "max_bytes" : "max_events"))
                overCount -= min(overCount, fromSamples)
                overBytes -= min(overBytes, fromSamples * sampleMean)
            }

            // ── 3. Only now, and only if samples could not cover it.
            //
            // Reaching here means the queue is ~50,000 audit events — roughly
            // a year of enforcement actions with no successful sync. It is
            // nearly unreachable, and it is still better to drop the oldest
            // audits than to stop accepting new ones: a queue that refuses
            // writes would eventually push back into the enforcer's spool.
            if overCount > 0 || overBytes > 0 {
                let auditMean = census.auditCount > 0
                    ? max(1, census.auditBytes / census.auditCount) : 1
                let byBytes = overBytes > 0 ? Int(ceil(Double(overBytes) / Double(auditMean))) : 0
                let fromAudits = min(census.auditCount, max(overCount, byBytes))
                if fromAudits > 0 {
                    evictions.append(
                        Eviction(
                            cls: .audit, rows: fromAudits, olderThan: nil,
                            reason: "max_events_audit_floor"))
                }
            }
        }

        return Plan(evictions: evictions)
    }

    /// The `data` of the synthetic `queue.evicted` audit event (§5.7).
    ///
    /// ⚠️ This is enqueued as `class: "audit"`, which means it outlives the
    /// samples it is reporting on — the record of the hole must not be evicted
    /// by the same pressure that made the hole.
    public static func evictedEvent(
        counts: [Class: Int], oldestLost: Date?, newestLost: Date?, reason: String
    ) -> [String: Any] {
        var data: [String: Any] = [
            "reason": reason,
            "sample_events": counts[.sample] ?? 0,
            "audit_events": counts[.audit] ?? 0,
        ]
        let formatter = ISO8601DateFormatter()
        if let oldestLost { data["oldest_lost_at"] = formatter.string(from: oldestLost) }
        if let newestLost { data["newest_lost_at"] = formatter.string(from: newestLost) }
        return data
    }
}

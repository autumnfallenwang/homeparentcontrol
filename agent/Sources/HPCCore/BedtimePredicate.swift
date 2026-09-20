import Foundation

/// Is the Mac inside a restricted window right now?
///
/// ⚠️ **Steps 6 and 7 are a predicate, not a trigger, and that is the entire
/// DST answer.** A cron-style "fire at 21:30" is *skipped* on spring-forward
/// and *fires twice* on fall-back. A predicate asked every 60 seconds has
/// nothing to skip and nothing to repeat.
///
/// ⚠️ Wall-clock time of day, **never elapsed time**. "She has had two hours"
/// is a budget (D.4, deliberately unbuilt); "it is after 21:30" is a bedtime.
/// Only the second one is here.
public enum BedtimePredicate {

    /// What the tick concluded, and everything the ladder needs to act.
    public struct Evaluation: Equatable, Sendable {
        /// The window currently restricting, if any.
        public let activeWindow: PolicyDocument.Window?
        /// When the active window's restriction ends. Nil when outside one.
        public let restrictedUntil: Date?
        /// The next boundary the agent should shorten its poll for.
        public let nextBoundaryAt: Date?
        /// Warnings whose lead time has arrived but which have not yet fired.
        public let dueWarnings: [DueWarning]
        /// Minutes of relaxation applied, and by which grants — for the audit line.
        public let appliedOverrideIds: [String]

        public var isRestricted: Bool { activeWindow != nil }
    }

    public struct DueWarning: Equatable, Sendable {
        public let leadMinutes: Int
        public let channel: String
        public let windowId: String
        /// The instant this warning is *about* — the boundary, not the warning time.
        public let boundaryAt: Date
    }

    /// Evaluate the policy against a moment.
    ///
    /// Pure: two inputs, a document and a clock. No file access, no side
    /// effects, no network. Everything a golden file needs.
    public static func evaluate(policy: PolicyDocument, now: Date) -> Evaluation {
        let zone = policy.timezone
        guard let today = ZonedTime.localDay(of: now, zone: zone) else {
            // An unresolvable timezone. §4.6 class B — we cannot determine the
            // rules, so we must not lock. The caller raises `policy_corrupt`.
            return Evaluation(
                activeWindow: nil, restrictedUntil: nil, nextBoundaryAt: nil,
                dueWarnings: [], appliedOverrideIds: []
            )
        }

        // ⚠️ Yesterday too. A window that wraps midnight (21:30 → 07:00) is
        // still restricting at 02:00, and 02:00 belongs to *yesterday's*
        // window. Evaluating only today is the off-by-one-night bug the
        // `crosses_midnight` column exists to stop three people re-deriving.
        let days = [ZonedTime.day(today, plus: -1, zone: zone), today].compactMap { $0 }

        var active: PolicyDocument.Window?
        var activeEnd: Date?
        var appliedIds: [String] = []
        var boundaries: [Date] = []
        var due: [DueWarning] = []

        for window in policy.schedule.windows {
            for day in days {
                guard let span = resolve(window: window, on: day, zone: zone) else { continue }

                // §3.2 step 5 — effective rules are windows ∪ live overrides.
                let relaxed = applyOverrides(
                    to: span, window: window, day: day, policy: policy, now: now, zone: zone
                )

                // The predicate itself: [from, until). Half-open, so a window
                // ending 07:00 does not also restrict at exactly 07:00.
                if now >= relaxed.from && now < relaxed.until {
                    // Latest-ending window wins when two overlap: more
                    // restriction, never less.
                    if activeEnd == nil || relaxed.until > activeEnd! {
                        active = window
                        activeEnd = relaxed.until
                        appliedIds = relaxed.overrideIds
                    }
                }
                if relaxed.from > now { boundaries.append(relaxed.from) }

                // Warnings are computed in ABSOLUTE time: resolve the boundary
                // to an instant FIRST, then subtract minutes in UTC. Doing
                // "21:30" − 15 as strings and resolving afterwards fires an
                // hour early on transition night.
                for warning in window.warnings {
                    let at = relaxed.from.addingTimeInterval(-Double(warning.leadMinutes) * 60)
                    if at > now { boundaries.append(at) }
                    // Due within this tick's 60-second window, and not past
                    // the boundary itself.
                    if now >= at && now < relaxed.from {
                        due.append(
                            DueWarning(
                                leadMinutes: warning.leadMinutes,
                                channel: warning.channel,
                                windowId: window.id,
                                boundaryAt: relaxed.from
                            ))
                    }
                }
            }
        }

        return Evaluation(
            activeWindow: active,
            restrictedUntil: activeEnd,
            nextBoundaryAt: boundaries.filter { $0 > now }.min(),
            // Soonest first, so the ladder shows the most urgent.
            dueWarnings: due.sorted { $0.leadMinutes < $1.leadMinutes },
            appliedOverrideIds: appliedIds
        )
    }

    private struct Span {
        var from: Date
        var until: Date
        var overrideIds: [String] = []
    }

    /// One window on one local day, as instants. Nil when the window does not
    /// run that day.
    private static func resolve(
        window: PolicyDocument.Window, on day: DateComponents, zone: String
    ) -> Span? {
        guard let dayStart = ZonedTime.instant(
            day: day, at: ZonedTime.TimeOfDay(hour: 0, minute: 0), zone: zone,
            kind: .restrictedFrom
        ) else { return nil }
        guard let weekday = ZonedTime.weekday(of: dayStart, zone: zone),
              window.days.contains(weekday)
        else { return nil }

        guard let fromTime = ZonedTime.TimeOfDay(window.restrictedFrom),
              let untilTime = ZonedTime.TimeOfDay(window.restrictedUntil),
              let from = ZonedTime.instant(
                day: day, at: fromTime, zone: zone, kind: .restrictedFrom)
        else { return nil }

        // The wrap rule, derived once. A window whose end is not after its
        // start runs into the next local day.
        let wraps = untilTime.minutesSinceMidnight <= fromTime.minutesSinceMidnight
        let untilDay = wraps ? ZonedTime.day(day, plus: 1, zone: zone) : day
        guard let untilDay,
              let until = ZonedTime.instant(
                day: untilDay, at: untilTime, zone: zone, kind: .restrictedUntil)
        else { return nil }

        return Span(from: from, until: until)
    }

    /// Apply live relaxations. §4.6 / A.8 — every override carries a mandatory
    /// `expires_at`, so a stale policy can only ever converge *stricter*.
    private static func applyOverrides(
        to span: Span,
        window: PolicyDocument.Window,
        day: DateComponents,
        policy: PolicyDocument,
        now: Date,
        zone: String
    ) -> Span {
        var result = span

        for override in policy.overrides {
            // ⚠️ Expiry is checked HERE, on the agent, every tick — not only
            // by the server when it compiled. That is what makes a cached
            // policy safe to keep enforcing indefinitely.
            guard override.expiresAt > now else { continue }
            // Scoped to one window, or to all of them.
            if let target = override.windowId, target != window.id { continue }
            // Only the day it was granted for.
            guard let effective = isoDay(override.effectiveDate),
                  effective.year == day.year, effective.month == day.month,
                  effective.day == day.day
            else { continue }

            switch override.type {
            case "suspend":
                // No bedtime tonight. Collapse the window to nothing rather
                // than deleting it — the audit trail keeps the shape.
                result.until = result.from
                result.overrideIds.append(override.id)
            case "extend":
                if let minutes = override.minutes, minutes > 0 {
                    result.from = result.from.addingTimeInterval(Double(minutes) * 60)
                    // ⚠️ Do not push `until` out too. Extending bedtime by 30
                    // minutes means she starts later, not that she is locked
                    // out 30 minutes longer in the morning.
                    if result.from > result.until { result.from = result.until }
                    result.overrideIds.append(override.id)
                }
            default:
                // ⚠️ `grant_minutes` has no defined meaning anywhere in the
                // spec and needs elapsed accounting that D.4 defers. An
                // unknown type relaxes NOTHING — R5's degrade-safely applied
                // to the one field where guessing wrong leaves a Mac usable.
                continue
            }
        }
        return result
    }

    private static func isoDay(_ text: String) -> DateComponents? {
        let parts = text.split(separator: "-")
        guard parts.count == 3, let y = Int(parts[0]), let m = Int(parts[1]), let d = Int(parts[2])
        else { return nil }
        return DateComponents(year: y, month: m, day: d)
    }
}

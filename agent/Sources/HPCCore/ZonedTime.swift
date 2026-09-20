import Foundation

/// Resolving a policy's wall-clock times into instants, in the policy's own
/// IANA zone.
///
/// ⚠️ **A.30 — `policy.timezone` wins over the system timezone, always.** The
/// system zone is reported to the server and is never an input. A child who
/// changes the Mac's timezone must not move her own bedtime.
///
/// ⚠️ **Never cache a resolved instant across ticks.** `tzdata` changes by
/// government decree, and a daemon that runs for months will outlive a rule
/// change. Everything here recomputes from `(wall-clock string, zone name)`
/// every time it is called; nothing is memoised on purpose.
public enum ZonedTime {

    /// How an unresolvable wall-clock time should be nudged.
    ///
    /// ⚠️ §3.2: "a boundary in a skipped hour snaps forward to the first
    /// instant that exists; a boundary in an ambiguous hour resolves toward
    /// enforcement (earlier occurrence for `restricted_from`, later for
    /// `restricted_until`)."
    ///
    /// Both directions mean *more* restriction, never less — which is the
    /// only safe way to round a bedtime.
    public enum BoundaryKind {
        /// The start of a restricted window. Ambiguity resolves EARLIER.
        case restrictedFrom
        /// The end of a restricted window. Ambiguity resolves LATER.
        case restrictedUntil
    }

    /// A wall-clock time of day, `HH:MM`, as the policy carries it.
    public struct TimeOfDay: Equatable, Sendable {
        public let hour: Int
        public let minute: Int

        public init?(_ text: String) {
            let parts = text.split(separator: ":")
            guard parts.count >= 2,
                  let h = Int(parts[0]), let m = Int(parts[1]),
                  (0...23).contains(h), (0...59).contains(m)
            else { return nil }
            self.hour = h
            self.minute = m
        }

        public init(hour: Int, minute: Int) {
            self.hour = hour
            self.minute = minute
        }

        public var minutesSinceMidnight: Int { hour * 60 + minute }
    }

    /// Resolve `HH:MM` on a given local calendar day, in `zone`, to an instant.
    ///
    /// Returns `nil` only when the zone name itself is unknown — a typo'd
    /// timezone must be loud, not silently UTC. §5.6 never validates the zone
    /// server-side ("the agent owns that"), so this is where it surfaces.
    public static func instant(
        day: DateComponents,
        at time: TimeOfDay,
        zone zoneName: String,
        kind: BoundaryKind
    ) -> Date? {
        guard let zone = TimeZone(identifier: zoneName) else { return nil }

        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone

        var components = DateComponents()
        components.year = day.year
        components.month = day.month
        components.day = day.day
        components.hour = time.hour
        components.minute = time.minute
        components.second = 0

        guard let candidate = calendar.date(from: components) else { return nil }

        // Does the wall clock actually read what we asked for at that instant?
        // If not, this time does not exist — a spring-forward gap.
        let readsBack = calendar.dateComponents([.hour, .minute], from: candidate)
        let exists = readsBack.hour == time.hour && readsBack.minute == time.minute

        if !exists {
            // ⚠️ SKIPPED HOUR: snap FORWARD to the first instant that exists.
            // Foundation lands somewhere inside or before the gap; walk to the
            // far side. Restriction starting early is safe; starting late is
            // an hour of unenforced bedtime once a year.
            return firstInstantAfterGap(from: candidate, calendar: calendar, zone: zone)
        }

        // ⚠️ AMBIGUOUS HOUR (fall-back): the wall clock reads this twice.
        // Foundation returns the FIRST (pre-transition) occurrence.
        switch kind {
        case .restrictedFrom:
            // Earlier occurrence — restriction begins at the first chance.
            return candidate
        case .restrictedUntil:
            // Later occurrence — restriction ends at the last chance. If the
            // same wall clock reads again an hour on, prefer that one.
            let later = candidate.addingTimeInterval(3600)
            let laterReads = calendar.dateComponents([.hour, .minute], from: later)
            let repeats = laterReads.hour == time.hour && laterReads.minute == time.minute
            return repeats ? later : candidate
        }
    }

    /// Walk forward in one-minute steps to the first instant past a DST gap.
    /// A gap is at most a few hours anywhere on earth; 240 steps is ample.
    private static func firstInstantAfterGap(
        from start: Date,
        calendar: Calendar,
        zone: TimeZone
    ) -> Date {
        let before = zone.secondsFromGMT(for: start.addingTimeInterval(-60))
        var probe = start
        for _ in 0..<240 {
            if zone.secondsFromGMT(for: probe) != before { return probe }
            probe = probe.addingTimeInterval(60)
        }
        return start
    }

    /// The local calendar day `instant` falls on, in `zone`.
    public static func localDay(of instant: Date, zone zoneName: String) -> DateComponents? {
        guard let zone = TimeZone(identifier: zoneName) else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        return calendar.dateComponents([.year, .month, .day], from: instant)
    }

    /// `mon`…`sun` for a local day — the contract's weekday spelling.
    public static func weekday(of instant: Date, zone zoneName: String) -> String? {
        guard let zone = TimeZone(identifier: zoneName) else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        // Calendar's weekday is 1 = Sunday.
        let index = calendar.component(.weekday, from: instant)
        let names = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]
        return names[(index - 1) % 7]
    }

    /// Shift a local day by `days`, staying in the zone's calendar.
    public static func day(_ day: DateComponents, plus days: Int, zone zoneName: String)
        -> DateComponents?
    {
        guard let zone = TimeZone(identifier: zoneName) else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        guard let base = calendar.date(from: day),
              let shifted = calendar.date(byAdding: .day, value: days, to: base)
        else { return nil }
        return calendar.dateComponents([.year, .month, .day], from: shifted)
    }
}

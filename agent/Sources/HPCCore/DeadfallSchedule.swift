import Foundation

/// When the deadfall should wake up (§4.6, failure class A).
///
/// > "**The deadfall** closes class A. A `StartCalendarInterval` launchd job
/// > set to the current policy's earliest `restricted_from`, rewritten by the
/// > sync daemon whenever the schedule changes. It fires, **re-evaluates the
/// > full predicate itself — including `overrides[]`** — and locks. If both
/// > main daemons are dead, bedtime still happens."
///
/// ⚠️ **The timezone trap, which the one-line spec does not mention.**
/// `StartCalendarInterval` is evaluated in the machine's *system* timezone,
/// and A.30 says **the policy's timezone wins**. A child who sets the Mac to
/// Honolulu moves every naive calendar entry by hours — which is lever #8,
/// reachable from System Settings without admin.
///
/// The fix is to not emit wall-clock rules at all. This resolves each boundary
/// to an **instant** in the policy's zone, then renders that instant in the
/// system zone. A re-run every day keeps it true across a zone change, and
/// resolving instants individually makes DST fall out for free — the same
/// reason §3.2 made enforcement a predicate rather than a cron.
public enum DeadfallSchedule {

    /// One `StartCalendarInterval` entry.
    public struct Entry: Equatable, Sendable, Hashable {
        /// launchd's `Weekday`: 0 and 7 are both Sunday; we always emit 1–7
        /// with 7 for Sunday, since `Calendar`'s `weekday` is 1 = Sunday.
        public let weekday: Int
        public let hour: Int
        public let minute: Int
    }

    /// How far ahead to enumerate. A week covers every weekly schedule, and
    /// the sync daemon rewrites this daily, so the horizon only has to outlast
    /// one missed rewrite.
    public static let horizonDays = 8

    /// ⚠️ Fire again a few minutes after each boundary.
    ///
    /// launchd runs a missed `StartCalendarInterval` once on wake, not once
    /// per miss, and a Mac asleep across the boundary gets exactly one shot.
    /// The follow-ups cost two plist entries and buy three. They are safe
    /// because the deadfall is a *predicate*: a fire outside a restricted
    /// window does nothing at all.
    public static let followUpMinutes = [5, 20]

    /// Every wake-up the deadfall needs for the next `horizonDays`.
    ///
    /// Pure. `systemZone` is passed in rather than read from `TimeZone.current`
    /// so the zone-mismatch case is testable without touching the machine.
    public static func entries(
        policy: PolicyDocument, now: Date, systemZone: TimeZone
    ) -> [Entry] {
        var instants: Set<Date> = []

        guard var day = ZonedTime.localDay(of: now, zone: policy.timezone) else { return [] }

        for _ in 0..<horizonDays {
            for window in policy.schedule.windows {
                guard let start = ZonedTime.instant(
                    day: day, at: ZonedTime.TimeOfDay(hour: 0, minute: 0),
                    zone: policy.timezone, kind: .restrictedFrom),
                    let weekday = ZonedTime.weekday(of: start, zone: policy.timezone),
                    window.days.contains(weekday),
                    let from = ZonedTime.TimeOfDay(window.restrictedFrom),
                    let boundary = ZonedTime.instant(
                        day: day, at: from, zone: policy.timezone, kind: .restrictedFrom)
                else { continue }

                // ⚠️ Past boundaries are dropped, but overrides are NOT applied
                // here. A suspended window still gets a wake-up, because the
                // grant may be revoked before tonight and the deadfall
                // re-reads `overrides[]` when it fires. Scheduling is
                // permissive; *deciding* is the predicate's job, and only the
                // predicate's. Baking the override into the schedule would
                // make a stale plist into a bypass.
                guard boundary > now else { continue }
                instants.insert(boundary)
                for offset in followUpMinutes {
                    instants.insert(boundary.addingTimeInterval(Double(offset) * 60))
                }
            }
            guard let next = ZonedTime.day(day, plus: 1, zone: policy.timezone) else { break }
            day = next
        }

        // Render each instant in the SYSTEM zone — the only zone launchd reads.
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = systemZone

        var seen: Set<Entry> = []
        var result: [Entry] = []
        for instant in instants.sorted() {
            let parts = calendar.dateComponents([.weekday, .hour, .minute], from: instant)
            guard let weekday = parts.weekday, let hour = parts.hour, let minute = parts.minute
            else { continue }
            let entry = Entry(weekday: weekday, hour: hour, minute: minute)
            if seen.insert(entry).inserted { result.append(entry) }
        }
        return result
    }

    /// The full `com.hpc.deadfall` plist. Written by the sync daemon.
    ///
    /// `RunAtLoad` is false on purpose: the sync daemon rewrites this file on
    /// every policy change, and a `RunAtLoad` deadfall would evaluate — and
    /// possibly lock — at 14:00 on a Tuesday merely because a parent moved
    /// bedtime by five minutes.
    public static func plist(entries: [Entry], programPath: String) -> String {
        let intervals = entries.map { entry in
            """
                    <dict>
                        <key>Weekday</key><integer>\(entry.weekday)</integer>
                        <key>Hour</key><integer>\(entry.hour)</integer>
                        <key>Minute</key><integer>\(entry.minute)</integer>
                    </dict>
            """
        }.joined(separator: "\n")

        return """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" \
        "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <!-- GENERATED by com.hpc.sync from the active policy. Edits are lost. -->
        <plist version="1.0">
        <dict>
            <key>Label</key><string>com.hpc.deadfall</string>
            <key>ProgramArguments</key>
            <array><string>\(programPath)</string></array>
            <key>RunAtLoad</key><false/>
            <key>AbandonProcessGroup</key><false/>
            <key>StartCalendarInterval</key>
            <array>
        \(intervals)
            </array>
            <key>StandardErrorPath</key>
            <string>/var/log/homeparentcontrol/deadfall.log</string>
        </dict>
        </plist>

        """
    }
}

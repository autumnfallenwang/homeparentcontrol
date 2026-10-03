import Darwin
import Foundation
import HPCCore

/// The I/O around `TrustedClock`: reading the three clocks, and the two files
/// that carry trusted time between processes and across reboots (ADR 0015).
///
/// - `time.server.json` — written by **sync** after every sync, from the
///   response's `server_time`. The enforcer never talks to the network; it
///   reads this file the way it reads the policy.
/// - `time.state.json` — written by the **enforcer** every tick and on
///   SIGTERM (E.4: launchd delivers it at shutdown, so a change made in the
///   last minute before a restart is still on disk). Every other process
///   reads it and never writes it: one writer.
///
/// ✅ Measured on macOS 26.6.2, 2026-10-03 (`tools/verify/clock-tamper`):
/// every manual step showed at its exact size between two continuous-clock
/// samples; `kern.bootsessionuuid` did not move; a time-zone change moved
/// nothing. 📄 Not yet re-run on macOS 15.
public enum TimeBasis {

    private static let timebase: mach_timebase_info_data_t = {
        var info = mach_timebase_info_data_t()
        mach_timebase_info(&info)
        return info
    }()

    /// Seconds since boot, COUNTING sleep (A.32). Not `systemUptime`, which
    /// stops while the Mac sleeps and would read every morning as a step.
    public static func continuous() -> TimeInterval {
        Double(mach_continuous_time()) * Double(timebase.numer) / Double(timebase.denom) / 1e9
    }

    /// `kern.bootsessionuuid`: names this boot, and — unlike `kern.boottime` —
    /// does not move when the clock does.
    public static func bootSession() -> String {
        var size = 0
        guard sysctlbyname("kern.bootsessionuuid", nil, &size, nil, 0) == 0, size > 0 else {
            return "unknown"
        }
        var buffer = [CChar](repeating: 0, count: size)
        guard sysctlbyname("kern.bootsessionuuid", &buffer, &size, nil, 0) == 0 else {
            return "unknown"
        }
        return String(cString: buffer)
    }

    public static func reading() -> TrustedClock.Reading {
        TrustedClock.Reading(wall: Date(), continuous: continuous(), bootSession: bootSession())
    }

    // MARK: - Files

    private static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }()
    private static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()

    public static func loadState(path: String = Paths.timeState) -> TrustedClock.State {
        guard let data = FileManager.default.contents(atPath: path),
              let state = try? decoder.decode(TrustedClock.State.self, from: data)
        else { return TrustedClock.State() }
        return state
    }

    /// Swallowed on failure, like the spool: the decision is already taken.
    public static func saveState(_ state: TrustedClock.State, path: String = Paths.timeState) {
        guard let data = try? encoder.encode(state) else { return }
        try? data.write(to: URL(fileURLWithPath: path), options: .atomic)
    }

    public static func loadServerAnchor(path: String = Paths.timeServer) -> TrustedClock.Anchor? {
        guard let data = FileManager.default.contents(atPath: path) else { return nil }
        return try? decoder.decode(TrustedClock.Anchor.self, from: data)
    }

    public static func saveServerAnchor(
        _ anchor: TrustedClock.Anchor, path: String = Paths.timeServer
    ) {
        guard let data = try? encoder.encode(anchor) else { return }
        try? data.write(to: URL(fileURLWithPath: path), options: .atomic)
    }

    // MARK: - Resolving

    /// The last resolution this process made, for timestamps between ticks.
    public private(set) static var last: TrustedClock.Resolution?

    /// Resolve now. Only the enforcer passes `persist: true` — one writer.
    @discardableResult
    public static func resolve(persist: Bool = false) -> TrustedClock.Resolution {
        let resolution = TrustedClock.resolve(
            reading: reading(), server: loadServerAnchor(), state: loadState())
        if persist { saveState(resolution.state) }
        last = resolution
        return resolution
    }

    /// The trusted time, for anything that is not the enforcer's own tick:
    /// timestamps, expiries, ages. Cheap — a projection of the last
    /// resolution when there is one on this boot, a fresh resolution if not.
    public static func now() -> Date {
        let current = reading()
        if let last, let projected = last.state.anchor?.project(current) {
            return projected
        }
        return resolve().now
    }
}

import Darwin
import Foundation
import HPCAgentIO
import HPCCore

/// The sync daemon's half of trusted time (ADR 0015): it is the only process
/// that hears the server, so it writes the server's word to disk for the
/// enforcer — and, being root with nothing to enforce, it also puts the Mac's
/// clock right.
///
/// ⚠️ **Putting the clock right is a courtesy, never a dependency.** The
/// enforcer decides on trusted time whether or not the clock is ever fixed;
/// fixing it only makes the Mac's own clock, the deadfall's launchd schedule
/// and the child's menu bar agree with what is being enforced.
///
/// ✅ Measured 2026-10-03 on macOS 26.6.2: `systemsetup -setusingnetworktime
/// on` corrected a −600 s step within ~2 s; `settimeofday` from the API's
/// `server_time` landed within 0.3 s.
extension SyncDaemon {

    /// Past this, the Mac's clock is put back. The server's own threshold for
    /// `clock_skew` (`CLOCK_SKEW_LIMIT_MS`).
    static let correctAfter: TimeInterval = 60

    /// ⚠️ Hands off the clock for this long after this daemon starts.
    ///
    /// Found installing 0.2.0 on Ivy's Mac, 2026-10-03: the pkg's postinstall
    /// starts sync, sync fixed a clock 22 h fast within five seconds — and
    /// `/usr/sbin/installer`, which had not yet noticed the install was done,
    /// was waiting on a wall-clock timer that now ended 22 h later. It hung.
    /// Enforcement never waits for the fix, so waiting costs nothing.
    static let correctionGraceS: TimeInterval = 120

    static var lastNetworkTime: Bool?
    static var lastZone: String?
    static var lastDeadfallOffset: TimeInterval = 0
    static var offsetAtLastSync: TimeInterval = 0

    /// Trusted time, for every timestamp, expiry and age this daemon handles.
    static func now() -> Date { TimeBasis.now() }

    // MARK: - The server's word

    /// After a successful sync: pin the response's `server_time` to the
    /// continuous clock, so the enforcer can carry it forward offline.
    static func recordServerTime(
        _ response: [String: Any], sentAt: TimeInterval, receivedAt: TimeInterval
    ) {
        guard let text = response["server_time"] as? String,
              let serverTime = ISO8601DateFormatter.hpcParse(text)
        else { return }
        TimeBasis.saveServerAnchor(
            TrustedClock.serverAnchor(
                serverTime: serverTime, sentContinuous: sentAt, receivedContinuous: receivedAt,
                bootSession: TimeBasis.bootSession()))
    }

    // MARK: - Watching and fixing the Mac's clock

    /// Once per tick, after the sync attempt.
    static func superviseClock(_ clock: TrustedClock.Resolution, networkTime: Bool?) {
        let settled = TimeBasis.continuous() - startedContinuous >= correctionGraceS

        // ── 1. Automatic time turned off: the first step of the trick. Say so
        //       once, and turn it back on — macOS then fixes the clock itself.
        if networkTime == false {
            if lastNetworkTime != false {
                enqueueLocal(type: "clock.network_time_off", cls: .audit, data: [:])
            }
            if settled, turnOnNetworkTime() {
                enqueueLocal(
                    type: "clock.corrected", cls: .audit,
                    data: ["method": "network_time_on", "offset_s": Int(clock.offset.rounded())])
            }
        } else if settled, abs(clock.offset) > correctAfter, clock.source == .server,
                  clock.serverCorroborated
        {
            // ── 2. Automatic time is on (or unreadable) and the clock is still
            //       wrong — Apple unreachable, or someone faster than timed.
            //       Set it from our server, but only when the server agrees
            //       with what it told us before: never set a Mac's clock from
            //       a server that just changed its story.
            let target = clock.project(TimeBasis.reading())
            if setClock(to: target) {
                enqueueLocal(
                    type: "clock.corrected", cls: .audit,
                    data: ["method": "server_time", "offset_s": Int(clock.offset.rounded())])
            }
        }
        if let networkTime { lastNetworkTime = networkTime }

        // ── 3. Time zone. Changes nothing (A.30) but is worth a line: it is
        //       the trick a child tries first.
        let zone = currentZone()
        if let lastZone, lastZone != zone {
            enqueueLocal(
                type: "clock.timezone_changed", cls: .audit, data: ["from": lastZone, "to": zone])
        }
        lastZone = zone

        // ── 4. launchd fires the deadfall on the WALL clock: re-render it
        //       whenever the wall's error moves (`DeadfallSchedule.entries`).
        if abs(clock.offset - lastDeadfallOffset) > TrustedClock.tolerance {
            lastDeadfallOffset = clock.offset
            rewriteDeadfall()
        }
    }

    /// The `clock` block of the heartbeat (§4.2).
    static func clockBlock(_ policy: PolicyStore.Loaded?) -> [String: Any] {
        let clock = TimeBasis.last ?? TimeBasis.resolve()
        return [
            // ⚠️ The WALL clock, on purpose: the server measures the skew from
            // it against its own clock, independently of what we claim below.
            "local_utc": iso(Date()),
            "system_timezone": currentZone(),
            // ⚠️ A.30 — the POLICY's zone is the one that governs, and
            // reporting it separately is what lets the server notice the two
            // have diverged without the agent having to decide what that means.
            "policy_timezone": policy?.document.timezone ?? currentZone(),
            // Unreadable reports as on: an unknown must not page anyone.
            "using_network_time": lastNetworkTime ?? true,
            // ⚠️ Named "continuous" in the contract, and it is NOT — it is
            // uptime, which pauses in sleep, and the server's gap analysis
            // (asleep vs on-but-silent) and power-on detection depend on
            // exactly that. Trusted time uses the real continuous clock.
            "continuous_ns": ProcessInfo.processInfo.systemUptime * 1_000_000_000,
            "skew_estimate_ms": Int((clock.offset * 1000).rounded()),
            "stepped_since_last_sync": abs(clock.offset - offsetAtLastSync)
                > TrustedClock.tolerance,
        ]
    }

    /// `TimeZone.current` is cached for the life of a process; a daemon that
    /// never resets it reports the zone it started in for ever.
    static func currentZone() -> String {
        NSTimeZone.resetSystemTimeZone()
        return TimeZone.current.identifier
    }

    // MARK: - The three system calls

    /// `systemsetup -getusingnetworktime`. Nil when it cannot be read.
    /// 📄 V-NTP: needs root; from a LaunchDaemon without Full Disk Access it
    /// is unverified, which is why nil exists.
    static func usingNetworkTime() -> Bool? {
        let output = run("/usr/sbin/systemsetup", ["-getusingnetworktime"]) ?? ""
        if output.contains("Network Time: On") { return true }
        if output.contains("Network Time: Off") { return false }
        return nil
    }

    static func turnOnNetworkTime() -> Bool {
        _ = run("/usr/sbin/systemsetup", ["-setusingnetworktime", "on"])
        return usingNetworkTime() == true
    }

    /// `settimeofday(2)`. Root only, which this daemon is.
    static func setClock(to date: Date) -> Bool {
        let seconds = date.timeIntervalSince1970
        var value = timeval(
            tv_sec: time_t(seconds.rounded(.down)),
            tv_usec: suseconds_t((seconds - seconds.rounded(.down)) * 1_000_000))
        return settimeofday(&value, nil) == 0
    }

    /// A subprocess with a deadline on the continuous clock — a wall-clock
    /// deadline is exactly what a clock step breaks.
    static func run(_ path: String, _ args: [String], timeout: TimeInterval = 5) -> String? {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: path)
        task.arguments = args
        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = pipe
        guard (try? task.run()) != nil else { return nil }
        let deadline = TimeBasis.continuous() + timeout
        while task.isRunning && TimeBasis.continuous() < deadline { usleep(20_000) }
        if task.isRunning {
            task.terminate()
            return nil
        }
        return String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
    }
}

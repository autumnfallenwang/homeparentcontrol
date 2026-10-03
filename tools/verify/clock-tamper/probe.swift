// clock-tamper/probe.swift — watch the Mac's clocks once a second and say
// what a clock change looks like from inside a process. Read-only; no root.
//
//   swiftc -O tools/verify/clock-tamper/probe.swift -o /tmp/clock-probe
//   /tmp/clock-probe [seconds] [server-health-url] > probe.log
//
// Settles, on real hardware, what the time-basis design assumes:
//   Q1  a step shows as Δwall ≠ Δcontinuous within one sample
//   Q2  kern.boottime moves by exactly the step (BootTime.swift says so — 📄)
//   Q3  kern.bootsessionuuid does NOT move with the clock
//   Q4  sleep: continuous keeps counting, absolute (uptime) stops (A.32 — 📄)
//   Q5  a time-zone change moves nothing but the zone
//   Q6  the server's `server_time` measures the error to well under a second

import Darwin
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)

let duration = CommandLine.arguments.count > 1 ? Double(CommandLine.arguments[1])! : 3600
let healthURL = URL(string: CommandLine.arguments.count > 2
    ? CommandLine.arguments[2]
    : "http://homeparentcontrol-api.arch.internal/api/agent/v1/health")!

var timebase = mach_timebase_info_data_t()
mach_timebase_info(&timebase)
func seconds(_ ticks: UInt64) -> Double {
    Double(ticks) * Double(timebase.numer) / Double(timebase.denom) / 1e9
}

struct Sample {
    let wall: Double        // gettimeofday — what Date() returns
    let cont: Double        // mach_continuous_time — counts through sleep
    let abs: Double         // mach_absolute_time — stops in sleep (= systemUptime)
    let boottime: Double    // kern.boottime
    let session: String     // kern.bootsessionuuid
    let zone: String
}

func sysctlString(_ name: String) -> String {
    var size = 0
    sysctlbyname(name, nil, &size, nil, 0)
    var buf = [CChar](repeating: 0, count: max(size, 1))
    sysctlbyname(name, &buf, &size, nil, 0)
    return String(cString: buf)
}

func sample() -> Sample {
    var tv = timeval()
    var size = MemoryLayout<timeval>.stride
    sysctlbyname("kern.boottime", &tv, &size, nil, 0)
    NSTimeZone.resetSystemTimeZone()  // a daemon's TimeZone.current is cached otherwise
    return Sample(
        wall: Date().timeIntervalSince1970,
        cont: seconds(mach_continuous_time()),
        abs: seconds(mach_absolute_time()),
        boottime: Double(tv.tv_sec) + Double(tv.tv_usec) / 1e6,
        session: sysctlString("kern.bootsessionuuid"),
        zone: TimeZone.current.identifier)
}

/// Mac clock minus server clock, corrected for half the round trip.
func serverOffset() -> (offset: Double, rtt: Double)? {
    var request = URLRequest(url: healthURL)
    request.timeoutInterval = 3
    let sent = Date().timeIntervalSince1970
    let sentCont = seconds(mach_continuous_time())
    let done = DispatchSemaphore(value: 0)
    var body: Data?
    URLSession.shared.dataTask(with: request) { data, _, _ in body = data; done.signal() }.resume()
    guard done.wait(timeout: .now() + 4) == .success,
          let body,
          let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
          let text = json["server_time"] as? String
    else { return nil }
    let parser = ISO8601DateFormatter()
    parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    guard let server = parser.date(from: text)?.timeIntervalSince1970 else { return nil }
    // Measure the round trip on the continuous clock — a step mid-request must
    // not poison it — and place the server's instant at its midpoint.
    let rtt = seconds(mach_continuous_time()) - sentCont
    let localAtServer = sent + rtt / 2
    return (localAtServer - server, rtt)
}

func stamp(_ t: Double) -> String {
    let f = DateFormatter()
    f.dateFormat = "HH:mm:ss.SSS"
    f.timeZone = TimeZone(identifier: "America/New_York")
    return f.string(from: Date(timeIntervalSince1970: t))
}
func say(_ s: String) { print(s) }

let first = sample()
say("START wall=\(stamp(first.wall)) cont=\(String(format: "%.1f", first.cont))s "
    + "abs=\(String(format: "%.1f", first.abs))s session=\(first.session) zone=\(first.zone) "
    + "boottime=\(stamp(first.boottime))")
if let s = serverOffset() {
    say(String(format: "SERVER offset=%+.3fs rtt=%.3fs", s.offset, s.rtt))
}

var previous = first
var lastServerCheck = first.cont
while previous.cont - first.cont < duration {
    usleep(1_000_000)
    let now = sample()
    let dWall = now.wall - previous.wall
    let dCont = now.cont - previous.cont
    let dAbs = now.abs - previous.abs
    let step = dWall - dCont
    let bootMoved = now.boottime - previous.boottime

    if abs(step) > 0.5 {
        say(String(format: "STEP  at %@ (wall now %@): wall moved %+.1fs vs continuous; "
            + "kern.boottime moved %+.1fs; session %@", stamp(previous.wall + dCont),
            stamp(now.wall), step, bootMoved, now.session == previous.session ? "same" : "CHANGED"))
    } else if abs(bootMoved) > 0.5 {
        say(String(format: "BOOTTIME moved %+.1fs with no wall step", bootMoved))
    }
    if dCont - dAbs > 2 {
        say(String(format: "SLEEP for %.1fs: continuous +%.1fs, absolute +%.1fs, wall +%.1fs "
            + "(wall−continuous %+.1fs)", dCont - dAbs, dCont, dAbs, dWall, step))
    }
    if now.zone != previous.zone {
        say("ZONE  \(previous.zone) → \(now.zone); wall step \(String(format: "%+.2f", step))s")
    }
    if now.session != previous.session { say("SESSION changed (reboot?)") }

    // Every 10 s, and straight after anything happened, ask the server.
    if now.cont - lastServerCheck >= 10 || abs(step) > 0.5 {
        lastServerCheck = now.cont
        if let s = serverOffset() {
            let flag = abs(s.offset) > 30 ? "  ← CLOCK WRONG" : ""
            say(String(format: "SERVER %@ offset=%+.3fs rtt=%.3fs%@", stamp(now.wall), s.offset, s.rtt, flag))
        } else {
            say("SERVER \(stamp(now.wall)) unreachable")
        }
    }
    previous = now
}
say("END")

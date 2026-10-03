// clock-tamper/main.swift — POC: does moving the Mac's clock defeat bedtime,
// and which time basis stops it?
//
// Throwaway, like the rest of tools/verify. Compiled together with the REAL
// HPCCore sources, so the predicate and the ladder below are exactly the code
// the enforcer runs — only the clock fed to them differs.
//
//   swiftc -O agent/Sources/HPCCore/*.swift tools/verify/clock-tamper/main.swift \
//       -o /tmp/clock-sim && /tmp/clock-sim
//
// The model, per simulated second:
//   real   — true time (what the server knows)
//   wall   — real + offset; the offset is what the child changes
//   cont   — seconds since boot, INCLUDING sleep (mach_continuous_time);
//            reset by a reboot, untouched by any clock change
//
// Four ways for the enforcer to decide what "now" is:
//   today    — Date(). What ships.
//   mono     — anchored once per boot, then advanced by `cont`; a persisted
//              high-water mark catches a backwards step across a reboot. Offline.
//   server   — `mono`, re-anchored on every sync from the `server_time` the
//              API already returns (and the agent today ignores).
//   server+fix — `server`, and the sync daemon also puts the wall clock back.

import Foundation

// MARK: - Ivy's live schedule (policy v8, 2026-10-03), IDs replaced

let policyJSON = """
{"policy_version":8,"issued_at":"2026-10-01T12:00:00.000Z",
 "device_id":"00000000-0000-7000-8000-000000000001",
 "subject":{"child_id":"00000000-0000-7000-8000-000000000002","display_name":"Ivy"},
 "timezone":"America/New_York","overrides":[],
 "schedule":{"kind":"windows","windows":[
  {"id":"weekdays","label":"Weekdays","days":["mon","tue","wed","thu","sun"],
   "restricted_from":"23:45","restricted_until":"23:55","watch_until":"07:00","action":"shutdown",
   "action_options":{"shutdown_grace_s":300,"escalate_after_failures":3},
   "warnings":[{"channel":"banner","lead_minutes":30},{"channel":"banner","lead_minutes":15},
               {"channel":"modal","lead_minutes":5},{"channel":"modal","lead_minutes":1}]},
  {"id":"weekends","label":"Weekends","days":["fri","sat"],
   "restricted_from":"00:45","restricted_until":"00:55","watch_until":"07:00","action":"shutdown",
   "action_options":{"shutdown_grace_s":300,"escalate_after_failures":3},
   "warnings":[{"channel":"banner","lead_minutes":30},{"channel":"banner","lead_minutes":15},
               {"channel":"modal","lead_minutes":5},{"channel":"modal","lead_minutes":1}]}
 ]}}
"""
let policy = try! PolicyDocument.decode(from: Data(policyJSON.utf8))

let ny = TimeZone(identifier: "America/New_York")!
func at(_ s: String) -> Date {  // "2026-10-04 23:45:00" in New York
    let f = DateFormatter()
    f.timeZone = ny
    f.dateFormat = "yyyy-MM-dd HH:mm:ss"
    return f.date(from: s)!
}
func hm(_ d: Date?) -> String {
    guard let d else { return "—" }
    let f = DateFormatter()
    f.timeZone = ny
    f.dateFormat = "HH:mm:ss"
    return f.string(from: d)
}

// MARK: - Scenario script

enum Action {
    case shiftClock(TimeInterval)       // child moves the wall clock by Δ
    case setClock(String)               // child types a wall time ("yyyy-MM-dd HH:mm:ss")
    case reboot(offSeconds: TimeInterval)
    case wifi(Bool)
    case sleep(seconds: TimeInterval)   // lid closed: nothing runs, cont keeps counting
}

struct Scenario {
    let id: String
    let what: String
    let start: String
    let end: String
    let script: [(String, Action)]
}

// MARK: - Time bases

/// What persists on disk across an enforcer restart or a reboot.
struct Persisted {
    var highWater: Date?             // latest trusted instant ever used
    var anchor: (boot: Int, wall: Date, cont: TimeInterval)?
    /// wall − trusted at the last tick. The RTC keeps the child's change
    /// through a reboot, so the next boot starts from the same error.
    var lastOffset: TimeInterval = 0
}

enum Basis: String, CaseIterable { case today, mono, server, serverFix = "server+fix" }

/// ★ The candidate algorithm, kept pure so the agent can lift it as-is.
/// Returns the instant to enforce on, and whether the wall clock disagrees.
func trustedNow(
    basis: Basis, wall: Date, cont: TimeInterval, boot: Int,
    serverAnchor: (boot: Int, utc: Date, cont: TimeInterval)?,
    store: inout Persisted
) -> (now: Date, stepped: Bool) {
    if basis == .today { return (wall, false) }

    // 1. The server's word, carried forward by the monotonic clock.
    func settle(_ now: Date) -> (now: Date, stepped: Bool) {
        store.highWater = max(store.highWater ?? now, now)
        store.lastOffset = wall.timeIntervalSince(now)
        return (now, abs(store.lastOffset) > 30)
    }
    if basis != .mono, let s = serverAnchor, s.boot == boot {
        let now = s.utc.addingTimeInterval(cont - s.cont)
        store.anchor = (boot, now, cont)
        return settle(now)
    }
    // 2. Same boot, no server: our own anchor, carried forward.
    if let a = store.anchor, a.boot == boot {
        return settle(a.wall.addingTimeInterval(cont - a.cont))
    }
    // 3. A new boot and nothing heard yet. Assume the error we last measured
    //    survived in the RTC; and time never runs backwards across a reboot,
    //    so never start behind the high-water mark.
    var now = wall.addingTimeInterval(-store.lastOffset)
    if let hw = store.highWater, now < hw { now = hw }
    store.anchor = (boot, now, cont)
    return settle(now)
}

// MARK: - The run

struct Outcome {
    var firstWarning: Date?
    var firstLock: Date?
    var shutdown: Date?
    var detected: Date?
    var corrections = 0
}

func run(_ sc: Scenario, basis: Basis) -> Outcome {
    var real = at(sc.start)
    let end = at(sc.end)
    var offset: TimeInterval = 0
    var cont: TimeInterval = 4 * 3600      // booted at ~19:45
    var boot = 1
    var online = true
    var store = Persisted()
    var serverAnchor: (boot: Int, utc: Date, cont: TimeInterval)?
    var ladder = Ladder.State()
    var pending: (Int, Ladder.WarningOutcome)?
    var out = Outcome()
    var poweredOffUntil: Date?
    var asleepUntil: Date?
    var script = sc.script.map { (at($0.0), $0.1) }
    var tickPhase: TimeInterval = 4         // enforcer ticks at :04, like Ivy's
    var syncPhase: TimeInterval = 34        // sync lands ~30 s later

    while real <= end {
        // Child's actions due at this second.
        while let (when, action) = script.first, when <= real {
            script.removeFirst()
            switch action {
            case .shiftClock(let d): offset += d
            case .setClock(let s): offset = at(s).timeIntervalSince(real)
            case .wifi(let on): online = on
            case .sleep(let s): asleepUntil = real.addingTimeInterval(s)
            case .reboot(let off):
                poweredOffUntil = real.addingTimeInterval(off)
            }
        }
        if let until = poweredOffUntil {
            if real < until { real += 1; continue }
            // Boot: new kernel session, new processes. The RTC kept the wall
            // offset (macOS writes the system clock back to it).
            poweredOffUntil = nil
            boot += 1
            cont = 0
            serverAnchor = nil
            ladder = Ladder.State()
            pending = nil
            tickPhase = 20                  // agent up ~20 s after power-on
            syncPhase = 35
        }
        if let until = asleepUntil {
            if real < until { real += 1; cont += 1; continue }
            asleepUntil = nil
        }
        let wall = real.addingTimeInterval(offset)
        let second = Int(real.timeIntervalSince1970) % 60

        // Sync daemon: hears server_time; maybe corrects the wall clock.
        if online, second == Int(syncPhase) % 60 {
            serverAnchor = (boot, real, cont)
            if basis == .serverFix, abs(offset) > 60 {
                offset = 0
                out.corrections += 1
                if out.detected == nil { out.detected = real }
            }
        }

        // Enforcer tick.
        if second == Int(tickPhase) % 60 {
            let (now, stepped) = trustedNow(
                basis: basis, wall: wall, cont: cont, boot: boot,
                serverAnchor: serverAnchor, store: &store)
            if stepped, out.detected == nil { out.detected = real }
            let evaluation = BedtimePredicate.evaluate(policy: policy, now: now)
            let step = Ladder.step(
                evaluation: evaluation, state: ladder, now: now, previousWarning: pending)
            ladder = step.state
            pending = nil
            for effect in step.effects {
                switch effect {
                case .deliverWarning(let lead, _, _, _):
                    out.firstWarning = out.firstWarning ?? real
                    pending = (lead, .delivered)
                case .lock:
                    out.firstLock = out.firstLock ?? real
                case .shutdown:
                    out.shutdown = real
                case .audit:
                    break
                }
            }
            if out.shutdown != nil { break }
        }
        real += 1
        cont += 1
    }
    return out
}

// MARK: - The matrix

// Sunday 4 Oct: the weekday window, 23:45–23:55, shutdown after 300 s.
let sun = "2026-10-04"
let late = "2026-10-05 03:00:00"   // past every window, grace, and a 2-hour step
let scenarios: [Scenario] = [
    Scenario(id: "S0", what: "no tampering (control)", start: "\(sun) 23:00:00", end: late,
             script: []),
    Scenario(id: "S1", what: "TONIGHT, replayed: 00:00 → \"Sat 23:00\", then back 1 h at 00:55",
             start: "2026-10-02 23:50:00", end: "2026-10-03 01:30:00",
             script: [("2026-10-03 00:00:30", .setClock("2026-10-03 23:00:24")),
                      ("2026-10-03 00:55:00", .shiftClock(-3600))]),
    Scenario(id: "S2", what: "T−30: back 2 h at 23:15", start: "\(sun) 23:00:00", end: late,
             script: [("\(sun) 23:15:00", .shiftClock(-7200))]),
    Scenario(id: "S3", what: "T−10: back 30 min at 23:35", start: "\(sun) 23:00:00", end: late,
             script: [("\(sun) 23:35:00", .shiftClock(-1800))]),
    Scenario(id: "S4", what: "T−5: back 10 min at 23:40 (in the 5-min modal)", start: "\(sun) 23:00:00",
             end: late, script: [("\(sun) 23:40:00", .shiftClock(-600))]),
    Scenario(id: "S5", what: "T−1: back 5 min at 23:44", start: "\(sun) 23:00:00", end: late,
             script: [("\(sun) 23:44:10", .shiftClock(-300))]),
    Scenario(id: "S6", what: "after the lock, in the 5-min grace: back 1 h at 23:47", start: "\(sun) 23:00:00",
             end: late, script: [("\(sun) 23:47:00", .shiftClock(-3600))]),
    Scenario(id: "S7", what: "FORWARD past the window end: 23:46 → 23:56", start: "\(sun) 23:00:00",
             end: late, script: [("\(sun) 23:46:00", .shiftClock(600))]),
    Scenario(id: "S8", what: "back 2 h at 23:30, then restart the Mac", start: "\(sun) 23:00:00",
             end: late,
             script: [("\(sun) 23:30:00", .shiftClock(-7200)), ("\(sun) 23:31:00", .reboot(offSeconds: 60))]),
    Scenario(id: "S9", what: "Wi-Fi off 23:20, back 2 h at 23:30", start: "\(sun) 23:00:00", end: late,
             script: [("\(sun) 23:20:00", .wifi(false)), ("\(sun) 23:30:00", .shiftClock(-7200))]),
    Scenario(id: "S10", what: "Wi-Fi off, back 2 h, restart", start: "\(sun) 23:00:00", end: late,
             script: [("\(sun) 23:20:00", .wifi(false)), ("\(sun) 23:30:00", .shiftClock(-7200)),
                      ("\(sun) 23:31:00", .reboot(offSeconds: 60))]),
    Scenario(id: "S11", what: "Wi-Fi off, FORWARD to 23:57 at 23:43, restart", start: "\(sun) 23:00:00",
             end: late,
             script: [("\(sun) 23:20:00", .wifi(false)), ("\(sun) 23:43:00", .shiftClock(840)),
                      ("\(sun) 23:43:30", .reboot(offSeconds: 30))]),
    Scenario(id: "S12", what: "creep: back 25 s every minute from 23:00 (needs a script)",
             start: "\(sun) 23:00:00", end: late,
             script: (0..<45).map { m in
                 (String(format: "\(sun) 23:%02d:40", m), Action.shiftClock(-25)) }),
    Scenario(id: "S13", what: "lid closed 23:30–23:50, no tampering", start: "\(sun) 23:00:00",
             end: late, script: [("\(sun) 23:30:00", .sleep(seconds: 1200))]),
]

/// Against the same night with nobody touching anything.
func cell(_ o: Outcome, due: Date) -> String {
    guard let off = o.shutdown else {
        return o.firstLock != nil ? "NEVER OFF (lock)" : "NEVER OFF"
    }
    let minutes = Int((off.timeIntervalSince(due) / 60).rounded())
    return minutes <= 0 ? "OFF on time" : "OFF \(minutes)m late"
}

print("Ivy's schedule: weekdays 23:45–23:55, Fri/Sat 00:45–00:55; lock, then shutdown after 300 s.")
print("Times are REAL time (America/New_York). 'OFF' = the Mac shut down; 'late' is against the same")
print("night untouched (23:50, or 00:50 on Fri/Sat).\n")
let pad = { (s: String, n: Int) in s.padding(toLength: n, withPad: " ", startingAt: 0) }
print(pad("", 5) + pad("scenario", 62) + Basis.allCases.map { pad($0.rawValue, 18) }.joined())
for sc in scenarios {
    let control = Scenario(id: "", what: "", start: sc.start, end: sc.end, script: [])
    let due = run(control, basis: .today).shutdown!
    let outs = Basis.allCases.map { run(sc, basis: $0) }
    print(pad(sc.id, 5) + pad(sc.what, 62) + outs.map { pad(cell($0, due: due), 18) }.joined())
}

print("\nDetail for the recommended basis (server+fix):")
for sc in scenarios {
    let o = run(sc, basis: .serverFix)
    let mono = run(sc, basis: .mono)
    print("  \(pad(sc.id, 4)) warn \(hm(o.firstWarning))  lock \(hm(o.firstLock))  off \(hm(o.shutdown))"
          + "  stepped-seen \(hm(o.detected)) (offline-only basis: \(hm(mono.detected)))"
          + "  clock put back ×\(o.corrections)")
}

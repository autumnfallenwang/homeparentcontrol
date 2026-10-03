---
name: macos-clocks
description: What a clock change looks like from inside a macOS process — measured 2026-10-03 on 26.6.2
metadata:
  type: reference
---

Measured with `tools/verify/clock-tamper/probe.swift` + `hw-test.sh` on macOS 26.6.2 (✅), eight
manual steps of −1800 to +600 s. 📄 Not yet re-run on macOS 15 (Ivy's Mac mini is 15.6.1).

| Clock | Moves with a manual step? | Counts sleep? | Use it for |
|---|---|---|---|
| `Date()` / `gettimeofday` | yes — the child's | yes | nothing that decides |
| `mach_continuous_time` | **no** | **yes** | trusted time, intervals, deadlines |
| `mach_absolute_time` = `ProcessInfo.systemUptime` | no | **no** — pauses | "how long awake" (the server's gap analysis) |
| `kern.boottime` | **yes, by exactly the step** (to 0.1 s) | — | a second step detector; never a boot id |
| `kern.bootsessionuuid` | no | — | which boot a continuous reading belongs to |

- `kern.boottime + mach_continuous_time = wall`, to 7 s over a 4.1-day boot with 51.6 h asleep —
  i.e. the continuous clock drifts ~1.7 s/day against an NTP-disciplined wall. Re-anchor, or a
  week offline reads as a step.
- A **time-zone change moves nothing** but the zone (0.00 s). `TimeZone.current` is cached for the
  life of a process: call `NSTimeZone.resetSystemTimeZone()` first or a daemon reports the zone it
  started in for ever.
- Fixing a moved clock, as root: `systemsetup -setusingnetworktime on` → corrected within **~2 s**;
  `sntp -sS time.apple.com` → immediate, ±1 ms; `settimeofday` from our API's `server_time` → ±0.3 s,
  LAN only. `sntp time.apple.com` *without* `-sS` queries without root.
- Date & Time needs group `admin` (`security authorizationdb read system.preferences.datetime`); a
  standard account cannot change the clock.
- `pmset sleepnow` from a root shell was refused with the display on (no sleep in the probe) — test
  sleep by closing the lid, or trust the boottime arithmetic above.

See [[never-trust-the-wall-clock]], [[verify-macos-claims]], [[launchd-on-a-real-mac]].

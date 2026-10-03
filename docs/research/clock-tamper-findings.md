# Clock tampering — incident, POC and findings (2026-10-03)

> Evidence classes as in [[verify-macos-claims]]: ✅ observed directly · 📄 documented only · ⚖️ judgement.
> Hardware results are **macOS 26.6.2** (this MacBook). **Ivy's Mac mini runs macOS 15.6.1**, not
> the 26.x §8.2 assumed — the primitives below exist there too, but none was re-run on it.

## 1. What happened (✅ from the server's own records)

Ivy's schedule: shutdown windows 23:45–23:55 Sun–Thu and 00:45–00:55 Fri/Sat, 300 s grace.

| Real time (EDT) | Her Mac's clock | Evidence |
|---|---|---|
| 00:00:04 | 00:00:04 | last `app.usage_sample` with a true `ts` (Chrome) |
| ~00:00:30 | **Sat 23:00** (+23 h) | `enforcement.evaluated {source: deadfall, restricted: false}` stamped 23:00:24; `clock_skew` tripwire first seen 00:00:34 |
| 00:45 | ~23:45 | **no lock, no shutdown.** Chrome active every minute through the window |
| ~00:55 | moved back 1 h (net +22 h) | tripwire `skew_ms` 79 194 311; samples stop arriving at 00:54:44 |
| 01:47 | still +22 h | still checking in; `clock_skew` ×84 — and nobody was told (no alert channel, C6) |

The server measured the skew correctly on every sync (`sync.ts`, 2026-09-28 fix). The agent did not:
`enforcerd` step 4 "clock sanity" exists only as a comment, and `BedtimePredicate` is fed raw
`Date()`. The `server_time` the API returns on every sync is never read by the agent.

## 2. Simulation — real `BedtimePredicate` + `Ladder`, Ivy's real schedule

`tools/verify/clock-tamper/main.swift`, compiled with `agent/Sources/HPCCore/*.swift`. Four time
bases; "late" is against the same night untouched.

| | Child's move | **today** (`Date()`) | mono | server | server+fix |
|---|---|---|---|---|---|
| S0 | none (control) | on time | on time | on time | on time |
| S1 | **tonight, replayed** | **never off** | on time | on time | on time |
| S2 | T−30: back 2 h | 120 m late | on time | on time | on time |
| S3 | T−10: back 30 min | 30 m late | on time | on time | on time |
| S4 | T−5 (in the modal): back 10 min | 10 m late | on time | on time | on time |
| S5 | T−1: back 5 min | 5 m late | on time | on time | on time |
| S6 | after the lock, in grace: back 1 h | 60 m late | on time | on time | on time |
| S7 | **forward** past the window end | **never off** (locked 1 min) | on time | on time | on time |
| S8 | back 2 h, then restart | 120 m late | on time | on time | on time |
| S9 | Wi-Fi off, back 2 h | 120 m late | on time | on time | on time |
| S10 | Wi-Fi off, back 2 h, restart | 120 m late | on time | on time | on time |
| S11 | Wi-Fi off, forward, restart | never off | on time¹ | on time¹ | on time¹ |
| S12 | creep 25 s/min (scripted) | 19 m late | on time | on time | on time |
| S13 | lid closed 23:30–23:50, **no tampering** | never off | never off | never off | never off |

- **mono** — anchor once per boot, advance by `mach_continuous_time`; persisted high-water mark.
- **server** — mono, re-anchored from `server_time` on every sync.
- **server+fix** — server, and the sync daemon puts the wall clock back.
- ¹ Only after adding **offset carry-over**: persist `wall − trusted`, re-apply it after a reboot
  (the RTC keeps the child's change). Without it, S11 beat every basis.
- **S13 is not a clock bug** but the same short window: an episode that starts after 23:50 never
  reaches its 300 s grace before 23:55, so it only locks. ⚖️ A separate decision.

## 3. Hardware — `tools/verify/clock-tamper/{probe.swift,hw-test.sh}`, this MacBook

| # | Question | Result |
|---|---|---|
| Q1 | A step shows as Δwall ≠ Δcontinuous within one sample | ✅ all 8 steps (−1800, −600, −301, +600 s and their fixes), exact to 0.1 s |
| Q2 | `kern.boottime` moves by exactly the step | ✅ every step, to 0.1 s. `BootTime.swift`'s comment holds — a second, restart-proof detector |
| Q3 | `kern.bootsessionuuid` survives a step | ✅ unchanged — usable as the boot identity |
| Q4 | `mach_continuous_time` counts sleep | ✅ indirectly: over a 4.1-day boot, continuous − absolute = 51.6 h (sleep), and `boottime + continuous = wall` to 7 s (≈1.7 s/day drift). The forced-sleep test did not sleep (`pmset sleepnow` refused; no gap in the probe) |
| Q5 | A time-zone change moves `Date()` | ✅ no — 0.00 s. A.30 already makes zone changes harmless |
| Q6 | `server_time` measures the error | ✅ to ~0.1 s **on a non-cached request.** ⚠️ `URLSession` served a *cached* `GET /health` after every backwards step (rtt 1 ms, error = age of the cache). The sync is a POST and is not cached; `/health` should send `Cache-Control: no-store` |
| C1 | Fix: `sntp -sS time.apple.com` (root) | ✅ immediate, ±1 ms. Needs the internet |
| C2 | Fix: `systemsetup -setusingnetworktime on` (root) | ✅ **timed corrected a −600 s step within ~2 s** |
| C3 | Fix: `settimeofday` from our `server_time` | ✅ ±0.3 s (whole seconds in the POC). LAN only — works with the internet down |
| C4 | Read the setting: `systemsetup -getusingnetworktime` | ✅ as root from a sudo shell. From a LaunchDaemon without FDA (V-NTP) still unverified |
| S | Server-side `clock_skew` | ✅ raised for this Mac from one sync inside a 4-second step |
| A | Who may change Date & Time | 📄 `system.preferences.datetime`: authenticate as group `admin`. A standard account cannot |

## 4. Secondary bugs the incident exposed (✅ code + data)

- **Usage upload stalls after a backwards step.** `flushEventsIfDue` compares `Date()` with
  `lastEventFlush`; after −1 h it waits an hour. Tonight: nothing since 00:54:44.
- **A forward jump can delete the queue.** `QueuePolicy` evicts samples older than 14 days by
  `Date()` — a +15-day step erases unsent usage.
- **Every other expiry is on the wall clock too:** override `expires_at`, the kill switch's `until`,
  the shadow-mode deadline — stepping back stretches each. The deadfall's `StartCalendarInterval`
  fires on wall time, so it is late by the step as well.
- `clock` block on `/sync`: `using_network_time: true` and `skew_estimate_ms: 0` are hard-coded;
  `continuous_ns` is really `systemUptime` (pauses in sleep).

## 5. What was built

[ADR 0015](../adr/0015-trusted-time.md), milestone 07. One correction to the design above, found
while building it: **our own reckoning only outvotes the server once the server has confirmed it.**
On a fresh install over a clock already wrong (Ivy's, +22 h, at the time of writing) the first tick
can only take the wall, and an anchor seeded from the wall is a copy of it — "wall and own agree"
would have outvoted the server for ever. `TrustedClockTests.freshInstallOnWrongClock` pins it, and
fails when the rule is removed.

## 6. Residual, after the fix

- She has admin: `launchctl bootout`, the kill switch, `sudo` anything — AR.1, unchanged. Making her
  a standard user also takes Date & Time away from her (row A).
- Offline **and** a step in the ≤60 s between the enforcer's last tick and a restart. Closed by
  writing the offset on SIGTERM (E.4: launchd delivers it at shutdown).
- A step made outside macOS (Recovery) before an offline boot. ⚖️ Out of scope.

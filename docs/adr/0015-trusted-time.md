# 0015 — Trusted time: enforce on two of three clocks, and flag the moves around the rules

- **Status:** accepted
- **Date:** 2026-10-03
- **Deciders:** Aaron Wang

## Context

At 00:00:30 on Saturday 3 October, Ivy set her Mac's clock to "Saturday 23:00" — 23 hours ahead. The
00:45 shutdown never came: she used Chrome straight through it. The server raised `clock_skew` 84
times, and no one was told (C6, no alert channel).

The design had this covered on paper. §3.2 step 4 is "clock sanity — |Δrealtime − Δcontinuous| >
30 s ⇒ clock.stepped; prefer the monotonic projection from the last server_time", and §4.6 class E is
"fail-closed on the last trusted time basis". **None of it was built.** `BedtimePredicate` was fed
`Date()`, the agent never read the `server_time` every sync returns, and the deadfall, the kill
switch's `until`, the shadow soak's deadline, the event flush timer and the queue's age cutoff all ran
on the wall clock too. The child has admin (AR.1), and Date & Time needs nothing more.

The trick also blinded the parent's review list (ADR 0014): watch hours judge each event by the
agent's `ts`, and her events were stamped with the hour she had chosen.

The POC (`docs/research/clock-tamper-findings.md`) ran 13 tampering scenarios through the real
predicate and ladder, and probed the clocks on hardware. Every manual step showed up at its exact size
as wall vs `mach_continuous_time`; `kern.bootsessionuuid` did not move; a time-zone change moved
nothing; `systemsetup -setusingnetworktime on` fixed a −600 s step in ~2 s.

The owner's constraint: enforcement must keep working **without the server** — fail-closed on
knowledge (§4.6) is the whole design.

## Decision

1. **Every enforcement decision runs on trusted time** (`TrustedClock`, pure, in `HPCCore`). Three
   witnesses, and **two must agree**:
   - the **wall** clock, which the child sets;
   - the **server**'s `server_time` from the last sync, carried forward on the continuous clock;
   - **our own** last trusted instant, carried forward on the continuous clock — across a reboot,
     the last measured error re-applied (the RTC keeps her change), never behind a high-water mark.

   Server + own agree → server (tonight). Wall + own agree → our own, and the server is **outvoted**:
   a bug on our server cannot cause a wrongful lockout, the worst failure §4.6 names. Offline, own
   beats a moved wall. ⚠️ **Own only outvotes the server once the server has confirmed it** — a
   reckoning seeded from the wall is a copy of the wall, and on a fresh install over a wrong clock
   it would otherwise outvote the truth for ever (caught in design; pinned by a test).
2. **The enforcer stays network-free.** Sync writes the server's word to `time.server.json`; the
   enforcer reads it like the policy, and writes `time.state.json` every tick and on SIGTERM (E.4),
   so a change made just before a restart survives it. One writer per file.
3. **Everything that compares against "now" uses it**: predicate, ladder, kill-switch expiry, shadow
   deadline, spool and health timestamps, the supervisor's staleness, the deadfall — whose launchd
   entries are rendered at the *wall* time that will read when each instant really arrives — event
   timestamps, the queue's age cutoff, credential rotation. Intervals (the flush timer, subprocess
   deadlines) use the continuous clock.
4. **Sync puts the clock right, as a courtesy.** Automatic time off → turn it back on. Still wrong by
   more than 60 s → `settimeofday` from the server, **only when the server agrees with what it said
   before**. Enforcement never depends on this.
5. **The review list gains the moves around the rules, red at any hour:** the clock set away from the
   real time (`clock.stepped`), "Set time automatically" turned off, the time zone changed, and — the
   catch-all — **the Mac in use during bedtime after it should already have been off or locked**,
   from unlocked `session_spans`, two minutes past the shutdown (or lock) being due.

## Consequences

- The 13 scenarios — tonight's exact moves, back 30/10/5/1 min before bedtime, back during the grace,
  forward past the window, with a restart, with Wi-Fi off, a 25 s/min creep — all shut down on time,
  with or without the server. `ClockTamperScenarioTests` asserts it, and asserts the old agent fails.
- Residual, offline only: no state at all (a first boot) on a clock already wrong; a creep slower than
  2 s a tick; a change made outside macOS. The server flags each when the Mac next connects.
- `continuous_ns` on the wire stays **uptime** (pauses in sleep): the server's asleep-vs-silent gap
  analysis and power-on detection depend on exactly that. Its name is wrong; changing its meaning
  would turn every night's sleep red.
- The Reports card "After bedtime" becomes **Flagged**: the count now includes the new rows.
- Reaches a Mac only on reinstall (0.2.0). A manual `installer -pkg` enforces at once; an OTA install
  would start a 24 h shadow soak (§6.5).

## Notes

- POC: `tools/verify/clock-tamper/` (simulator, probe, `hw-test.sh`), findings in
  `docs/research/clock-tamper-findings.md`.
- [ADR 0014](./0014-watch-hours.md) — the review list this extends. [ADR 0004](./0004-enforcement-invariant.md)
  — a clock we cannot trust is a reason to enforce on a better one, never a reason not to enforce.

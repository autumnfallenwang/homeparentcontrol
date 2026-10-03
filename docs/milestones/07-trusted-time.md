---
name: 07-trusted-time
status: awaiting-verification
opened: 2026-10-03
---

# Milestone 07 — Trusted time

Close the clock bypass found on 2026-10-03 and put the moves around the rules on the parent's review
list. Decision: [ADR 0015](../adr/0015-trusted-time.md). Evidence:
[`../research/clock-tamper-findings.md`](../research/clock-tamper-findings.md).

## Scope

Agent 0.2.0: `TrustedClock` (two of three clocks) in every enforcement decision, the server's
`server_time` carried to the enforcer through `time.server.json`, the clock put right by sync, the
wall-clock timers moved to the continuous clock. Server: four red rows (clock set away from the
real time, automatic time off, time zone changed, in use during bedtime), "Flagged" on Reports,
`/health` uncacheable, honest tripwire wording.

## Exit criteria

- [x] The 13 POC scenarios shut down on time through the real predicate and ladder, with and without
      the server — `ClockTamperScenarioTests`, which also asserts the old agent fails (S1, S7, S11
      never off; S3 30 min late). Falsified twice: returning the wall clock turns 30 scenario cases
      red; dropping the independence rule turns the fresh-install test red.
- [x] Agent: 311 tests; enforcer, deadfall and supervisor still link no networking
      (`check-no-networking.sh`). API 511 tests including integration (on `hpc_test`), contract 90,
      web 88; typecheck clean; no new lint.
- [ ] Server deployed by CI/CD (push to `main`) — and the new rows seen on the live site.
- [ ] ⛔ **The real agent on this MacBook against a moved clock** — needs `sudo`:
      ```sh
      sudo tools/verify/clock-tamper/agent-e2e.sh agent/.build/pkg/homeparentcontrol-0.2.0.pkg /tmp/clock-e2e
      ```
      Safe only because Aaron's Macbook has no bedtime window (policy v11). Expect: rounds A and B
      fixed within a sync tick; round C "the enforcer measured the step". Then the device's history
      shows *Mac's clock set 30 m behind* and *"Set time automatically" turned off* in red. Also
      settles V-NTP: if round A is fixed by `server_time` rather than by turning automatic time back
      on, `systemsetup` cannot read the setting from a LaunchDaemon.
- [ ] ⛔ **Installed on Ivy's Mac mini (macOS 15.6.1)** — the procedure below. Her Mac's clock was
      still 22 h ahead at 02:00 on 3 Oct: expect one red *Mac's clock set 22 h ahead* row on the
      first tick and the clock put right within a minute.
- [ ] ⛔ **One real bedtime on her Mac with 0.2.0** — shutdown on time. And, if she tries the clock
      again, the red rows within a minute of it.

## Installing on Ivy's Mac

She is enrolled, so this is an upgrade: the base URL and credential stay where they are, and a manual
`installer -pkg` **enforces at once** (only an over-the-air install starts a shadow soak).

1. Copy `agent/.build/pkg/homeparentcontrol-0.2.0.pkg` to her Mac with **`tar` or `scp`/`rsync`**,
   never `.zip` or AirDrop — those add `com.apple.quarantine`, and a quarantined agent is killed
   silently.
2. On her Mac, as an admin: `sudo installer -pkg homeparentcontrol-0.2.0.pkg -target /`
3. Check: `/usr/local/libexec/hpc-enforcerd --version` → `0.2.0`, and
   `xattr -r /usr/local/libexec | grep -c quarantine` → `0`.
4. Within a minute her device page shows **Agent 0.2.0**, and her clock is right.

## Progress notes

- 2026-10-03 — incident at 00:00; POC, simulation and hardware probe the same night; code, tests and
  docs; pkg 0.2.0 built (`sha256 b45312060361c2e636ea7c41adbdb4c6910f990f52889c758c5a81fe810c80d3`).

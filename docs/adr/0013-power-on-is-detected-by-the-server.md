# 0013 — "The Mac was turned on" is detected by the server, from uptime

- **Status:** accepted
- **Date:** 2026-09-28
- **Deciders:** Aaron Wang

## Context

The owner asked for startups to stand out in the history, in red, with a count. The obvious sources
turned out to be wrong, and one was wrong on real data:

- **`boot_id` is not a boot.** Each daemon generates it as `UUID()` when its *process* starts. Events
  the enforcer spooled before a shutdown are stamped with the *next* sync process's id when they are
  drained after reboot. Reading a `boot_id` change as a power-on put a "Mac turned on" *before* the
  shutdown it followed, on Ivy's Mac.
- **`system_boot_time` drifts.** The agent computes it as now − `systemUptime`. Uptime pauses in sleep,
  so the reported boot time moves forward after every sleep, and it jumps whenever the clock is
  changed.
- The same investigation found `skew_estimate_ms` is a hard-coded `0` and `using_network_time` a
  hard-coded `true`, which is why a Mac 43 hours fast raised nothing.

## Decision

- **Uptime going DOWN between two check-ins is a power-on.** Uptime only rises within a boot.
  `/sync` stores it (`devices.last_uptime_s`, migration 0004) and, on a drop, writes an
  `enforcement_log` row of kind `power_on` at the boot time that sync reports. Right after a boot there
  has been no sleep for that time to drift by.
- The history presenter (`lib/history.ts`) reads power from those rows, never from `boot_id`. One
  inference remains, for history recorded before the rows existed: the launch after an **enforced**
  bedtime shutdown is the boot.
- **Clock skew is measured by the server** (the Mac's reported time − server time) and raises the
  `clock_skew` tripwire past 60 s.
- Session spans are ordered by time, not by `(boot_id, seq)`. Every `session.state` comes from sync
  with `seq = -1`, so a sync restart inside an hour tangled them.

## Consequences

- Startups are counted from a signal that means one. A Mac that sleeps overnight or has its clock
  changed does not produce fake startups.
- A power cycle is seen at the Mac's first check-in after boot. A Mac that never checks in again never
  records the power-on, which is correct: it cannot be known.
- `boot_id` is still stored and still sent. Its name promises more than it delivers. Fixing the agent
  to send the kernel's boot session UUID would need every Mac reinstalled, and nothing depends on it
  any more.

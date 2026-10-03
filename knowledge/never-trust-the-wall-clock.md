---
name: never-trust-the-wall-clock
description: On the child's Mac, Date() is an input the child controls — never decide, time an interval, or stamp an event with it
metadata:
  type: feedback
---

**On the agent, `Date()` is attacker input.** Decide on `TimeBasis.now()` (trusted time, ADR 0015);
time intervals and deadlines on `TimeBasis.continuous()`. `Date()` is right in exactly one place: the
heartbeat's `local_utc`, which exists so the server can measure the error.

**Why:** on 2026-10-03 Ivy set her Mac's clock 23 h ahead and skipped a shutdown. The spec had the
fix (§3.2 step 4) and no code did. The same root cause had five more faces, all found that night:

- the deadfall ran at 00:00:30 on "Saturday 23:00" and logged `restricted: false`;
- the event flush timer was `Date() − lastEventFlush`: a clock set back an hour stopped usage
  uploads for an hour (nothing arrived after 00:54);
- the queue evicts samples older than 14 days by `Date()` — a +15-day jump would erase them;
- event `ts` used the wall clock, so the parent's watch-hours review (ADR 0014) judged her 00:45
  Chrome use as "Saturday 23:45" and showed nothing red;
- `URLSession` served a **cached** `GET /health` after every backwards step, so a `server_time` read
  through it was stale by the cache's age. Sync is a POST (never cached); `/health` now sends
  `no-store`;
- and fixing the clock bites too: installing 0.2.0 on Ivy's Mac, sync put a 22-h-fast clock right
  five seconds after the postinstall started it, and `/usr/sbin/installer` — done, but not yet told —
  hung on a wall-clock wait (`install.log` showed it finished). Sync now waits 120 s after start.

**How to apply:** any new `Date()` in `agent/Sources` needs a reason in a comment. Ask of every one:
*if the child moves the clock by a day either way, what does this line do?* And a second witness is
only independent if it was not seeded from the first — see `TrustedClock`'s header.

See [[macos-clocks]], [[enforcement-invariant]], [[falsify-the-gate]].

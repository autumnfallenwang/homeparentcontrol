# 0009 — The deadfall schedules resolved instants, not wall-clock times

- **Status:** accepted
- **Date:** 2026-09-20
- **Deciders:** Aaron Wang

## Context

§4.6 specifies the deadfall in one sentence: "a `StartCalendarInterval` launchd job set to the
current policy's earliest `restricted_from`, rewritten by the sync daemon whenever the schedule
changes… ~30 lines."

Read literally, that means: take `restricted_from` — the string `"21:30"` — and write it into the
plist as `Hour 21, Minute 30`.

**`StartCalendarInterval` is evaluated in the machine's system timezone.** A.30 says the *policy's*
timezone wins. On a Mac where those agree, the literal reading is correct and the bug is invisible.

They do not have to agree, and making them disagree does not require admin. System Settings →
General → Date & Time → Time Zone is available to a standard user. A child who sets the Mac to
Honolulu moves every naive calendar entry by six hours, and the deadfall — the component whose
entire job is being the backstop when everything else is dead — fires at the wrong time, or not at
all, on exactly the night it was needed.

This is the same shape as the levers catalogued in [0004](./0004-enforcement-invariant.md): not a
deliberate off switch, but a setting that has the effect of one.

## Decision

The deadfall's schedule is computed by resolving each boundary to an **instant** in the policy's
timezone, then rendering that instant in the system timezone for launchd's benefit.
`DeadfallSchedule.entries(policy:now:systemZone:)` is pure and takes the system zone as a parameter,
so the mismatch is testable without touching the machine.

Three things fall out of it:

- **DST is handled for free**, for the same reason §3.2 made enforcement a predicate rather than a
  cron: each boundary is resolved individually, so there is nothing to skip on spring-forward and
  nothing to repeat on fall-back.
- **Overrides are deliberately NOT applied when scheduling.** A suspended window still gets its
  wake-up. The grant can be revoked before tonight, and the deadfall re-reads `overrides[]` when it
  fires. Scheduling is permissive; *deciding* is the predicate's job and only the predicate's.
  Baking a relaxation into the plist would turn a stale file into a bypass that outlives the grant
  it came from.
- **Each boundary gets follow-up entries at +5 and +20 minutes.** launchd runs a missed
  `StartCalendarInterval` once on wake, not once per miss, so a Mac asleep across the boundary gets
  exactly one attempt. Two extra entries buy three chances, and they are safe because the deadfall
  is a predicate: firing outside a restricted window does nothing at all.

## Consequences

**Easier.** Changing the system clock or timezone no longer moves bedtime for the backstop, and the
plist stays correct across both 2026 DST transitions without special-casing either.

**Harder.** The plist is larger — roughly three entries per boundary per day over an eight-day
horizon instead of one per window — and it must be regenerated as the horizon rolls forward rather
than written once. The sync daemon rewrites it on every policy change and the horizon is one day
longer than a weekly cycle, so a rebuild at any hour never loses a night.

**Risk worth tracking.** The rewrite path does `launchctl bootout` then `bootstrap`, because launchd
re-reads `StartCalendarInterval` only on reload. If a rewrite fails between those two calls the
deadfall is unloaded until the next policy change. That is a gap in the *backstop*, not in
enforcement — the enforcer is untouched — but it is a gap, and it is the reason the rewrite is
skipped entirely when the generated plist is byte-identical to the one on disk.

## Notes

- `DeadfallScheduleTests` pins the behaviour, including a policy in New York rendered on a machine
  set to Honolulu (same instant, different wall clock) and one set to Tokyo (same instant, next
  weekday).
- The deadfall honours `DISABLE` before anything else, like the enforcer. An emergency control one
  component ignores is not an emergency control.
- It has no ladder and cannot shut down: it locks, or it does nothing. A warning from a process that
  has just woken up has nobody to deliver to and no way to follow through, and an unattended
  `shutdown` from a one-shot with no grace period loses a child's homework.

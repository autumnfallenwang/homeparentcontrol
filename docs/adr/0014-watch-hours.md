# 0014 — Watch hours: what counts as "after bedtime", and how it is caught

- **Status:** accepted
- **Date:** 2026-09-28
- **Deciders:** Aaron Wang

## Context

The owner wants the parent's Activity history to flag **unwanted** use in red, above all a startup or
a login after bedtime. It has to be reliable when the Mac sleeps, shuts down or goes offline. They
don't want notifications yet.

A rule is `From → Until` plus an action. In practice `Until` is set just after `From` (e.g. 23:45 →
23:55), so the lock or shutdown can happen, and not at the morning. That makes `From → Until` the
**enforcement** period, not "the night". Nothing described the rest of the night, and nothing told
bedtime apart from school time. Every window is simply a period the parent restricted.

## Decision

1. **A rule gets an optional `watch_until`.** `From → Until` is enforced as before.
   `Until → Watch until` is **watched**: nothing is enforced, but a startup, a login/unlock, or the
   Mac being on but not reporting is flagged red and names the rule ("during Weekdays' watch
   hours").
   - Inside `From → Until`, nothing is red: the Mac itself is handling it.
   - Outside both, nothing is red. A bedtime shutdown is the rules working, so it is never red either.
   - Empty `watch_until` means no watch period, exactly as before.
2. **Judged against the rules in force at that moment.** `watch_until` rides in the compiled
   document each Mac receives. The agent ignores it; the documents are versioned, whereas rule rows
   are replaced on every save. `lib/restriction.ts` mirrors the agent's `BedtimePredicate` rule for
   rule, so the history never calls a moment "after bedtime" that the Mac didn't treat as such:
   - the wrap rule and the half-open `Until`
   - extra time moves `From` only
   - "No bedtime tonight" cancels that night's enforcement **and** its watch period
3. **Each unwanted act has a source that works while the Mac was unreachable:**
   - **Startup:** the server's `power_on` row (uptime dropped between check-ins, ADR 0013), and now
     also the agent's own `boot_time` (`kern.boottime`) on every `agent.started`. That catches a boot
     the Mac never checked in from: turned on at 01:00 offline, shut down before morning, and
     delivered from its queue later. Boots within two minutes of each other are one boot.
   - **Login/unlock:** `session.state` going from `locked` (which includes the login window) or
     `asleep` to in use, projected as `session_unlocked`. Recorded by the agent even with "Collect
     usage data" off. That switch now governs the app list only; before, it silently stopped the
     sampler entirely.
   - **Asleep vs on-but-not-reporting:** at the first check-in after 10+ minutes of silence,
     wall-clock time is compared with uptime, which pauses in sleep. Mostly asleep gives a plain
     "Mac asleep for 1 h 5 m". Awake throughout gives `unreported`, red if any of it touched watch
     hours (Wi-Fi off, a blocked network).
4. Wakes are **not** flagged. Macs wake themselves at night for maintenance; to use one, someone must
   unlock or log in, and that is flagged.

## Consequences

- Activity shows **After bedtime: N** in red, and only these rows are red.
- During watch hours the child **can** use the Mac; the parent learns afterwards. To stop use as
  well, move `Until` later instead.
- The agent changes (`boot_time`, recording independent of the usage switch) reach a Mac on its next
  reinstall. Until then the server-side sources cover most cases: power-on detection, the gap
  analysis, and unlocks while usage data is on.
- Unlocks are seen at the sampler's 60-second granularity. Nothing is seen while the Mac is off or
  asleep, and nothing can happen then either.

## Amendment — 2026-09-28, after the first live test

- **Lock and unlock are checked every 10 s** (`Sampler.sessionPoll`), not only at the 60 s sample.
  A lock and unlock inside one minute left no trace. The poll reports only a change between locked
  and unlocked, and never touches the usage meter. It skips a reading the lock probe can't make,
  because unknown means "unlocked" to the full sample, and a false red unlock is worse than a missed
  one.
- **"No bedtime tonight" also silences that night's warnings.** Warnings used to count down to a
  lock the override had already cancelled. The same applies to extra time that runs past `Until`.

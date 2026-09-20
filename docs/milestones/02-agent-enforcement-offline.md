---
name: 02-agent-enforcement-offline
status: open
opened: 2026-09-18
---

# Milestone 02 — Agent: enforcement, proven offline

Build `enforcer` and prove it enforces correctly with no network, no server, and no sync daemon in
existence. Covers **phase 3 steps 1–2** of [`../design-decisions.md`](../design-decisions.md) §9.

**Why before sync:** V1–V9 is the contract's central unproven claim, and it is cheapest to falsify
*before* a sync daemon exists to confuse the results. If enforcement cannot be shown to be
independent of the network, nothing downstream matters.

## Scope

Tick loop · policy load with JWS verification and last-known-good fallback · the bedtime predicate
(wall-clock time-of-day, never elapsed) · warnings via `osascript` banner and `CFUserNotification`
· the D.3 ladder (lock → 300 s grace → shutdown) · spool writes · `clean_exit` on SIGTERM.

**No network code at all.**

## Exit criteria

- [ ] **V1–V9 all pass** (§8.4) — cluster off, cable out, DNS blackholed, 500s, hung server, sync
      booted out, disk full, policy `chmod 000`, enforcer killed with deadfall installed
- [ ] **V6 produces byte-identical enforcer logs** with and without sync running — the direct proof
- [ ] **V5 proves total sync timeout < one tick**
- [ ] `otool -L` shows **no networking symbols** in the enforcer binary
- [ ] Predicate golden-file suite passes, including the midnight crossing and a DST transition
- [ ] `lint`, `typecheck`, `test` green

## Traps to clear deliberately

- ⚠️ **Invariant E.** Six "stop enforcing" levers have already been proposed and rejected; the sixth
  was written into the spec *after* the invariant was declared. **Assume the seventh is in the code
  you are about to write.** Run the standing test on every branch: *can this path leave the Mac
  usable past bedtime?*
- ⚠️ **X10 ruling.** A warning that could not be displayed delays *escalation*, never *enforcement*.
  Lock still fires; the ladder may not advance to shutdown until a warning has been delivered.
  "No console user logged in" is a **no-op**, not a skip — code the two cases separately.
- ⚠️ **The shutdown stub is compile-time only.** `#if DEV_ENFORCEMENT`. No env var, no plist key, no
  config field — a runtime switch is lever #7 on a machine where the child has admin.
- ⚠️ **X12.** `shutdown_grace_s` minimum is 60, not 0. Zero silently reconstitutes bare shutdown.
- **Sleep loops defer signals.** Verified on this hardware: a naive `sleep` loop ignores SIGTERM
  until it returns; launchd then SIGKILLs. Use an interruptible wait.
- **`ScreenSaverEngine` is undocumented** and is the next `CGSession`. Ship two independent lock
  paths and a boot-time self-test.

## Out of scope

Sync, supervisor, deadfall (milestone 03) · the parent UI (04) · anything cluster (05) · **real
shutdown on the Mac mini (06)**.

## Progress

- 2026-09-20: **`HPCCore` scaffolded — the predicate, the DST boundary resolver and the policy
  decoder, with 37 tests.** Package split so every decision that can leave a Mac usable past bedtime
  lives in a pure, I/O-free target that is testable without a daemon, a clock or a screen.
- 2026-09-20: 🔴 **Found lever #7 — in my own code, within the hour.** The milestone's first trap
  says "assume the seventh is in the code you are about to write", and it was. `Window.days` decoded
  as `(try? decode) ?? []`, matching the tolerant style of the fields around it — so a malformed
  `days` produced a window matching **no day**, i.e. a policy that parses cleanly and enforces
  nothing. It surfaced only because a broken test fixture happened to emit exactly that JSON.
  **The rule now pinned by `DecodingTests`: tolerate what you do not understand; never default
  toward less enforcement.** `days`, `windows`, `schedule` and the boundary times are strict and
  fail the document (so LKG takes over, and §4.6 fails open *loudly* if that fails too). `overrides`
  stay tolerant, because dropping a relaxation errs toward MORE enforcement — the safe direction.
- 2026-09-20: ⚠️ **§3.3 contradicts X10, and §3.3 is itself a lever.** §3.3 says a warning that could
  not be displayed "is a reason **not to enforce this tick**". X10 — quoted in this milestone's own
  traps — says the opposite: "delays *escalation*, never *enforcement*. Lock still fires." X10 wins,
  and §3.3's wording is a standing Invariant E violation: a child who can make warnings fail (Focus,
  killing the notifier, no console user) would otherwise defeat bedtime entirely. The ladder is
  being built to X10.
- 2026-09-20: **The enforcement ladder, built to X10 and X9, with 57 tests.** Pure state machine —
  it emits effects and never touches the machine — so every branch can be interrogated with the
  standing test. The headline guard is an exhaustive sweep: across every combination of warning
  outcome, breaker state, failure count and delivery history, **a restricted window must produce a
  lock**. If that property ever goes false, bedtime is bypassable.
- 2026-09-20: **Escalation and enforcement are separated exactly as X10 requires.** The lock is
  unconditional and nothing above it may gate it. Shutdown is gated on three things — grace elapsed,
  at least one warning actually *delivered*, breaker not tripped — because "shutdown without notice
  destroys work, and that is the one thing D.3 exists to prevent". `noConsoleUser` is a third case
  beside `delivered`/`failed`, since X10 says conflating "nobody to warn" with "warning failed" is
  how the lever got written in the first place.
- 2026-09-20: 🟠 **A second bug caught by test, milder but user-visible.** The episode reset ran on
  every unrestricted tick, including the half-hour before bedtime where warnings live — so each
  warning re-fired every 60 seconds: **thirty modal dialogs instead of four**, which is how a child
  learns to ignore them. Warnings are now keyed to the boundary they belong to, which also fixes the
  converse: "already warned at T-30" surviving into the next night and suppressing it.
- 2026-09-18: Opened. Warnings and `CFUserNotification` with a masked text field are already proven
  on this hardware, including from a root daemon via the `asuser` bridge.

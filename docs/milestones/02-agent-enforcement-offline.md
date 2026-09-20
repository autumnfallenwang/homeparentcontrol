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

- 2026-09-18: Opened. Warnings and `CFUserNotification` with a masked text field are already proven
  on this hardware, including from a root daemon via the `asuser` bridge.

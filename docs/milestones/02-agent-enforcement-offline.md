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

- [ ] **V1–V4, V7, V8 pass** (§8.4) — ⚠️ **needs the owner: sudo, a LaunchDaemon, and a Mac you are
      willing to have locked.** Scripted in `agent/scripts/v-series.md`, with a signed test-policy
      generator that opens a window two minutes out. Roughly 30 minutes.
- ➡️ **V5, V6 and V9 moved to milestone 03** on 2026-09-20 — they test the enforcer against the sync
      daemon and the deadfall, which this milestone's own scope defers. See `03-agent-sync-and-lifecycle.md`.
- [x] `otool -L` shows **no networking symbols** in the enforcer binary — `scripts/check-no-networking.sh`,
      run in CI. ⚠️ Falsified: a *dead* `import Network` passes (Swift does not link an unused
      framework), one real `NWPathMonitor()` fails it. So it proves no network **capability**, which
      is the property that matters — the comment used to overclaim and now says this.
- [x] Predicate suite passes, including the midnight crossing and both 2026 DST transitions
- [x] `swift build` / `swift test` green — **71 tests**

## ⚠️ A scope error in this milestone, found while building it

**V5, V6 and V9 cannot pass here, and it is not a gap in the work.** They test the *interaction*
between the enforcer and components this milestone explicitly excludes:

| | Needs | Which this milestone's own scope says is |
|---|---|---|
| **V5** — server accepts then hangs 120 s | the sync daemon | "Sync … (milestone 03)" |
| **V6** — `launchctl bootout system/com.hpc.sync` | the sync daemon | same |
| **V9** — enforcer killed with the deadfall installed | the deadfall | "deadfall (milestone 03)" |

V6 is the headline — "byte-identical enforcer logs with and without sync running, the direct proof"
— and there is nothing to boot out until a sync daemon exists. **Recommend moving V5, V6 and V9 to
milestone 03's exit criteria**, where the things they test will exist. The remaining six (V1–V4, V7,
V8) are genuinely runnable now and are what `agent/scripts/v-series.md` walks through.

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

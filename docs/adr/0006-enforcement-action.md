# 0006 — Enforcement action: lock → 300 s grace → shutdown

- **Status:** accepted
- **Date:** 2026-09-18
- **Deciders:** project owner (captured during POC 2)

## Context

The owner's own framing of the third pillar was *"finally shutdown"* (**P1.3**). POC 1 built the
mechanism, then recommended `ACTION=lock` instead — but that was the PoC author's reading, never
owner-confirmed, so the question was carried into POC 2 as an open decision (**D.3**).

It matters more than it looks. **Power-off is the one capability Apple does not offer** — ✅ Screen
Time cannot power off a Mac (Apple put `ShutDownDevice` in the *MDM* protocol, not in Screen Time),
and macOS 27's strongest new remote control is "pause access to a device", which explicitly leaves
Always Allowed apps running. So the shutdown requirement is exactly the genuine gap that justifies a
custom daemon at all. Dropping it would hollow out the project's reason to exist.

Against that, **the enforcement action changes the cost of every other failure in the system.** T4's
32-row failure matrix has a recovery column, and under `shutdown` four of its rows collapse to
"physically switch the machine on."

## Decision

**Lock → 300 s grace → shutdown.** One ladder, not a choice between two actions.

```
  T-30 ─── banner        T-15 ─── banner        T-5 ─── modal        T-1 ─── modal
  T-0  ─── LOCK           she clears it with her own password
           │  the enforcer RE-LOCKS every tick while the predicate holds.
           │  "Enforcement" is the re-locking, not the lock.
  T+300s ─ SHUTDOWN       only if the predicate STILL holds
```

`action_options.shutdown_grace_s` defaults to **300**, `CHECK`-constrained to `[0, 3600]`.

**Four independent arguments moved the owner off bare `shutdown`, and all four survive:**

| # | Source | Argument |
|---|---|---|
| 1 | **POC 1** | Shutdown destroys unsaved homework — and ⚠️ *both* of POC 1's bugs were in the enforcement path, which its dry-run suite caught neither of. This is the path most likely to fire wrongly |
| 2 | **T3** | **You cannot SSH into a machine that is off.** Every remote recovery path in T3's operability analysis evaporates at once. An *operability* argument, distinct from POC 1's data-loss one |
| 3 | **T4** | Lock-then-shutdown **captures both outcomes**. A corrected policy landing inside the grace window cancels the shutdown — at `boundary` cadence that is ≤15 s, so 300 s is a real recovery budget, not a gesture |
| 4 | **T8 / C4** | A late parent override is **meaningless** under bare `shutdown`: the Mac is off, there is no screen to prompt on and nothing to act on. A product-function argument, distinct again |

**The ladder still delivers the original requirement.** The machine really is off at T+300 s if the
predicate still holds. What changed is that the five minutes before it are now a save-work window, a
remote-recovery window and an override window at the same time.

**Rejected:** bare `shutdown` at T-0 (all four arguments above); `lock` alone (fails **P1.3** — it
never delivers "machine is actually off", the one thing Screen Time cannot do); an escalation
triggered by *repeated circumvention* rather than by the clock (T7's reading of
`mac-screentime-enforcer` — a better trigger in general, but it presumes an adversary this threat
model does not have, per **AR.1**).

### Corollary constraint — recorded because it is structural

**The policy schema cannot express** disabling Remote Login, changing or locking out admin accounts,
touching `sudoers`, or changing FileVault (A.34). Not "must not" — *cannot*: there is no field for
it, so no bug and no bad policy push can strand the parent outside the machine they are trying to
recover. This is the counterpart to argument 2: keeping SSH alive is worthless if the agent is
allowed to turn it off.

**Two hard rules follow from the ladder:**

- ⚖️ **A late grant does not unlock the Mac, and the parent UI must say so in those words.** 📄
  Nothing third-party can draw or act over the macOS lock screen. What actually happens: the grant
  moves the boundary, the predicate evaluates to "outside window", **the enforcer stops re-locking**,
  and she logs back in herself in ~5 s. The UI sentence is specified verbatim: *"She'll be able to log
  back in within about 5 seconds. This won't wake the Mac for her."*
- ⚖️ **Ship two independent lock paths plus a boot-time self-test.** 📄 `ScreenSaverEngine.app` is the
  next `CGSession` — the same class of undocumented internal artefact — and a Hammerspoon issue filed
  on macOS 27's release date already reports the `CGSession` path gone. POC 1 replaced one
  undocumented dependency with another and treated the problem as closed.

## Consequences

**Positive**

- The owner's requirement is met without the failure mode that would have got the system uninstalled
  the first time it fired wrongly at 19:00.
- A mistaken policy is now recoverable *in band*: publish a correction, it lands in ≤15 s, the
  shutdown never happens. Under bare `shutdown` the only recovery was walking to the machine.
- The Mac stays reachable during the grace window, so SSH, the kill-switch file and a corrected
  policy all remain available — the three remedies [0004](./0004-enforcement-invariant.md) leaves.
- The override design in [0007](./0007-online-only-override.md) is only possible because a screen
  still exists at T+60 s.

**Negative**

- **The 300 s window is a real 300 s of extra screen time, every night.** It is a deliberate trade,
  not a rounding error, and a child will learn its exact length.
- **Two actions, two failure modes.** The lock can fail (undocumented `CGSession`-class dependency)
  and the shutdown can fail independently. Each needs its own detection and its own audit event.
- **Under `shutdown` the health states lose information.** A nightly bedtime shutdown looks exactly
  like `EXPECTED_OFFLINE`, so failure-matrix row 32 — *bad policy pushed while the action is
  `shutdown`* — is indistinguishable from a normal night on the dashboard.
- ⚠️ **"Enforcement" is the re-locking, not the lock**, which is what collided with T3's proposed
  action-rate breaker: two actions inside the 300 s grace, and ~60 re-locks an hour. That breaker as
  written would have disabled enforcement on the first ordinary bedtime — see
  [0004](./0004-enforcement-invariant.md) X9.
- Unsaved work is *narrowed*, not protected. Five minutes is enough to hit ⌘S; it is not enough to
  finish an essay, and the modal warnings at T-5 and T-1 are load-bearing for that reason.

**Open risks**

- ⚠️ **This is the path POC 1 found both of its bugs in, and its dry-run suite caught neither.** It
  needs testing live against the clock, not only in dry-run.
- ⚠️ The ladder is unproven end to end: the nine-case enforcement-isolation matrix (V1–V9) must show
  a lock at 21:30 under every injected failure before the shutdown rung is trusted.
- 📄 The lock mechanism rests on undocumented internal behaviour that macOS 27 may already have
  removed. Two independent paths plus a boot-time self-test is the mitigation, and pinning the Mac
  to 26.x is the precondition.
- ⚖️ `shutdown_grace_s` is configurable to `0`, which re-creates bare shutdown and silently deletes
  every one of the four arguments above. Nothing in the schema prevents that.

## Notes

- Siblings: [0004](./0004-enforcement-invariant.md) (the invariant the ladder must not breach) ·
  [0007](./0007-online-only-override.md) (what happens inside the grace window).
- Sources: POC 1 §5.2, §5.3, §7 (findings live outside this repo) ·
  [`poc2-findings.md`](../research/poc2-findings.md) §2 #5, §6 D.3, §8E ·
  [`T3-lifecycle-operability.md`](../research/tracks/T3-lifecycle-operability.md) §2.5, §5 ·
  [`T4-contract.md`](../research/tracks/T4-contract.md) §8.5, §11 rows 22/25/32 ·
  [`T8-parent-override.md`](../research/tracks/T8-parent-override.md) C4 ·
  [`design-decisions.md`](../design-decisions.md) D.3, A.34, §3.5.

# 0004 — Invariant E: the enforcer has no off switch

- **Status:** accepted
- **Date:** 2026-09-18
- **Deciders:** project owner (captured during POC 2)

## Context

**O.1 — "fail-open or fail-closed?" — was the one safety-critical question every prior document had
left open.** The agent is running at 21:30, something is wrong: does the child keep using the Mac,
or does it lock?

Two research tracks answered it independently, under controlled conditions. T3 reported first and
its recommendation was **deliberately withheld from T4** so T4 would reason from scratch —
independent convergence is evidence; agreement-by-suggestion is not. They landed on the same
principle:

| Track | Formulation |
|---|---|
| **T3** | Fail **open** on infrastructure failure; fail **closed** only on a deliberate, validated, fresh policy |
| **T4** | Fail-open on **ignorance**, fail-closed on **knowledge** |

⚠️ **But they did not converge on everything, and an earlier draft of the findings overstated it.**
On the **policy-staleness** sub-question they answered *oppositely*: T3 would stop enforcing once a
cached policy passed its TTL; T4 said that is a **remotely-triggerable bypass** — anyone who can keep
the agent offline long enough wins — and answered *"never."* **T4 won.** That was an adjudication,
not a convergence, and it is recorded that way (X1c).

Then the pattern underneath became visible, and it is the real finding of this ADR.

## Decision

> ## Invariant E — no code path inside `enforcerd` may disable, suspend or skip enforcement.
>
> Health signals, breakers and staleness checks are **inputs to the parent's view**, never **gates on
> the action**. The only legitimate relaxation is a policy-carried `override` with a mandatory
> `expires_at`. The only legitimate stop is an authenticated, parent-initiated decommission (`410`).

The behavioural rule it governs: **fail-open on ignorance, fail-closed on knowledge.** Cannot
determine what the rules are → do not lock, and scream within one tick. Knows the rules and merely
cannot reach the server → enforce exactly as written, indefinitely.

**Five separate "stop enforcing" levers were proposed during the round. Each was locally reasonable.
All five are rejected.**

| | Lever | Trigger | Why it is a bypass |
|---|---|---|---|
| **X1** | `enforcementEnabled: false` GitOps flag | parent, remote | Contradicts the wire protocol's absence of a stop verb. The legal form is a `suspend` override **with an expiry** |
| **X1b** | 401 / credential revocation disables enforcement | server or network | Anything that gets the credential revoked stops bedtime — including a child who notices that a mangled `credential.json` produces 401s |
| **X1c** | cached policy expires past a TTL | network outage | Unplug the cable for three days and bedtime evaporates |
| **X8** | dead-man's switch **gates** enforcement, failing open | the agent's own health | Tautological if the enforcer writes and reads its own liveness file; a one-command bypass (`chmod 000`, `chflags uchg`, `rm`) if anything else writes it |
| **X9** | action-rate breaker whose **penalty is disabling enforcement** | *normal operation* | ⚠️ Would have tripped on the **first ordinary bedtime**: the ladder is two actions inside 300 s against a "1 per 10 min" cap, and per-tick re-locking is ~60 actions/hour against a cap of 5/day |

**Every one of them converts a *failure condition* into a *bypass*.** Under **AR.1** the child has
admin, so every one of them is reachable. ⚖️ **The pattern is the hazard, not any single instance** —
which is why this is written as an invariant rather than five separate corrections.

**Staleness, settled in T4's favour.** *"After N days, stop enforcing"* ❌ hands the child a switch;
*"after N days, get stricter"* ❌ punishes the child for the parent's cluster being down; *"keep
applying it forever, and say so loudly"* ✅. Safe **by construction**: every relaxation carries a
mandatory `expires_at` and only the baseline schedule is durable, so a stale policy can only ever
converge **stricter**. A policy from three days ago is at worst one whose grants have all expired.

**X9's corrected form**, which keeps the control T3 actually wanted:

- **Count episodes, not actions.** One bedtime window is one episode, however many locks, re-locks
  and the terminal shutdown it contains. `5 per 24 h` is then generous and the shutdown-loop bug
  class is still caught.
- **The penalty is "stop escalating", never "stop enforcing".** On trip the enforcer holds at its
  current rung — it does not advance lock → shutdown — emits `breaker_tripped`, and goes `DEGRADED`.
- **Runaway re-assertion is throttled, not broken.** POC 1 §5.2 already solved this with
  `REASSERT_MINUTES`; that is the right mechanism and it disables nothing.

**X8's corrected form:** the dead-man's switch is **the supervisor's input and an observability
signal**. It keeps its purpose — telling the *parent* something is wrong — and loses the gate.
### The standing test

> **"Can this path result in the Mac staying usable past bedtime?"**
> If yes, it does not belong in `enforcerd`.

## Consequences

**Positive**

- A whole class of future proposal is answered before it is made. The five levers came from five
  different problems — remote kill switch, auth, offline tolerance, liveness, loop protection — and
  one invariant covers all of them plus the sixth nobody has thought of yet.
- ⚖️ **Fail-open is defensible precisely because it is not fail-silent.** 📄 Saltzer & Schroeder's
  default-deny rests explicitly on open-failures being *silent*; presence-based alerting removes that
  premise. Every fail-open branch emits `agent.degraded` every tick and the parent gets one banner:
  *"Lucy's Mac is not enforcing — its rules are missing or unreadable."* **The whole argument depends
  on that distinction holding.**
- The child-reachable failure — "the network is down" — is already fail-closed. The fail-open
  branches are "never configured" (once, at install) and "the policy on disk is corrupt" (requires
  root), **neither reachable by unplugging a cable**. And `expires_at NOT NULL` makes a permanent
  relaxation *unrepresentable* — a database constraint rather than a convention.

**Negative**

- **There is no remote off switch, and that is a real operational cost.** If a wrong policy ships,
  the only remedies are publishing a corrected one (≤15 s at `boundary` cadence) or physically
  touching the Mac. Under `shutdown` even that narrows — see [0006](./0006-enforcement-action.md).
- The one local emergency control, the `DISABLE` kill-switch file, is time-boxed by default, read
  fresh from disk first, fails safe if the check itself throws, and **alerts on appearance** — but it
  is still a total bypass in one command for an admin child. ⚠️ T3's rationale for it (*"parent-only
  because the child is non-admin"*) was **wrong**: she has admin (C2).
- A stale-but-valid policy enforces forever, so a device that silently stops syncing keeps applying
  rules the parent may have already changed. The mitigation is wording, and the wording is
  load-bearing: *"Lucy's Mac hasn't checked in for 2 days — **it is still enforcing the rules from
  Tuesday.**"* The natural fear on seeing "offline" is the exact opposite of the truth.
- Nothing here resists an admin child; `sudo touch …/DISABLE` and `launchctl bootout` are both total
  bypasses. **AR.1 covers it**, and every attempt lands in `tripwires`.

**Open risks**

- ⚠️ **A sixth skip-enforcement path exists in the spec and has not been adjudicated against this
  invariant.** [`design-decisions.md`](../design-decisions.md) §3.3 states that *"a warning that could
  not be displayed is a reason not to enforce this tick."* Under the standing test the answer is yes,
  the Mac stays usable past bedtime — indefinitely, if the warning surface fails persistently.
  **Needs a ruling before `enforcerd` is written**, alongside X8 and X9.
- ⚠️ `policy.fail_mode` (`"open" | "closed"`) lives *inside* the signed policy document, so in exactly
  the two classes where fail-open applies — no policy, unreadable policy — it cannot be read.
- X8 and X9 were found during synthesis, *after* the research round closed. ⚖️ The base rate for this
  class of defect is therefore not zero, and Invariant E is the control for it.
- 📄 The Saltzer & Schroeder rebuttal is an argument, not a measurement. If alerting does not actually
  reach the parent, the fail-open branches become fail-silent and this ADR's reasoning collapses.
  Confirming that a test notification reaches a human is the highest-priority cluster verification.

## Notes

- ⚠️ **Attribution correction.** [`design-decisions.md`](../design-decisions.md) introduces the five
  levers as *"invented independently by four different tracks"*, but its own table attributes all
  five to **T3**. What was independent was the *catching*: X1/X1b/X1c were raised by T5's conflict
  audit, X8 and X9 during final synthesis. The substance of the invariant is unaffected.
- Siblings: [0003](./0003-polling-and-desired-state.md) (desired state, and why there is no stop
  verb to carry) · [0006](./0006-enforcement-action.md) (the ladder X9 collided with) ·
  [0007](./0007-online-only-override.md) (the only legitimate relaxation).
- Sources: [`poc2-findings.md`](../research/poc2-findings.md) §5 "Partial convergence", §6 O.1 ·
  [`T3-lifecycle-operability.md`](../research/tracks/T3-lifecycle-operability.md) §3.3, §5.3, §5.6, §5.7 ·
  [`T4-contract.md`](../research/tracks/T4-contract.md) §8.2, §8.3, §4.7 ·
  [`design-decisions.md`](../design-decisions.md) **Invariant E**, A.7–A.11, §3.7, §4.6, §8.5.

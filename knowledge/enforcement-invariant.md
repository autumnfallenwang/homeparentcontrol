---
name: enforcement-invariant
description: Invariant E — no code path inside enforcerd may disable enforcement; five separate "stop enforcing" levers were proposed and all were rejected.
metadata:
  type: feedback
---

**No code path inside `enforcerd` may disable, suspend or skip enforcement.** Health signals,
circuit breakers and staleness checks are **inputs to the parent's view**, never **gates on the
action**. The only legitimate relaxation is a policy-carried override with a mandatory
`expires_at`; the only legitimate stop is an authenticated, parent-initiated decommission.

**Why:** **six separate "stop enforcing" levers have now been proposed**, each locally reasonable.
Five came from one research track; the sixth was written into the spec *after* this invariant was
declared, by an author who had read it:

- a GitOps `enforcementEnabled: false` flag
- 401 / credential revocation disabling enforcement
- a cached policy expiring past its TTL
- a dead-man's switch that gated enforcement and failed open
- a rate breaker whose penalty was disabling enforcement — and which **would have tripped on the
  first ordinary bedtime**, since the lock → 300s grace → shutdown ladder is two actions inside
  five minutes
- **X10:** "a warning that could not be displayed is a reason not to enforce this tick" — overruled;
  a failed warning now delays *escalation*, never *enforcement*

Every one converts a *failure condition* into a *bypass*. The child has admin on her Mac, so all of
them are reachable. **Assume the seventh is already in the code you are about to write.** **The pattern is the hazard, not any single instance** — which is why this is a
standing rule rather than five individual fixes.

**How to apply:** before adding anything to the enforcement path, answer the standing test —
*"can this path leave the Mac usable past bedtime?"* If yes, it does not belong in `enforcerd`.
Runaway re-assertion is throttled, never broken (POC 1 §5.2 already solved this with
`REASSERT_MINUTES`). A breaker's penalty is "stop escalating", never "stop enforcing".

Recorded as ADR 0004; the reasoning is in `docs/design-decisions.md` under Invariant E.
See [[verify-macos-claims]].

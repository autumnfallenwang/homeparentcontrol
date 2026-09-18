# 0007 — Parent override is an online one-click grant; offline codes deferred

- **Status:** accepted
- **Date:** 2026-09-18
- **Deciders:** project owner (captured during POC 2)

## Context

**P1.5** was added on 2026-09-18, in the owner's words:

> *"parents should have a code or something to break some of the rules like give extra sometime based
> on certain situation … either a temporary code to her to let her fill in, or an easy one time
> permission from parent end … she doesn't need send request from her end since nothing UI from her
> end, she can just ask for approve personally"*

Two things are settled by that sentence and neither is the mechanism. The override is
**parent-initiated only**, and **there is no request flow from the child** — she asks in person, out
of band, which is what keeps **P0.3** intact. It also names two acceptable mechanisms without
choosing: **(a)** a temporary code she types on the target, or **(b)** a one-click grant from the
parent UI that the agent picks up.

The open question was whether (b) alone is enough. Under [0004](./0004-enforcement-invariant.md) a
cached policy **keeps enforcing indefinitely** while the server is unreachable — so the exact moment
a network-only override stops working is a moment when bedtime still fires. T8 called that *"a lock
with the key inside"* and argued an offline path was mandatory. Research track T8 then designed one
in full.

## Decision

**Build (b) only, for now. One click in the parent UI, ~5 s to land. T8's offline code scheme is
deferred, not cancelled** (D.5).

The online path needs **zero new contract primitives**: `policy.overrides[]` already exists, every
relaxation already carries a mandatory `expires_at`, and the single new field is
`granted_via ∈ {"ui", "calendar"}`. Latency comes free from the adaptive cadence of
[0003](./0003-polling-and-desired-state.md) — opening the device page sets a 10-minute sticky flag
that drives the agent to a 5-second poll.

The UI shows two-stage state, and **"Applied" is driven by the agent's own next tick** reporting the
new `policy_version` and a shifted boundary — never by the server's own write:

```
+30 min for Lucy            Sent ✓ 21:29:58  →  Applied ✓ 21:30:03  (5 s)
Bedtime tonight: 21:30 → 22:00 · expires 06:00
```

**Withdrawn as a direct consequence of P1.5:** T4 §10.5's *"Ask for more time"* button on the warning
modal, which would have written a `request.extension` event for the parent to approve. It was a
timing artefact — P1.5 was added the same day T4 reported — and it is forbidden outright. There is no
child-facing surface of any kind: no login, no status page, no time-remaining widget, no request
button, and the child is a domain row rather than an auth subject (A.15, A.18).

**Deferred, and recorded so it can be picked up unchanged:** T8's `hpc-ovr-v1` — RFC 4226 HOTP with a
structured counter, `HMAC-SHA256(K_ovr, device‖day‖minutes‖seq)` truncated to **6 digits**, accepting
day ±1 — plus the **static HTML card** saved to the parent's phone (the parent UI runs on the cluster
that is by hypothesis down, so a server-rendered code does not solve the problem it exists for). Its
best property: **the duration is encoded inside the code.** The agent infers the grant size from
which of 27 candidates matched, so nothing extra is typed **and a 15-minute code cannot be replayed
as a 60-minute one** — which no other scheme in T8's comparison offers.

**Why deferring is safe** ⚖️: the gap is narrow and doubly conditional — the cluster must be down
**and** extra time must be needed **that night**. The consequence when it bites is that she goes to
bed on time. That is the system working, not failing.

**What it saved:** roughly **a quarter of the planned schema** — 3 tables (`override_keys`,
`override_redemptions`, `override_code_reveals`), 6 columns on `policy_sets`, the `/override/card`
page, a `desired` kind, a `granted_via` value, a tripwire kind — plus a shared secret on the child's
Mac and **X3's reveal-record problem**, which was the neatest argument of all: T8's mitigation for a
forged code required an issuance record, and **T8's own delivery mechanism produces none by
construction**, because the offline card and the printed fallback are exactly the paths with no
server round-trip. A false accusation from a missing `localStorage` entry is worse than the forgery
it guards against.

## Consequences

**Positive**

- ~1 day of work instead of ~4, with no new wire primitives, no HOTP implementation on two ends, no
  key rotation machinery and no clock-tolerance window to reason about.
- ⚖️ **No override secret reaches the child's Mac at all.** The deferral removes the honest security
  limit rather than mitigating it.
- Every grant is server-issued, so `granted_by`, `reason` and the full audit trail exist by default —
  there is no unattributed grant path.
- `expires_at NOT NULL` plus agent-side caps (`allowed_minutes`, `max_minutes_per_day`,
  `max_grants_per_day`) mean a grant is always a **time-bounded relaxation, never a stop**, which is
  what keeps it compatible with [0004](./0004-enforcement-invariant.md).

**Negative**

- **If k3s is down at bedtime specifically, no extra time can be granted that night.** This is the
  accepted cost, stated plainly, and it is the scenario T8 was commissioned to solve.
- The UI must handle the offline case honestly and the sentence has to stop where the capability
  stops: *"Lucy's Mac hasn't checked in for 14 minutes. This grant will apply when it reconnects."*
  **There is no code to read out.** Getting that wording wrong is how the deferral becomes a support
  problem.
- ✅ The `CFUserNotification` masked-text-field path was verified working from a root daemon
  (`rc=0 button=0 text="1234"`) and is now **unused**. Real verification effort, banked rather than
  spent.
- The deferral is only cheap while it stays deferred. Reintroducing offline codes means adding back
  three tables and re-opening X3, which is a migration rather than a feature flag.

**The honest security limit, recorded even though it is deferred**

⚖️ **She has admin, so any local override secret is readable.** `sudo cat …/override.key` and she can
mint valid codes indefinitely, offline, undetected by the cryptography. There is no version of an
offline scheme in which that is false, because offline verification requires a local secret.
**The mitigation is making misuse visible, not impossible** — server-side reconciliation of every
redemption against an issued `(day, minutes, seq)`, raising *"Lucy used a 30-minute code you never
issued."*

It is also **not the weakest link**, and that is the load-bearing point: `sudo touch …/DISABLE` is a
total bypass in **one command**, with no cap, no expiry and no cryptography. Forging codes is the
most expensive and least rewarding attack available to her — the only one that is rate-limited,
duration-capped, day-capped, auto-expiring **and** reported. **AR.1 covers it precisely**: if the
owner's assessment fails, it fails at `launchctl bootout` first.

**Open risks**

- ⚠️ T8 named one genuinely new cost that the deferral happens to avoid and that must be re-weighed
  if offline codes are ever built: a prompt saying *"type a code here"* is **an invitation to
  investigate**, and it makes the existence of a local secret discoverable in a way the current
  design is not.
- ⚖️ If the cluster proves unreliable in practice, this decision should be revisited rather than
  worked around. The trigger is a real outage that actually bit at bedtime — not a hypothetical one.

## Notes

- T8's full design stands in
  [`T8-parent-override.md`](../research/tracks/T8-parent-override.md) and is implementable as
  written. Nothing in the shipped spec implements any part of it, by intent — see the
  [`design-decisions.md`](../design-decisions.md) appendix of deliberately-absent things.
- Siblings: [0003](./0003-polling-and-desired-state.md) (where the ~5 s comes from) ·
  [0004](./0004-enforcement-invariant.md) (why a grant must always expire) ·
  [0006](./0006-enforcement-action.md) (why there is still a screen to act on at T+60 s).
- Sources: [`requirements.md`](../requirements.md) P1.5, P0.3, **AR.1** ·
  [`poc2-findings.md`](../research/poc2-findings.md) §3 (T8), X3, C1, §6 ·
  [`T8-parent-override.md`](../research/tracks/T8-parent-override.md) §3, §4.2, §5 ·
  [`design-decisions.md`](../design-decisions.md) D.5, A.15, A.18, §5.2, §5.8.

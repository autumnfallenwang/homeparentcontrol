---
name: 04-parent-ui
status: planned
opened: 2026-09-18
---

# Milestone 04 — Parent UI

Covers **phase 4** of [`../design-decisions.md`](../design-decisions.md) §9. Still entirely local —
no cluster required.

## Scope

`/` and `/devices/[id]` **first** — the two pages that carry the product. Then `/rules`,
`/override`, `/rules/calendar`, `/rules/history`, `/reports`, `/settings`, `/setup`.

## Exit criteria

- [ ] Author a rule, publish it, and watch the agent converge on it within one adaptive tick
- [ ] Grant a one-click override and see it take effect on the agent in ~5 s
- [ ] Today's usage and the 7-day view render from projected rollups, not raw events
- [ ] Device health card reflects all five states, including `EXPECTED_OFFLINE`
- [ ] Enrolment flow works end to end from `/setup`
- [ ] Works at phone width in a browser — **there is no mobile app and never will be** (P2.6)

## Traps to clear deliberately

- ⚠️ **The wording is load-bearing in four places** and all four are specified in the spec: the
  still-enforcing banner (§4.6), the no-unlock sentence (§3.5), Revoke vs Decommission (§5.5), and
  the `active_s` label (§5.8). A late grant **does not unlock the Mac** — no third-party code can
  draw over the lock screen, and the UI must not imply otherwise.
- ⚠️ **C3.** The confirmation guard fires on **tightenings only**. A guard on every grant trains the
  parent to click through it, which is worse than no guard.
- ⚠️ **No child-facing surface anywhere.** T4 §10.5's "Ask for more time" button is withdrawn
  (C1/X7). She asks in person.
- **D.2 is still open** — build the data to support dashboard, digest, alerts and on-demand query
  without committing to one sink.

## Out of scope

Cluster (05) · real shutdown (06) · the offline override card (deferred — ADR 0007).

## Progress

- 2026-09-18: Opened.

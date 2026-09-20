---
name: 04-parent-ui
status: open
opened: 2026-09-18
---

# Milestone 04 — Parent UI

Covers **phase 4** of [`../design-decisions.md`](../design-decisions.md) §9. Still entirely local —
no cluster required.

## Scope

`/` and `/devices/[id]` **first** — the two pages that carry the product. Then `/rules`,
`/override`, `/rules/calendar`, `/rules/history`, `/reports`, `/settings`, `/setup`.

## Exit criteria

- [x] **Author a rule, publish it, and watch the agent converge on it within one adaptive tick** —
      `convergence.integration.test.ts`, run signed and unsigned. Publish → the very next tick
      carries the new document → the tick after that settles to `unchanged`.
- [x] **Grant a one-click override and see it take effect on the agent in ~5 s** — the ~5 s is the
      cadence, and the cadence is what the device page's attended flag buys: 60 000 ms before
      `POST /devices/:id/attend`, 5 000 ms after. The grant lands on the following tick with its
      mandatory `expires_at` (A.8).
- [x] **Today's usage and the 7-day view render from projected rollups, not raw events** —
      `reportQuery` reads `usage_hourly` / `usage_daily` and never touches `events`. Raw samples
      are pruned at 90 days and rollups outlive them, so a report built on raw data would lose its
      own history.
- [x] **Device health card reflects all five states, including `EXPECTED_OFFLINE`** — six, in fact;
      `UNENROLLED` is a state the schema has and §7.3's prose does not.
- [x] **Enrolment flow works end to end from `/setup`** — walked against a live API: sign up → add
      child → add Mac → one-time code → `POST /enroll` → first `/sync` returns a signed policy.
      The code is shown once and is not recoverable afterwards.
- [~] **Works at phone width in a browser** (P2.6) — the two things that actually break it are
      verified in the built output and pinned by tests: the viewport meta is emitted
      (`width=device-width, initial-scale=1`), every control resolves to `min-height: 44px`, and
      the layout is single-column below 40rem with `sm:grid-cols-2` only above it. ⚠️ **Not
      visually inspected** — no browser was reachable from this session. A two-minute look on a
      phone is outstanding.

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
- 2026-09-20: **The parent API.** `parent.ts` was a 15-line stub with no routes at all, so this
  milestone needed both halves. Today, devices, overrides, rules, reports, setup, settings —
  35 integration tests, written as traps rather than happy paths.
- 2026-09-20: **The four load-bearing wordings moved into `packages/contract`** with tests pinning
  the clauses. They are consumed by two sides and must not drift, and in every case the tidier
  phrasing states something false. Verified they do NOT leak into the agent's JSON-Schema artefact.
- 2026-09-20: **The UI** — eight pages plus `/sign-in`, which was missing and without which none
  of the app was reachable in a browser.
- 2026-09-20: **Convergence tests** across both halves of the API, which is the only place M4's
  first two criteria are testable.

## Decisions made here, and why

- **`attend` is a POST, not a side effect of the GET.** §5.8 says "opening [the device page] sets
  `attendedUntil`". Implemented literally that fires on Next.js prefetch, on a speculative load and
  on every refresh of a page left open on a kitchen tablet — each one putting the device into
  5-second polling for ten minutes, triggered by nobody looking at anything.
- **The rules diff returns the COMPILED document.** A diff of `schedule_windows` hides everything
  the compiler does. A parent who moves bedtime 15 minutes and sees only "21:30 → 21:45" has not
  been shown that Monday is a holiday and the window is suspended anyway.
- **Typed confirmation is checked server-side.** §5.5 asks the UI to make Revoke and Decommission
  typed-confirmation actions; a confirmation only the browser enforces is one anyone can skip with
  curl, and one of the two uninstalls a child's bedtime.
- **A source-level guard that no page re-types a load-bearing sentence.** The likely failure is
  mundane: someone adds a page, wants the reassurance line, and types it slightly differently.
  Both then look right and only one gets fixed. ⚠️ The guard first failed on its own file's
  header — it could not tell a comment *explaining* the absence of a control from a control — so
  it now strips comments.

## Still open, and inherited

- **D.2 remains open**, as intended. One `reportQuery`, four sinks; the dashboard and the
  on-demand route are built, the digest and alert tables exist and are off. Choosing a delivery
  mode later is a config flag and an adapter.
- **`/rules/calendar` has an API but no page.** Exceptions can be created and are compiled (and
  recompile every affected device), but the month view is not drawn. Listed in scope, not built —
  say so rather than let a tick imply otherwise.

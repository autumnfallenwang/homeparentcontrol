---
name: walk-the-flow-not-the-endpoints
description: Every component can be tested and the composition still unusable — walk the flow a person would
metadata:
  type: feedback
---

**Before calling a feature done, walk it the way a person would, start to finish.** Component tests
prove each piece; they cannot prove the pieces are reachable in order.

**Why:** on 2026-09-20 the parent UI shipped eight pages, 35 API integration tests and 22 web tests,
all green — and **there was no sign-in page**. Every page required a session cookie and nothing in
the app could produce one, so the whole product was unreachable in a browser. No test could have
caught it: each page was correct, each endpoint was correct, and the missing thing was a *seam* that
no component owned.

It surfaced within a minute of actually starting the API and the web app and trying to use them.

The same walk found two more, both invisible to the unit tests:

- A 401 rendered as `Request failed (401)` on the page a parent opens to settle an argument,
  because eight separate `catch` blocks each would have had to handle it.
- The enrolment flow needed a schedule window to exist before a policy could compile, which the
  setup page did not mention.

**How to apply:** when a milestone's exit criteria say "works end to end", spend the ten minutes:
start the services, create the first account, and do the thing the criterion describes. For this
repo that is `agent/scripts/e2e-local.sh` on the agent side and, on the parent side, sign up → add
a child → add a Mac → enrol → sync → grant. Write down what you could not check — a criterion
verified structurally is not the same as one observed, and
[[falsify-the-gate]] applies to the walk as much as to a test: if nothing about the walk could
have failed, it proved nothing.

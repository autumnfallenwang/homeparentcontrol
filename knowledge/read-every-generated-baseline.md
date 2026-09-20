---
name: read-every-generated-baseline
description: A golden or snapshot baseline you generated but never read is an unreviewed assertion — it enshrines whatever the code did, bug included
metadata:
  type: feedback
---

**Never commit a generated golden, snapshot or approval file without reading its contents.** The
generator records what the code *did*, not what it *should* do, so an unread baseline converts a bug
into a permanently green test that now actively defends the bug.

**Why:** On 2026-09-20 the policy compiler's 14-case golden suite was generated with
`UPDATE_GOLDEN=1` and passed first time. Reading the output showed
`non-wrapping-window.expected.json` asserting a **570-minute** relaxation on a two-hour 13:00–15:00
window — `treat_as_weekend` was borrowing the weekend window's start time and computing a delta
against a window that is not a bedtime window at all. Arithmetically correct, semantically
nonsense, and the suite was perfectly happy with it. The fix (clamp to the window's own duration)
only exists because someone read a file that had already gone green.

This is the sibling of [[falsify-the-gate]], and the distinction is worth keeping: that entry is
about whether a test *can* fail, this one is about whether the thing it compares against is
*right*. A golden suite can be maximally sensitive and still be wrong in both directions at once.

**How to apply:**

1. After any `UPDATE_GOLDEN` / `--update-snapshots` / approval run, read the diff — not the test
   summary. `git diff` on the baseline files is the review.
2. Read the *values*, not the shape. Shape errors fail loudly anyway; it is the plausible-looking
   number, the off-by-one date, the wrong timezone offset that survives.
3. Spot-check the arithmetic by hand for at least the cases with derived values. In this repo that
   means minute deltas, `expires_at` instants and anything crossing a DST boundary.
4. When a case exists to pin an *edge* (no weekend window, empty policy set, unicode), confirm the
   baseline shows the edge actually being hit and not silently short-circuiting to the common path.
5. Regenerating to make a failing test pass is only legitimate once you have read the new baseline
   and can say why the change is correct. Otherwise it is deleting the test.

Corollary that made this suite reviewable at all: keep live and clock-dependent inputs **out** of
the function under test — the compiler takes pre-resolved holidays and one `now` argument, so every
fixture is static JSON that cannot rot on a library bump or a year rollover.

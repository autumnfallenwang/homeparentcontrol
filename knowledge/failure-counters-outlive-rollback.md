---
name: failure-counters-outlive-rollback
description: A counter that records a failure, written inside the transaction that the failure rolls back, is not a counter — it is decoration
metadata:
  type: feedback
---

**Anything written to record that something went wrong must not live in the transaction that the
failure aborts.** Attempt counters, lockout tallies, audit rows, tripwires, "last failed at"
timestamps: if the handler's response to a bad request is to `throw`, and the increment is inside
the same transaction, the rollback erases it. The guard looks implemented, tests that only assert
the status code pass, and the counter sits at zero in production.

**Why:** On 2026-09-20 the `/enroll` handler incremented `enrollments.attempts` inside the claim
transaction and then threw a `ProblemError` to produce the 409. Every rejection rolled the
increment straight back, so §5.4's "5 strikes burns the row" — the brute-force guard on the only
unauthenticated endpoint in the system — could never fire. The status codes were all correct; only
a test that read the counter afterwards caught it. Compare [[falsify-the-gate]]: the endpoint tests
were green because they checked what the caller sees, not what the database kept.

**How to apply:**

1. When writing a failure path, ask where the record of the failure lives and whether the current
   transaction commits. If it does not, move the write out — a separate statement before the throw,
   or a `catch` that writes and rethrows.
2. Prefer doing the disambiguation *outside* the transaction altogether when the happy path is the
   only thing that needs atomicity. In `/enroll` the conditional `UPDATE … RETURNING` claims the
   code atomically; everything after a zero-row result is read-only except the counter, so that
   whole branch moved out and the structure got simpler as well as correct.
3. **Test the counter, not the status.** `expect(res.status).toBe(409)` would have passed forever.
   The assertion that mattered was `expect(row.attempts).toBeGreaterThanOrEqual(5)`.
4. Same trap, other shapes: a rate-limit bucket in Postgres, an `occurrences` bump on a tripwire, a
   "notified the parent" flag — any of these written on a path that rolls back.

Note this is the mirror image of the usual advice. Normally you want a write to be inside the
transaction so it cannot be partially applied; for failure bookkeeping you want the opposite,
because the whole point is to survive the failure.

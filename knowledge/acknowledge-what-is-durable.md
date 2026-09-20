---
name: acknowledge-what-is-durable
description: An idempotent endpoint must acknowledge everything now durable, not just what this call wrote — the gap between the two is where the silent bug lives
metadata:
  type: feedback
---

**When an endpoint accepts at-least-once delivery, its acknowledgement covers every item that is
now durable — including the ones that were already there before this call.** Acknowledging only
what *this* request inserted tells the sender its retries never landed, so it retries for ever.

**Why:** `INSERT … ON CONFLICT DO NOTHING RETURNING` returns only newly-inserted rows. That is
almost the right answer, which is exactly what makes it dangerous: the wrong implementation is the
one that falls out of the SQL. On 2026-09-20 `POST /events` had to return `accepted_event_ids` for
every valid event submitted, not for the rows the query handed back. §5.7 spells out the
consequence — *"a conflicting row is still accepted; it is already durable. Returning only
newly-inserted rows would make the agent retry the same batch forever."*

The failure has no error in it anywhere. The agent re-sends, the server accepts, the database stays
consistent, every status code is a 202, and the queue never drains. It would show up as "telemetry
is a bit behind" weeks later.

**How to apply:**

1. Write the acknowledgement from the **protocol's** meaning ("what is safe for you to delete"),
   never from the **primitive's** return value ("what I changed"). If those two differ, say so in a
   comment at the call site — the next reader will assume they are the same.
2. Watch for the same gap in: `ON CONFLICT DO UPDATE … RETURNING` with a `WHERE` clause, bulk
   inserts that skip duplicates, `rowCount` used as a success signal, dedupe-on-write caches, and
   any "created vs already-existed" distinction leaking into a response the caller acts on.
3. Test it with a **second identical request**, and assert the acknowledgement is unchanged. A
   single-request test cannot see this class of bug at all, because the first call is the one case
   where "inserted" and "durable" agree.
4. Per [[falsify-the-gate]], break it deliberately once: point the acknowledgement at the
   primitive's output and confirm the second request comes back empty. That is the retry-forever
   shape, and seeing it is what makes the test trustworthy.

Related in kind, opposite in direction: [[failure-counters-outlive-rollback]] — there the write had
to survive a rollback; here a write that never happened still has to be reported as success.

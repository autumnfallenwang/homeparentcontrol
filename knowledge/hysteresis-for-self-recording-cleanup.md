---
name: hysteresis-for-self-recording-cleanup
description: When a cleanup writes its own audit record, the trigger and the target must be different numbers
metadata:
  type: feedback
---

**Any cleanup that records what it removed needs a trigger threshold and a separate, lower target.**
If it evicts *to* the same number that triggers it, the receipt it writes puts it back over the line
and it runs again — for ever, one item per pass, each pass logging that something was lost.

**Why:** the queue's two-class eviction hit this exactly. §5.7 requires a synthetic `queue.evicted`
audit event because "gaps are data — zero usage and no data look identical on a bar chart and mean
opposite things". That event is itself an event, enqueued into the queue that was just trimmed. With
one threshold the loop never settles.

It was found by a test written specifically to close the loop — apply the plan, enqueue the receipt,
assert the second pass is empty — which failed against the single-threshold version. A 95 % headroom
constant *looked* like it solved it and did not; the fix is that the trigger is the cap and the
target is 95 % of the cap. See [[falsify-the-gate]]: the test existed because the termination
argument was written down and therefore had to be checked.

**How to apply:** whenever cleanup emits something into the thing being cleaned — an eviction
record, a compaction marker, a rotation log line in the log being rotated — name the two thresholds
separately in the code and write the "apply, then re-plan" test. The symptom in production is not a
crash: it is a slow drip of audit rows saying data was dropped, which reads as a capacity problem
rather than a bug.

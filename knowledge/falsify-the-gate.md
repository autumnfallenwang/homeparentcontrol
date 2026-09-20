---
name: falsify-the-gate
description: A safety test that has never been observed to fail proves nothing — break the thing it guards, watch it go red, then restore
metadata:
  type: feedback
---

**Before trusting a test that guards a specific hazard, deliberately reintroduce the hazard and
confirm the test fails.** Then restore and confirm it passes again. A green assertion is evidence
only once you have seen it be red for the right reason.

**Why:** This is the test-level counterpart to [[verify-macos-claims]]. The same failure mode
applies: a passing gate is an unverified claim that *something* was checked. Gates fail silently in
ways that look identical to success — a wrong table name, a fixture that never loaded, an
environment variable that skipped the suite, a mock that swallowed the call. The more dangerous the
hazard, the more likely the gate is a stub nobody has exercised, because nobody wants to break
production to test it.

On 2026-09-20, **B2** (the X2 carve-out: 30 consecutive authenticated calls must all return `200`)
passed on first run. Turning the per-key limiter back on at places 1 and 2 made it fail at
**exactly 10 × 200** — the documented quota, reproduced. That is what earned the gate its green.
The same probe also corrected a claim repeated in five code comments: better-auth's exhausted
limiter throws an `APIError` carrying *no* HTTP status at all, so "401, not 429" is true only of
the raw throw, and `lib/auth-errors.ts` is what makes it an honest 429. Falsifying the gate found a
documentation error nobody was looking for. See [[better-auth-apikey-plugin]].

**A gate that moves must be re-falsified at its new home.** Passing at one call site proves nothing
at another. On 2026-09-20 B2 moved from a three-line `/whoami` stub to the real `POST /sync`, where
every call also does a scope check, seven tripwire comparisons, six writes and a policy read. It
stayed green — but "still green" could equally have meant "still sensitive" or "now measuring
something else entirely", and nothing in the result distinguishes those. Re-arming the limiter at
the new location did: it failed at exactly 10 again. Treat relocating a gate as writing a new one.

**Two more, 2026-09-20 (milestone 03), both found by writing the failure case first:**

- **`check-no-networking.sh` grew a control case.** Once it checked three binaries instead of one,
  three passes read exactly like three real ones even if the detector had silently stopped
  detecting. It now also asserts `HPCSync` **fails** the same test. Where a check has two sides —
  this must be true, that must be false — assert both; the control case *is* the check.
- **The queue's eviction-termination test.** Apply the plan, enqueue the `queue.evicted` receipt,
  assert the second pass is empty. It failed against the implementation, which is how the missing
  hysteresis was found rather than shipped. See [[hysteresis-for-self-recording-cleanup]].

**How to apply:** Whenever a test is the sole guard on an invariant with a silent or unbounded
failure mode — X2, Invariant E ([[enforcement-invariant]]), the `overrides.expires_at` NOT NULL,
the contract artefact guard — spend the extra two minutes:

1. Break the guarded thing (edit the source, not the test).
2. Run only that test. Confirm it fails, and read the failure — it must fail for the *stated*
   reason, not because something else exploded.
3. Restore, re-run, confirm green.
4. Record the falsification in the milestone note, with the observed numbers.

A gate that cannot be made to fail is not a gate. If breaking the source leaves the test green,
the test is the bug — fix it before shipping the feature.

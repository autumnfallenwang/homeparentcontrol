---
name: better-auth-apikey-plugin
description: Two measured gotchas in better-auth 1.4.19's apiKey plugin — metadata is off by default, and its rate-limit error carries no HTTP status
metadata:
  type: feedback
---

Two things about `better-auth@1.4.19`'s `apiKey` plugin that cost time and are not obvious from its
types. Both measured in this repo on 2026-09-20; re-check them if the pin ever moves off `1.4.19`
(it is pinned exactly — see [[sibling-carets-are-not-what-they-run]]).

**1. `metadata` is rejected unless `enableMetadata: true`.** Passing `metadata` to
`auth.api.createApiKey()` without it throws `APIError: Metadata is disabled.` The `apikeys.metadata`
column existing in the schema is not enough. This surfaced as five integration tests failing with
one root cause.

**2. An exhausted per-key rate limit throws an `APIError` with no HTTP status of its own.** The
plugin's default quota is 10 requests / 24 h. Request 11 throws out of `getSession`, and the throw
is indistinguishable from a bad credential — **whatever your catch block returns is what the caller
sees.** So the widely-repeated claim that it "reports 401, not 429" is true only of a naive
handler. Measured with a classifier in place (`isRateLimitError`), the same exhaustion returns a
real `429` + `{ code: "RATE_LIMITED" }`.

**Why this matters here:** that distinction is load-bearing, not cosmetic. The agent maps `401` to
`halt_sync_keep_enforcing` — permanent, silent, still enforcing a policy it can never update. It
maps `429` to "back off and retry" — merely degraded. So `apps/api/src/lib/auth-errors.ts` converts
an unbounded failure into a bounded one. It does **not** make an armed key acceptable; X2's places
1–3 are what keep the limiter off, and [[enforcement-invariant]] is why that matters.

**How to apply:**

- Never call `auth.api.createApiKey()` directly — go through `apps/api/src/lib/device-keys.ts`, the
  single mint site that passes `rateLimitEnabled: false`. Note `apikeys.rate_limit_enabled`
  **defaults to `true`**, so an omitted flag arms the key.
- Never collapse a `getSession` throw to `401` without running it through `isRateLimitError` first.
- If the pinned version changes, re-run the falsification described in [[falsify-the-gate]] rather
  than assuming these still hold.

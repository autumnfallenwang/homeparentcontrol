# 0008 — Credential rotation with a 24-hour overlap

- **Status:** accepted
- **Date:** 2026-09-20
- **Deciders:** Aaron Wang

## Context

Milestone 03's exit criteria include "credential rotation completes with the 24 h server-side
overlap". Nothing behind that phrase existed.

The design document mentions rotation three times and specifies it nowhere:

- §4.5 lists `credential` as one of four `desired[]` kinds and explicitly leaves its `spec`
  undefined, along with `diagnostics` and `self_test`.
- The enrolment response carries `credential.rotate_after`, and no component reads it.
- §5.8's delta table says nothing about rotation at all.

So there was no endpoint, no request or response shape, no statement of what the 24 hours applies
to, and no trigger. The phrase "24 h server-side overlap" was the entire specification.

**The force that actually shapes the design is not the network — it is the filesystem.** A rotation
is one HTTP request and completes in milliseconds, so an agent does not need a day of slack to
finish talking. What it needs is protection against the window between *the server has issued a new
token and considers the old one superseded* and *the agent has that new token durably on disk*.
Those two cannot be made atomic across a network and a filesystem. A power cut inside that window
leaves a Mac holding a credential the server has moved past, which means re-enrolment — performed
by hand, on site, by someone physically present with a one-time code. For a device whose whole
purpose is to run unattended in a child's bedroom, that is the expensive failure.

Against that, the cost of an overlap is one extra valid credential for a day.

## Decision

`POST /api/agent/v1/credential/rotate`, authenticated by the credential being replaced.

1. **Mint the new key first.** If minting fails the device still holds a working credential and
   simply retries. The reverse order can strand it.
2. **The old key stays enabled and gains an `expiresAt` 24 hours out.** The window therefore closes
   inside better-auth whether or not our nightly job ever runs.
3. **`deviceResolver` matches the current key OR the superseded one** while
   `devices.previous_api_key_expires_at` is in the future.
4. **A second rotation inside an open window is refused** with `409` + `hpc_action: backoff`.
5. **The agent rotates when `rotate_after` passes**, not only when a `desired[]` item asks.

Point 3 is the one that makes the rest work, and it was missing from the first implementation. The
old key authenticated perfectly well — better-auth's row was enabled and unexpired — but
`devices.api_key_id` already pointed at the new key, so the device lookup found nothing and
returned `403`. `403` maps to `halt_sync_keep_enforcing`. **The overlap delivered precisely the
stranding it was built to prevent**, and would have done so silently, on a device nobody was
watching. `credential.integration.test.ts`'s "the OLD credential still works immediately after
rotation" is what caught it.

Point 4 exists because each device row remembers exactly one predecessor. Rotating twice inside the
window would leave the first old key enabled, unexpired in our bookkeeping, and referenced by
nothing that would ever disable it. **A credential nothing will revoke is worse than no rotation at
all**, so the second rotation is refused rather than allowed to orphan it.

Point 5 exists because the only documented trigger is a `desired_items` row, and nothing creates
one until the parent UI lands in milestone 04. A credential that renews only when someone remembers
to ask is a credential that never renews.

## Consequences

**Easier.** Rotation is now a routine, unattended operation; a leaked token has a 90-day horizon
instead of the life of the device; and the path is exercised end to end against a real server by
`agent/scripts/e2e-local.sh`.

**Harder, and worth stating plainly.** For 24 hours a device has two valid credentials, so a token
leaked immediately before a rotation stays useful for a day afterwards. That is the trade, taken
deliberately: the alternative failure needs a person to drive to the machine.

**A fourth place X2 can bite.** `mintDeviceKey` is the only minting function, which is exactly why
it is the only one — but rotation is now a second caller, and a rotated key with
`rateLimitEnabled` true would halt sync about ten minutes later while reporting its credential
revoked. `credential.integration.test.ts` asserts the flag on the rotated key specifically.

**Risk worth tracking.** `devices.previous_api_key_id` is bookkeeping, not authority: authentication
happens because better-auth's row is enabled and unexpired. A stale pointer cannot extend a
credential's life on its own. If that ever stops being true — if some future resolver authenticates
*from* this column — the column becomes a way to keep a revoked credential alive, and this ADR
should be revisited before it does.

## Notes

- Related: [0004](./0004-enforcement-invariant.md) — X1b, a rejected credential halts sync and
  never enforcement. Nothing in the rotation path can reach the enforcer, and the cached policy is
  never invalidated by it (X1c).
- `POST /credential/rotate` is guarded by the existing `sync` scope rather than a new one. A new
  permission string would be absent from every key minted before it existed, and `hasPermission`
  treats absent permissions as allowed — so it would be enforced on new devices and silently
  skipped on old ones.
- The 90-day `rotate_after` is a judgement, not a derivation. Long enough that rotation is routine
  rather than constant; short enough that a leaked token has a horizon.

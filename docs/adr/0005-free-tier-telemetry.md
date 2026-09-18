# 0005 — Permission-free telemetry only, and no paid Apple Developer account

- **Status:** accepted
- **Date:** 2026-09-18
- **Deciders:** project owner (captured during POC 2)

## Context

"Auto monitoring and reporting" is one of the owner's four pillars (**P1.4**), but the *depth* was
deliberately deferred (**D.1**) until POC 2 established what a headless root daemon can actually
observe on macOS 26. Two questions were tangled together and had to be separated: **what can be
collected**, and **whether the $99/yr Apple Developer Program is required** (**O.3**).

✅ **The permission ceiling was probed live on macOS 26.6.2 and is three tiers, not two:**

| Tier | Buys | Cost |
|---|---|---|
| **Free** | foreground app bundle ID, per-process CPU, HID idle, power/session/boot events | **no TCC grant, no prompt, no Developer ID — several of these ran from bash** |
| +Screen Recording | window and page **titles** | a TCC grant |
| +per-browser Automation | browser **URLs** | a TCC grant, per browser |
| +Full Disk Access | Apple's own aggregated data (`knowledgeC`) | a TCC grant |

✅ **Root does not bypass TCC** — the most commonly misunderstood fact in this space, now settled:
`knowledgeC.db` is mode-644 and user-owned, yet `ls` on its directory returns *Operation not
permitted*. TCC overrides POSIX and root alike.

## Decision

**Collect the free tier only. Buy nothing.** App bundle identity, **CPU-gated `active_s`**, HID idle,
and power/session events — all verified running with **zero TCC grants** (D.1). The agent is ad-hoc
signed (`codesign -s -`), no bundle, no entitlements, no provisioning profile, **$0** (D.7).

`active_s` is the meter (A.33): `foreground_s` (wall time frontmost), `active_s` (seconds the session
was not idle) and `cpu_pct_avg` ride on every sample, borrowed from PlayCap's CPU-gating idea so that
an idle Spotify window left open overnight does not burn an hour of a budget. Only one app is
frontmost at a time, so per-app `active_s` are disjoint and sum correctly over a day.

| Rejected | Why |
|---|---|
| **Window titles** | Screen Recording — and ✅ it **fails silently**: the call succeeds, returns an empty `kCGWindowName`, with **no prompt and no error**. A whole class of telemetry that appears to work while returning nothing useful |
| **Browser URLs** | A separate tier again, behind per-browser Automation/AppleEvents consent |
| **Apple's `knowledgeC`** | Full Disk Access — and 📄 macOS 26.3 vaulted `RMAdminStore-*` and DeviceActivity captures **beyond FDA entirely** (EPERM even *with* the grant). **Do not build core telemetry on Apple's data; the trend is one-directional** |
| **The $99/yr Apple Developer Program** | See below |

### The test that decided it

✅ **An ad-hoc binary's designated requirement is `cdhash H"…"`, pinned to the exact hash. A
Developer-ID binary's is `identifier "…" and anchor apple`, which survives rebuilds.** And
**identical source rebuilt twice produced different cdhashes** (`d10bff36…` vs `0a7592b6…`) — *even a
no-op rebuild breaks code identity.*

**Therefore any TCC grant under ad-hoc signing dies on every single agent update, including a no-op
one, and a human must walk to the child's Mac and re-grant Full Disk Access after each release.**
That is unworkable, and it is what makes the tiering a hard fork rather than a dial:

> **Richer monitoring is not a feature decision — it is a decision to buy the $99/yr account, for TCC
> reasons entirely independent of notifications**, plus a stable Team ID and pre-provisioned grants,
> for data Apple is actively vaulting.

### The notification-side argument, recorded separately

The $99 buys exactly one capability the free path lacks: **Time Sensitive** notifications. Against it:

- 📄 The child can revoke Time Sensitive in **two clicks** (Notifications → "Allow time sensitive
  alerts", or Focus → "Time Sensitive Notifications"), and **no configuration profile can force it
  back on** — there is no time-sensitive key in the MDM payload.
- 📄 **The cost is recurring with a silent failure mode.** Time Sensitive needs a restricted
  entitlement, which needs an embedded provisioning profile, and Apple states a Developer ID
  provisioning profile is evaluated **at every launch**: *"if your Developer ID provisioning profile
  expires, the app will no longer launch."* A missed renewal in year three would make the warnings
  quietly stop, on a system whose whole value proposition is running unattended for years.
- ✅ The free path is better on the merits anyway: `CFUserNotification` is a **dialog, not a
  notification** — Focus cannot suppress it, the child has no toggle to find, it needs no bundle and
  no entitlement, and it was observed working from a **root daemon** via the `asuser` bridge
  (`rc=0 button=0`). ✅ `osascript` banners also work, observed directly by the owner.

> ⚠️ **The provisioning-profile-expiry claim is documentation-only and untested.** It cannot be
> tested without buying the cert it argues against, and it was the load-bearing argument in the
> original NO-GO. **It does not need to be true for this decision to hold** — the TCC fork above is
> now the primary reason, and the free notification path wins on its own merits.

## Consequences

**Positive**

- **The entire TCC surface disappears.** No grants, no prompts, no Team ID, no $99, no PPPC profile
  to pre-provision — and nothing breaks when the agent updates.
- App-level usage is what "screen time" actually means, so the free tier is not a compromised
  product. It is the viable floor and it is generous.
- Ad-hoc signing keeps the agent buildable and installable by one person with no Apple relationship,
  and there is nothing that can expire.
- The schema stays additive (**P2.5**), and because telemetry is *stored first, interpreted later* in
  JSONB, adding a richer tier is a **backfill, not a migration**.

**Negative**

- **Reports can say "she used Chrome for two hours" and never "what she was doing in it."** No
  titles, no URLs, no site-level breakdown — ever, at this tier. If the owner later wants that
  conversation, it costs $99/yr plus a re-signing story, not an afternoon.
- **The free-tier signals are shallower than they look.** Idle is HID-based, so a video playing
  untouched reads as idle; `cpu_pct_avg` gates activity but does not identify it.
- The OS keeps very little history — `last`/wtmp ≈ 11 months, `pmset` ≈ 7 days, the unified log ≈ 30
  days but only ~1.5 days dense. **Anything with longer retention must be collected and stored by
  us**, which is why the control plane's retention ladder exists at all.
- 📄 BTM attributes an ad-hoc daemon to *"Unknown Developer"* and **notifies the user** that a
  background item was added. Acceptable under **AR.3** — secrecy was never a goal — but it is visible.
- Warnings are attributed to "Script Editor" rather than to a named app. Cosmetic, and the fix (a
  Swift `.app` notifier) stays available at $0.

**Open risks**

- ⚠️ **Five of six audited documentation-derived claims in this project turned out wrong, partly
  wrong or unverifiable** — two with multi-track agreement, one citing Apple DTS directly. Both 📄
  claims above (profile expiry, `RMAdminStore` vaulting) are in that unaudited category.
- ⚠️ All probes are macOS 26.6.2. The version-fragile items are **TCC reach** and **`CGWindowList`
  redaction** — precisely the two this ADR's boundary rests on. Pin the Mac to 26.x.
- ⚖️ The boundary is easy to cross by accident. §3.6 of the spec exists so the first person who wants
  window titles discovers the cdhash problem by reading rather than by shipping. If it is ever
  crossed, the agent **must** self-check with the non-prompting `CGPreflightScreenCaptureAccess()`
  and treat `false` — or an all-empty title set — as "capability absent", never as "no windows".

## Notes

- This decision is **reversible but not cheap**: buying the $99 later means a Developer ID identity,
  re-signing, pre-provisioned grants, a calendar alarm for renewal, and keeping the free
  `CFUserNotification` path as the lapse fallback.
- Sources: [`poc2-findings.md`](../research/poc2-findings.md) §2 #1/#2/#3/#19, §3 (T1, T2, T7), §5
  audit, §6 D.1/O.3 · [`T1-telemetry-ceiling.md`](../research/tracks/T1-telemetry-ceiling.md) ·
  [`T2-runtime-notifications-signing.md`](../research/tracks/T2-runtime-notifications-signing.md) ·
  [`T7-prior-art-screentime.md`](../research/tracks/T7-prior-art-screentime.md) ·
  [`design-decisions.md`](../design-decisions.md) D.1, D.7, §3.3, §3.4, §3.6.

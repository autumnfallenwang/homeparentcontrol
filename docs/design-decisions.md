# homeparentcontrol — Design Decisions

**Date:** 2026-09-18
**Status:** the single buildable specification. Supersedes the eight track files in [`research/tracks/`](./research/tracks/)
wherever they disagree. Requirements are [`requirements.md`](./requirements.md); the authoritative empirical record
is [`research/poc2-findings.md`](./research/poc2-findings.md).

**Evidence classes, used on every load-bearing claim:**

| Mark | Meaning |
|---|---|
| ✅ **observed** | Directly tested on macOS 26.6.2 / arm64, or read out of the house source tree |
| 📄 **documented** | Vendor documentation, DTS guidance, or a cited source. **Not observed** |
| ⚖️ **judgement** | A design or owner decision. Argue with these |

> **Standing rule.** Five of six audited documentation-only claims in POC 2 were wrong, partly wrong
> or unverifiable — two of them with multi-track agreement, one citing Apple DTS directly. A claim
> about observable macOS behaviour is a hypothesis until it has been observed. Nothing in this
> document upgrades a 📄 to a ✅ by being repeated.

---

## 1. Decisions register

### 1.1 Owner decisions (fixed 2026-09-18)

| # | Decision | Evidence |
|---|---|---|
| **D.1** | **Monitoring = FREE TIER ONLY.** App bundle identity, CPU-gated `active_s`, HID idle, power/session events. **No TCC grants anywhere.** No window titles, no URLs, no `knowledgeC`. Schema stays additive so a richer tier is a later migration, not a redesign | ⚖️ owner, on ✅ that the free tier needs no grant and ✅ that an ad-hoc grant dies on every rebuild |
| **D.2** | Reporting delivery (dashboard / digest / alerts / on-demand, and pull-vs-push for agent-death) | **OPEN** — §8 |
| **D.3** | **Enforcement = LOCK → 300 s GRACE → SHUTDOWN** | ⚖️ owner, on four independent arguments (§3.5) |
| **D.4** | Bedtime window vs daily budget | **OPEN** — §8. Mechanically unblocked: `active_s` is the meter |
| **D.5** | **Parent override = ONLINE GRANT ONLY.** One click in the parent UI. The offline HOTP card is **deferred, not cancelled** | ⚖️ owner |
| **D.6** | **Agent language = Swift**, ad-hoc signed, **$0** | ⚖️ owner. Go was runner-up |
| **D.7** | **No paid Apple Developer account.** Ad-hoc signing throughout | ⚖️ owner |
| **O.1** | **Fail-open on ignorance, fail-closed on knowledge** | ⚖️ — §4.6 |
| **O.2** | Does "from my end" ever mean away from home? | **OPEN** — §8 |
| **O.3** | Paid Apple Developer account | **SETTLED — NO-GO.** = D.7 |
| **O.4** | Timeline | **OPEN** — §8 |

> **D.5 note, one line as agreed:** T8's HOTP design (`HMAC-SHA256(K_ovr, device‖day‖minutes‖seq)`,
> duration encoded in the code, static HTML card) is complete in
> [`research/tracks/T8-parent-override.md`](./research/tracks/T8-parent-override.md) if a real outage ever makes an offline
> path necessary. **Nothing in this document implements it.** No shared secret reaches the Mac, no
> `override_keys` / `override_redemptions` / `override_code_reveals` tables exist, and X3's
> reveal-record reconciliation is not in scope.

### 1.2 What today's tests changed

| # | Prior claim | Result | Consequence for the build |
|---|---|---|---|
| E.1 | BTM leaves script / ad-hoc LaunchDaemons `disallowed` after reboot | ❌ **REFUTED** ✅ — both came back `[enabled, allowed, notified] (0xb)` and ran | **Swift is a preference, not a constraint.** BTM *attributes* to "Unknown Developer" and *notifies*; it disallows nothing. Acceptable under AR.3 |
| E.2 | A `.pkg` cannot downgrade | ❌ **REFUTED** ✅ — same identifier, v2.0 then v1.0, *"Upgrading at base path"*, exit 0, payload and receipt reverted. ⚠️ **User domain only; `-target /` with sudo untested** | **Rollback is "install the older pkg."** The versioned-directory + atomic-symlink-flip layout is deleted — §6.4 |
| E.3 | TCC grants detach on agent update under ad-hoc signing | ✅ **CONFIRMED, and worse** — the DR is `cdhash H"…"`, and an identical-source rebuild produced a different cdhash (`d10bff36…` vs `0a7592b6…`) | Irrelevant under D.1 — the free tier needs no grants. **But it is a hard constraint on any future TCC-gated feature** — §3.6 |
| E.4 | launchd delivers SIGTERM at full system shutdown | ✅ **CONFIRMED** — logged 22 s before the next boot, for **both** Swift and bash | **`EXPECTED_OFFLINE` is assertable.** T4 matrix row 27's fallback is not needed — §7.3 |
| E.5 | `os_log` output is retrievable via `log show` | ❌ **NO** ✅ — zero lines from an ad-hoc binary at `.default`/`.error`/`.fault`, by subsystem, by process, by free text | **stdout JSON.** T6's conclusion stands; **T6's `<private>` reasoning does not** — nothing came back at all, so redaction was never reached |
| E.6 | `osascript display notification` produces a banner | ✅ **YES** — observed directly | Banners are live. The `ncprefs`-registration inference that doubted it was wrong |
| E.7 | `CFUserNotification` with a masked text field, from a **root daemon** via `asuser` | ✅ **YES** — `rc=0 button=0 text="1234"` | The modal path works headless. Text entry is proven but **unused under D.5** |
| E.8 | A naive bash sleep loop can trap SIGTERM in time | ⚠️ **No** ✅ — `sleep 30` in a loop defers the trap and was SIGKILLed; `sleep 30 & wait $!` fires in <2 s | Kept as a note: **any sleep loop in any language must wait on an interruptible primitive**, not a blocking sleep — §3.8 |

### 1.3 Architecture and contract

| # | Decision | Evidence |
|---|---|---|
| A.1 | **Agent + inner-network control plane. Agent-initiated only. No inbound port on the Mac, ever** | ⚖️ |
| A.2 | **Three launchd jobs + one periodic one-shot:** `enforcer`, `sync`, `supervisor`, `deadfall` | ⚖️ — §3.1 |
| A.3 | **The enforcer opens no socket and links no HTTP client.** Assertable in CI and at runtime | ⚖️ structural — this is what makes "works with the server down" a property, not a promise |
| A.4 | **The sync daemon is the only component that talks to the control plane API** | ⚖️ — resolves the T3-supervisor / T4-sync overlap, §3.1 |
| A.5 | **Polling, adaptive cadence 60 s / 15 s / 5 s**, server-driven via `next_poll_after_ms`. Build no push | ⚖️ + 📄 (MDM pushes only a content-free wake-up, then the device polls) |
| A.6 | **Desired state, not commands.** No command channel exists | ⚖️ |
| A.7 | **The wire protocol has no "stop enforcing" verb.** Sole exception: an authenticated, parent-initiated `410` decommission | ⚖️ — **the invariant the whole design rests on** |
| A.8 | **Every relaxation carries a mandatory `expires_at`**, enforced as `NOT NULL` | ⚖️ — this is what makes A.9 safe |
| A.9 | **The cached policy never expires.** Staleness changes what the parent is told, never what the agent does | ⚖️ — **X1c**, §4.6 |
| A.10 | **`401` → `halt_sync_keep_enforcing`.** Revocation is an administrative state, never a bypass | ⚖️ — **X1b** |
| A.11 | **There is no `enforcementEnabled` flag** in the policy, the GitOps values, or anywhere on the wire | ⚖️ — **X1**. The legal form is a `suspend` override with an expiry |
| A.12 | **`event_id` is UUIDv7, canonical lowercase hyphenated, on the wire and in the column.** No ULID anywhere | ⚖️ — **X5**, §4.4 |
| A.13 | **The agent authenticates with `x-api-key: hpc_dk_…`** | ⚖️ — **X2**, §5.4. Matches better-auth's house default and gives the `/api/*` limiter per-device keying free |
| A.14 | **Plain HTTP on Traefik `.arch.internal`.** No `tls:` block anywhere | ✅ (chart read) + ⚖️ accepted under AR.2 — **X4**, §5.7 |
| A.15 | **No child-facing surface of any kind.** No login, no status page, no time-remaining widget, no request button | ⚖️ owner, P0.3 / P1.5 / P2.6 — **C1 / X7** |
| A.16 | **Policy is full state, signed as a compact JWS (EdDSA / Ed25519)** | ⚖️ — verify bytes, then parse; no canonicalisation question |
| A.17 | **Policy is authored per child, compiled per device** | ⚖️ — P2.4. The one indirection that makes Mac #2 a five-second job |
| A.18 | **The child is a domain row, never an auth subject** | ⚖️ — P0.3 as an absence in the identity model |
| A.19 | **`devices.away_until`** forces `EXPECTED_OFFLINE`; **not** a policy override | ⚖️ — **X6** |
| A.20 | **`confirm_immediate_effect` guards tightenings only** | ⚖️ — **C3** |
| A.21 | **Device API keys hang off one `isService` user per household** | ✅ `apikeys.userId` is `NOT NULL ON DELETE CASCADE` in the house schema |
| A.22 | **`bump-arch-infra` is a hard failure when the PAT or the Application CR is missing** | ✅ the stock job soft-skips with `exit 0` — §6.6 |
| A.23 | **Rollback = install the older pkg from a local cache.** No versioned directory, no symlink flip | ⚖️ on ✅ E.2 — §6.4 |
| A.24 | **The supervisor never self-updates** | ⚖️ — it is the one component that cannot be rolled back in place |
| A.25 | **stdout JSON → control plane → Loki.** `os_log` gets one breadcrumb at start/stop and nothing else | ✅ E.5 |
| A.26 | **The tick is the heartbeat.** No `/heartbeat` endpoint, ever | ⚖️ — a second liveness path can be healthy while the real one is broken |
| A.27 | **Telemetry is on `/events`, never on the tick.** `audit` flushes immediately, `sample` every 300 s | ⚖️ — a 413 / 429 / poisoned batch must never make a live agent look silent |
| A.28 | **Five health states, computed control-plane-side once a minute**, emitted as a pino line and stored as intervals | ⚖️ — presence-based alerting; §7.3 |
| A.29 | **No ICMP or TCP probe of the Mac, ever** | 📄 a Bonjour Sleep Proxy answers ARP for a sleeping Mac (the probe lies) and Wake-for-network-access means a probe can wake it at 03:00 |
| A.30 | **`policy.timezone` (IANA) wins over the system timezone.** The system zone is reported, never an input | ⚖️ |
| A.31 | **The window predicate is evaluated every tick, never a one-shot trigger** | ⚖️ — immunises the whole system against DST skip/repeat |
| A.32 | **`mach_continuous_time()`** for the monotonic clock | 📄 — `mach_absolute_time()` stops during sleep and would false-positive every morning |
| A.33 | **`active_s` is the meter.** `foreground_s` and `cpu_pct_avg` ride alongside | ⚖️ + ✅ (all three free-tier signals probed live) |
| A.34 | **The policy schema cannot express** disabling Remote Login, changing admin accounts, `sudoers` or FileVault | ⚖️ structural — no bug and no bad push can lock the parent out |
| A.35 | **Kill-switch file is time-boxed by default and alerts on appearance** | ⚖️ — **C2**; the child has admin, §3.7 |
| A.36 | House conventions: `uuid` PKs, `postgres-js`, `casing: "snake_case"`, no `pgEnum` except one `CHECK`, `replicaCount: 1` + `strategy: Recreate` | ✅ read out of the house source |

---

## 2. System overview

Four components. Two of them are the novelty; the other two are a standard `home*` app.

| Component | What it is | Novel? |
|---|---|---|
| **Agent** | Swift, ad-hoc signed, on the child's Mac mini (M4). Three launchd jobs plus a periodic one-shot | ✅ this is the project |
| **Control plane** | Hono API + Postgres in the owner's single-node k3s, `pnpm/turbo → GHCR → Argo CD` | ❌ standard `home*` app plus ~28 deltas |
| **Parent UI** | Next.js, App Router, reached through a browser on the home LAN — **including from a phone** | ❌ standard |
| **Observability** | pino stdout → existing Alloy DaemonSet → Loki → Grafana | ❌ standard, plus 5 alert rules |

```
  Parent's browser  (desktop or phone — NEVER an app: P2.6)
  ┌────────────┐
  │  Next.js   │ ── http://hpc.arch.internal ──┐        plain HTTP, no TLS  (X4, AR.2)
  └────────────┘                               │
                                               ▼
 ┌──────────────── k3s · aaron-desktop-arch ────────────────────────────────────┐
 │  Traefik ingress                                                             │
 │      │                                                                       │
 │      ├─► /api/parent/v1/*   better-auth session cookie   flat {error}         │
 │      └─► /api/agent/v1/*    x-api-key: hpc_dk_…          problem+json         │
 │                                     │                     + hpc_action        │
 │   Hono ── policy compiler (pure fn) ─┤                                        │
 │        ── telemetry ingest  ON CONFLICT (device_id, event_id) DO NOTHING      │
 │        ── desired-state svc  retained until convergence is OBSERVED           │
 │        ── 3 in-process schedulers: liveness 60 s · projection 5 min · nightly │
 │                                     │                                         │
 │   Postgres  households · children · devices · policy_sets · schedule_windows  │
 │             overrides · policy_versions · events(JSONB) · usage_* · …         │
 │                                     │                                         │
 │   pino stdout ─► Alloy DaemonSet ─► Loki ─► Grafana (6 panels, 5 alerts)      │
 └─────────────────────────────────────┬────────────────────────────────────────┘
                                       │
              ▲ agent-initiated, OUTBOUND ONLY.  No inbound port on the Mac.
              │  POST /api/agent/v1/sync     60 s │ 15 s near a boundary │ 5 s attended
              │  POST /api/agent/v1/events   300 s, or immediately for class:"audit"
              │
 ┌────────────┴──────────── child's Mac mini (M4, macOS 26.6.2) ─────────────────┐
 │                                                                               │
 │  com.hpc.sync   (root)          com.hpc.enforcer   (root)                     │
 │  ─ the ONLY thing doing IP      ─ ██ OPENS NO SOCKET, EVER ██                 │
 │  ─ writes policy: tmp+rename(2) ──►  reads policy.current.json                 │
 │  ─ drains queue.sqlite          ◄──  appends spool/*.ndjson                    │
 │  ─ stages agent pkgs            ─ predicate → warn / lock / grace / shutdown   │
 │         │                                                                     │
 │         ▼                                                                     │
 │  com.hpc.supervisor (root)      com.hpc.deadfall  (StartCalendarInterval)      │
 │  ─ watchdog on both heartbeats  ─ regenerated on every policy change           │
 │  ─ installs / rolls back pkgs   ─ re-evaluates the FULL predicate incl.        │
 │  ─ NEVER self-updates             overrides, then locks                        │
 │                                                                               │
 │  /var/db/homeparentcontrol/   root:wheel, dir 0700                            │
 │    policy.current.json 0600   ◄━━ THE ONLY INPUT TO ENFORCEMENT                │
 │    policy.lkg.json     0600       last successfully parsed + verified           │
 │    credential.json     0600       sync daemon only; the enforcer never has it   │
 │    enforcer.health     0600       liveness for the supervisor (NOT a gate)      │
 │    sync.health         0600                                                     │
 │    clean_exit          0600       written BEFORE stopping, cleared on start     │
 │    spool/*.ndjson      0600       enforcer → sync, append-only, single writer    │
 │    queue.sqlite(+-wal) 0600       sync daemon owns it exclusively                │
 │    pkgs/<version>.pkg  0600       rollback cache, newest 3                       │
 │    DISABLE             (absent)   kill switch, time-boxed by default             │
 └───────────────────────────────────────────────────────────────────────────────┘
```

**The load-bearing property:** `enforcerd` has no network code at all. Server down, LAN down,
credential revoked, cluster rebuilt — bedtime still happens, because nothing in the enforcement path
*can* block on the network. A failing `sync` daemon degrades reporting and rule updates. It never
degrades enforcement.

---

## 3. The agent

Swift 6, ad-hoc signed (`codesign -s -`), no bundle, no entitlements, no provisioning profile,
**$0**. ⚖️ Swift is a *preference* — E.1 refuted the BTM argument that made it a constraint, and bash
remains viable end to end for the free-tier product. It is chosen for direct `CFUserNotification`
access, typed policy decoding, structured logging, and a clean path to a signed binary if D.1 is
ever revisited.

### 3.1 Process model

Three long-running launchd jobs and one periodic one-shot. All in the **system** domain, all root.

| Job | Label | Ticks | Network | Contains enforcement logic |
|---|---|---|---|---|
| **Enforcer** | `com.hpc.enforcer` | 60 s, unconditional | ❌ **none** | ✅ all of it |
| **Sync** | `com.hpc.sync` | 60 / 15 / 5 s adaptive | ✅ the only one | ❌ none |
| **Supervisor** | `com.hpc.supervisor` | 60 s | ❌ none (see below) | ❌ none |
| **Deadfall** | `com.hpc.deadfall` | `StartCalendarInterval`, regenerated on policy change | ❌ none | one predicate, one action |

> **⚖️ Resolution of an ambiguity the inputs left.** T3 gave the supervisor its own
> `GET /api/v1/agent/desired` poll loop; T4 then deleted the command channel entirely and T5 folded
> the version pin into `desired[]` on the sync tick. Nobody joined those up. **The sync daemon owns
> all API traffic.** It receives the `kind: "agent_version"` desired item, downloads the pinned pkg,
> verifies the SHA-256, and stages it at `/var/db/homeparentcontrol/pkgs/<version>.pkg`. The
> supervisor watches that directory, **re-verifies the digest itself**, and runs `installer`. One
> network component, and the thing that runs `installer` as root still does its own verification.

**launchd configuration, deliberately** — 📄 `KeepAlive` without `ThrottleInterval` crash-loops at a
10 s default, and launchd can decide a job is thrashing and **stop restarting it permanently**,
which for us means silently no enforcement, forever, with no alert:

```xml
<key>KeepAlive</key>
<dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>30</integer>
<key>ProcessType</key><string>Background</string>
<key>StandardOutPath</key><string>/var/log/homeparentcontrol/enforcer.log</string>
<key>StandardErrorPath</key><string>/var/log/homeparentcontrol/enforcer.log</string>
```

Plists are `root:wheel 0644` in `/Library/LaunchDaemons` — 📄 anything group- or other-writable
fails with `Bootstrap failed: 5: Input/output error`. Use `launchctl bootout` / `bootstrap`, never
the deprecated `load` / `unload`; `launchctl kickstart -k system/<label>` to restart.

**The enforcer's isolation is assertable**, and must be asserted in CI and at runtime:

```sh
lsof -p "$(pgrep -x hpc-enforcer)" | grep -c -E 'TCP|UDP'   # MUST be 0
otool -L /usr/local/libexec/homeparentcontrol/hpc-enforcer  # MUST NOT link URLSession/Network
```

### 3.2 The enforcer tick

Pure function of two inputs: a local file and a clock.

```
every 60 s:
  1. kill switch      — read /var/db/homeparentcontrol/DISABLE FRESH FROM DISK, first, before
                        any other logic. Present and unexpired ⇒ emit audit event, do nothing.
                        If the check itself throws, treat as present. (§3.7)
  2. load policy      — policy.current.json; verify JWS (Ed25519); on failure fall back to
                        policy.lkg.json; on double failure ⇒ FAIL OPEN, loudly (§4.6)
  3. resolve now      — utc_now → policy.timezone (IANA). Never the system timezone. (A.30)
  4. clock sanity     — |Δrealtime − Δcontinuous| > 30 s ⇒ clock.stepped; prefer the monotonic
                        projection from the last server_time until the next successful sync
  5. effective rules  — schedule.windows ∪ policy.overrides[] where expires_at > now
  6. predicate        — is now ∈ [restricted_from, restricted_until) for today's window?
  7. act              — warn / lock / grace / shutdown  (§3.5)
  8. spool            — append an NDJSON event. THE DECISION IS TAKEN BEFORE THIS WRITE, so a
                        failed write drops telemetry and never affects enforcement
  9. health           — write enforcer.health {ts, tick_seq, version, last_decision}
```

**Steps 6 and 7 are a predicate, not a trigger, and that is the entire DST answer.** ⚖️ A cron-style
"fire at 02:30" is *skipped* on spring-forward and *fires twice* on fall-back. A predicate asked
every 60 s has nothing to skip and nothing to repeat. Boundary resolution: a boundary in a skipped
hour snaps forward to the first instant that exists; a boundary in an ambiguous hour resolves toward
enforcement (earlier occurrence for `restricted_from`, later for `restricted_until`).

Warning offsets are computed in **absolute time**: resolve `restricted_from` to an instant using the
IANA zone *first*, then subtract 15/5/1 minutes in UTC. Doing `"21:30" − 15 min = "21:15"` as strings
and resolving afterwards is the bug that fires a warning an hour early on transition night.

Never cache a resolved UTC instant across ticks — `tzdata` changes by government decree. Recompute
from `(local_time_string, tz_name)` every tick, and report `tzdata_version` on every sync.

### 3.3 Warning surfaces

Both paths are ✅ **observed working on this build**, including from a root daemon.

| Lead | Channel | Mechanism | Evidence |
|---|---|---|---|
| T-30 min | banner | `osascript -e 'display notification …'` via the `asuser` bridge | ✅ E.6 — banner displayed |
| T-15 min | banner | same | ✅ E.6 |
| T-5 min | **modal** | `CFUserNotificationCreate` + `ReceiveResponse`, via `asuser` | ✅ E.7 — `rc=0 button=0` from a root daemon |
| T-1 min | **modal** | same, with a timeout | ✅ E.7 |

The session bridge, ⚖️ fire-and-forget rather than a long-lived LaunchAgent — a LaunchAgent runs as
the child and is unloadable by her; the root daemon is not:

```sh
uid=$(/usr/bin/stat -f %u /dev/console)
[ "$uid" -ge 501 ] || exit 0          # login window / fast-user-switch: no target, skip
launchctl asuser "$uid" <notifier> "…"
```

**Why `CFUserNotification` and not `UNUserNotificationCenter`:** 📄 it is documented for *"use in
processes that do not otherwise have user interfaces"*; it is a **dialog, not a notification**, so
Focus cannot suppress it and the child has no toggle to find; it needs no bundle, no entitlement, no
provisioning profile and no $99. Up to three buttons and a timeout. The $99 Time Sensitive path buys
exactly one capability, which the child can revoke in two clicks, which no configuration profile can
force back on, and whose 📄 provisioning profile is evaluated at every launch — so a missed renewal
in year three silently kills the warnings. That last claim remains **documentation-only and
untestable without a paid cert**, and it is the load-bearing argument for the NO-GO. It does not
need to be true for D.7 to hold, because the free path is better on the merits.

⚠️ **Never swallow a failed warning.** 📄 `CGWindowList`-class APIs fail *silently* on macOS; treat
the same posture here. A warning that could not be displayed is a reason **not to enforce this
tick** and an `enforcement.warning_failed` audit event — not a silent no-op.

### 3.4 Telemetry collection — free tier only (D.1)

Every signal below ran live on macOS 26.6.2 with **no TCC grant, no prompt, and no Developer ID** —
✅ all probed directly, several from bash.

| Signal | How | Emitted as |
|---|---|---|
| Foreground app bundle ID | `NSWorkspace.shared.frontmostApplication` (or `lsappinfo front` → `lsappinfo info -only bundleid`) | `app.usage_sample.bundle_id` |
| Per-process CPU | `ps -p <pid> -o %cpu` — PlayCap-style activity gating | `app.usage_sample.cpu_pct_avg` |
| HID idle | `ioreg -c IOHIDSystem` → `HIDIdleTime` (**nanoseconds** — divide by 1e9) | `session.state.idle_s` |
| Console user / lock state | `stat -f %u /dev/console`, `kCGSSessionOnConsoleKey` | `session.state.console_user`, `.screen_locked` |
| Power / sleep / wake | `IORegisterForSystemPower` → `kIOMessageSystemWillSleep` / `kIOMessageSystemHasPoweredOn` | `power.*` |
| Boot time | `sysctl kern.boottime` | `device.system_boot_time` on every tick |

**`active_s` is the meter (A.33).** Three numbers ride on every `app.usage_sample`:
`foreground_s` (wall time frontmost), `active_s` (seconds the session was not idle), and
`cpu_pct_avg`. An idle Spotify window left open overnight must not burn an hour of a budget.
Only one app is frontmost at a time, so per-app `active_s` are **disjoint** and `SUM(active_s)` over
a day is the correct total, not an over-count.

⚠️ **Do not use `NSWorkspace.willSleepNotification`.** 📄 It is AppKit; Apple states daemons are not
allowed to use it and *"should not even be LINKING against AppKit."* The daemon-safe API is IOKit's
`IORegisterForSystemPower`, and you must call `IOAllowPowerChange` to let the sleep proceed.

**Nothing richer is collected.** No `CGWindowListCopyWindowInfo`, no browser Automation, no
`knowledgeC`, no Biome, no `RMAdminStore`. See §3.6 for why that boundary must be defended.

### 3.5 The enforcement ladder — D.3

```
  T-30 ─── banner
  T-15 ─── banner
  T-5  ─── modal
  T-1  ─── modal
  T-0  ─── LOCK                    screen lock; she clears it with her own password
           │
           │  the enforcer RE-LOCKS every tick while the predicate holds.
           │  "Enforcement" is the re-locking, not the lock.
           │
  T+300s ─ SHUTDOWN                 only if the predicate STILL holds
```

`action_options.shutdown_grace_s` defaults to **300**, `CHECK`-constrained to `[0, 3600]`.

**Four independent arguments produced this ladder, and all four survive:**

1. POC 1 — unsaved work.
2. T3 — you cannot SSH into a machine that is off; `shutdown` destroys every remote recovery path.
3. T4 — a corrected policy landing inside the grace window cancels the shutdown. At `boundary`
   cadence that is ≤ 15 s, so the grace period is a real 300-second recovery budget.
4. T8/C4 — a late override is meaningless under bare `shutdown`; there is no screen to act on.

**Two hard rules that follow:**

- ⚖️ **A late grant does not unlock the Mac, and the parent UI must say so in those words.**
  📄 Nothing third-party can draw or act over the macOS lock screen. What actually happens: the grant
  moves the boundary, the predicate evaluates to "outside window", **the enforcer stops re-locking**,
  and she logs back in herself in ~5 s. The UI sentence is:
  *"She'll be able to log back in within about 5 seconds. This won't wake the Mac for her."*
- ⚖️ **Ship two independent lock paths plus a boot-time self-test.** 📄 `ScreenSaverEngine.app` is
  the next `CGSession` — the same class of undocumented internal artefact, and a Hammerspoon issue
  filed on macOS 27's release date already reports the `CGSession` path gone. Replacing one
  undocumented dependency with another is not closing the problem.

**Rate-limiting the enforcement path** is a real control — the worst bug class is not "fires wrongly
once" but "fires in a loop", and a shutdown loop outruns every recovery path because the machine is
never up long enough to reach. See **X9** in §8.4: T3's cap as literally written is incompatible with
this ladder and with per-tick re-locking, and the reconciliation is specified there.

### 3.6 The TCC boundary — stated so nobody crosses it casually

Under D.1 the agent holds **no TCC grants**, so none of this bites today. It is written down because
the first person to want window titles will otherwise discover it the hard way.

> ✅ **An ad-hoc-signed binary's designated requirement is `cdhash H"…"`, pinned to the exact hash —
> and an identical-source rebuild produces a different cdhash.** A Developer-ID binary's DR is
> `identifier "…" and anchor apple`, which survives rebuilds. ✅ **Root does not bypass TCC** —
> `knowledgeC.db` is mode-644 and user-owned, yet `ls` on its directory returns *Operation not
> permitted*.

**Therefore:** any TCC-gated feature under ad-hoc signing requires a human to re-grant the permission
on the child's Mac **after every single agent update, including a no-op rebuild.** That is
unworkable. Adding window titles, browser URLs, or Apple's aggregated data is not a feature decision
— it is a decision to buy the $99/yr account for TCC reasons independent of notifications, to
pin a stable Team ID, and to pre-provision the grants. 📄 And Apple is vaulting its own data release
over release (26.3 put `RMAdminStore-*` beyond FDA entirely), so the target is moving away.

If it is ever done, the agent **must** self-check with the non-prompting
`CGPreflightScreenCaptureAccess()` and treat `false` — or an all-empty `kCGWindowName` set — as
"capability absent", never as "no windows". 📄 The API returns success either way.

### 3.7 Kill switch — C2 corrected

T3 justified `/var/db/homeparentcontrol/DISABLE` as parent-only *because the child is non-admin*.
**She has admin (AR.1).** The rationale is wrong; the control is still worth having, hardened:

| Rule | Why |
|---|---|
| Checked **first**, at the top of the enforcement path | A bug later in the path cannot skip it |
| Read **fresh from disk every tick**, never cached | Otherwise it is not an emergency control |
| **Fails safe** — if the check throws, treat as present | A bug in the guard must never *cause* a lockout |
| **Time-boxed by default.** `{"until": "2026-09-18T23:00:00Z"}`. An empty file is accepted but logged as `indefinite` | "One film night" must not silently become "permanently off" |
| **Its appearance raises a `kill_switch_present` tripwire** and shows in the UI as *"enforcement disabled locally since 20:14"* | ⚖️ **C2's hardening.** The parent finds out tonight, not in March |
| Root-only writable | Defence in depth, **not** a boundary — she has admin |

**Honest limit, stated once:** `sudo touch …/DISABLE` is a total bypass in one command, and so is
`launchctl bootout`. Nothing here resists an admin child. AR.1 covers it; the tell is any attempt to
interfere at all, and every such attempt lands in `tripwires`.

### 3.8 Clean shutdown

✅ **E.4 settles this: launchd delivers SIGTERM at full system shutdown**, 22 s before the next boot,
to both a Swift and a bash daemon. `EXPECTED_OFFLINE` is assertable. T4 matrix row 27's
`expected_online`-only fallback is not needed.

```
on SIGTERM / kIOMessageSystemWillSleep:
    write /var/db/homeparentcontrol/clean_exit {clean:true, reason, stopped_at}, fsync
    emit agent.stopping{reason} as class:"audit"   — best effort, see below
    exit 0
on start:
    read the previous clean_exit → report as agent.clean_exit_previous_run on the FIRST tick
    immediately write {clean:false, boot_id, started_at}
```

**The file is load-bearing; the event is not.** ⚖️ The pre-sleep window is short and not guaranteed
to survive a network round-trip. If every `agent.stopping` POST is lost, the *next* `agent.started`
still carries `clean_exit_previous_run`, so the previous shutdown is classified retrospectively and
correctly. **Do not build the design on the dying breath arriving.**

⚠️ **E.8, kept even though the agent is Swift.** A naive `sleep 30` in a loop defers the SIGTERM trap
until the sleep returns, and launchd SIGKILLs it; `sleep 30 & wait $!` traps in <2 s. The same class
of bug applies to any sleep loop in any language: **the tick must wait on an interruptible primitive
that the signal handler can break** — a `DispatchSourceTimer` on a serial queue, or a
`DispatchSourceSignal`, not `Thread.sleep`.

---

## 4. The contract

Base URL is configuration, not code: `control_plane.base_url`. `http://localhost:8787` and
`http://hpc-api.arch.internal` are the same contract.

### 4.1 Common headers

```
x-api-key:        hpc_dk_9f4c7a2e13b58d06c4e79a2f5b1d8036
Content-Type:     application/json
Accept:           application/json
User-Agent:       hpc-agent/1.4.2 (darwin/arm64; macOS 26.6.2)
X-HPC-Device-Id:  018f2a4c-7b31-7c9e-9d2a-3f5b7c1e4a60
X-HPC-Request-Id: 018f2a4c-8c42-7d1f-a3b8-5e7d9f2c4b61     (UUIDv7, log correlation both ends)
```

**A.13 — `x-api-key`, not `Authorization: Bearer`.** ⚖️ Three things fall out at once: it matches
better-auth's house `apiKeyHeaders` default so the hand-rolled bearer-stripping middleware
disappears; it gives the stock `/api/*` `hono-rate-limiter` **per-device keying for free** at its
already-correct 600/min; and it removes an `Authorization` header from the agent's requests entirely,
which simplifies the pino redaction list. **X4** applies: this crosses the LAN in cleartext.

Every response carries `Date:` (📄 RFC 9110 §6.6.1 — a free, standards-defined clock reference) and,
on policy responses, `ETag:` and `Cache-Control: no-cache`.

Agent-side timeouts, all strictly less than one tick: **connect 5 s, total 20 s.**

**IDs are bare UUIDs** — ⚖️ following the house (`uuid().primaryKey().defaultRandom()`), a deliberate
cosmetic deviation from T4's prefixed-ULID examples. The wire field is a JSON string either way, and
P3.4 is an owner requirement whereas the ID spelling is not. The one prefixed value that survives is
the credential itself, `hpc_dk_…`, because better-auth mints it.

### 4.2 `POST /api/agent/v1/sync` — the tick, and the heartbeat

**Request** (~1.5 KB):

```json
{
  "contract": 1,
  "device": {
    "device_id": "018f2a4c-7b31-7c9e-9d2a-3f5b7c1e4a60",
    "boot_id": "018f2a4c-9d53-7e2a-b4c9-6f8e0a3d5c72",
    "hardware_uuid": "4C3F2A1B-6D5E-4F7A-8B9C-0D1E2F3A4B5C",
    "agent_version": "1.4.2",
    "os_version": "26.6.2",
    "arch": "arm64",
    "system_boot_time": "2026-09-18T07:01:44.000Z"
  },
  "agent": {
    "started_at": "2026-09-18T07:02:11.412Z",
    "uptime_s": 48291,
    "tick_seq": 805,
    "clean_exit_previous_run": true,
    "previous_stop_reason": "shutdown",
    "kill_switch": null,
    "enforcer_health_age_s": 3,
    "capabilities": [
      "policy.v1", "policy.signature.ed25519", "policy.overrides",
      "telemetry.session", "telemetry.app_usage",
      "desired.credential", "desired.diagnostics", "desired.self_test", "desired.agent_version"
    ]
  },
  "clock": {
    "local_utc": "2026-09-18T20:29:58.004Z",
    "system_timezone": "America/New_York",
    "policy_timezone": "America/New_York",
    "tzdata_version": "2026b",
    "using_network_time": true,
    "continuous_ns": 48291004112233,
    "skew_estimate_ms": 240,
    "stepped_since_last_sync": false
  },
  "policy_state": {
    "etag": "W/\"pol-7f3c9a21-v42\"",
    "policy_version": 42,
    "applied_at": "2026-09-16T18:10:03.771Z",
    "age_s": 181795,
    "source": "server",
    "signature_valid": true,
    "using_lkg": false
  },
  "enforcement": {
    "state": "idle",
    "last_eval_at": "2026-09-18T20:29:57.900Z",
    "last_eval_result": "outside_window",
    "active_window_id": null,
    "next_boundary_at": "2026-09-18T20:30:00.000Z",
    "next_boundary_kind": "restrict_start",
    "last_action": { "type": "lock", "at": "2026-09-17T20:35:00.113Z", "result": "ok" },
    "actions_last_24h": 1,
    "consecutive_eval_failures": 0
  },
  "override": {
    "active_grants": [
      { "id": "018f2a4d-1122-7a3b-8c4d-5e6f7a8b9c0d", "minutes": 30,
        "expires_at": "2026-09-19T05:00:00Z" }
    ],
    "minutes_granted_today": 30,
    "grants_today": 1
  },
  "queue": { "depth": 37, "bytes": 21488,
             "oldest_event_at": "2026-09-18T19:41:02.000Z", "evicted_since_last_sync": 0 },
  "converged": [
    { "desired_id": "018f2a4d-2233-7b4c-9d5e-6f7a8b9c0d1e",
      "status": "converged", "observed_at": "2026-09-18T20:15:04.000Z", "detail": null }
  ]
}
```

> **Why the status block stays on the tick and not on `/events`.** ⚠️ `policy_state`,
> `enforcement`, `clock` and `queue` are **heartbeat content, not telemetry** — `DEGRADED` is
> computed from them. If they travelled on the telemetry endpoint, then in exactly the situation
> where telemetry is backed up or being rejected, the control plane would lose the ability to compute
> `DEGRADED`, and a device reporting *"I cannot read my policy"* would be indistinguishable from a
> healthy one. **The most important health signal must not ride the least reliable channel.**

**Response — nothing changed** (`200 OK`, ~300 bytes):

```json
{
  "contract": 1,
  "server_time": "2026-09-18T20:29:58.244Z",
  "device_status": "active",
  "policy": { "unchanged": true, "etag": "W/\"pol-7f3c9a21-v42\"", "policy_version": 42 },
  "desired": [],
  "next_poll_after_ms": 60000,
  "server_capabilities": ["policy.v1", "policy.signature.ed25519", "telemetry.app_usage",
                          "desired.credential", "desired.agent_version"]
}
```

**Response — policy changed**: the same envelope with `"unchanged": false` plus
`"jws": "eyJhbGciOiJFZERTQSIsImtpZCI6…"` — a compact JWS (📄 RFC 7515, `alg: EdDSA` / Ed25519 per RFC
8037). ⚖️ The agent verifies the JWS and **then** parses the payload, so verification happens over
exactly the bytes that were signed and there is no JSON-canonicalisation question. When signing is
disabled the server sends `"document": {…}` and an agent advertising
`policy.signature.ed25519` logs `policy_unsigned`.

**Cadence.** The agent has exactly one timer; everything below is that timer changing its period.
**The server owns it** — every response carries `next_poll_after_ms`, clamped by the agent to
`[1000, 300000]`. The agent's own boundary logic can only ever *shorten* the interval, never lengthen
it, so a server bug cannot slow the agent past 5 minutes and a cold policy cannot make it hammer.

| Mode | Period | Entered when |
|---|---|---|
| `base` | 60 s | default — 1,440 req/day |
| `boundary` | 15 s | within `poll.boundary_lead_s` (900 s) of the next warn-or-enforce transition |
| `attended` | 5 s | the parent has the device page open — a server-side 10-minute sticky flag |
| `backoff` | 1 s → 300 s, **full jitter** | consecutive sync failures. `Retry-After` always wins |

Because sync and enforcement are separate daemons, backoff can never slow enforcement. The
enforcer's 60 s tick is unconditional.

### 4.3 The policy document (the JWS payload)

```json
{
  "policy_version": 43,
  "issued_at": "2026-09-18T20:30:55.000Z",
  "not_before": "2026-09-18T20:30:55.000Z",
  "device_id": "018f2a4c-7b31-7c9e-9d2a-3f5b7c1e4a60",
  "subject": { "child_id": "018f2a4b-6a20-7b8d-8c1f-2e4a6b8d0f31", "display_name": "Lucy" },

  "timezone": "America/New_York",
  "fail_mode": "open",
  "confirm_immediate_effect": false,

  "poll": { "base_interval_s": 60, "boundary_interval_s": 15, "boundary_lead_s": 900 },
  "agent": { "log_level": "info", "diagnostics_retention_days": 7 },

  "schedule": {
    "kind": "windows",
    "windows": [
      {
        "id": "018f2a4b-7c31-7d9e-9a2b-3c5d7e9f1a42",
        "label": "School nights",
        "days": ["sun", "mon", "tue", "wed", "thu"],
        "restricted_from": "21:30",
        "restricted_until": "07:00",
        "action": "shutdown",
        "action_options": { "shutdown_grace_s": 300, "escalate_after_failures": 3 },
        "warnings": [
          { "lead_minutes": 30, "channel": "banner" },
          { "lead_minutes": 15, "channel": "banner" },
          { "lead_minutes": 5,  "channel": "modal"  },
          { "lead_minutes": 1,  "channel": "modal"  }
        ]
      }
    ]
  },

  "overrides": [
    {
      "id": "018f2a4d-1122-7a3b-8c4d-5e6f7a8b9c0d",
      "type": "extend",
      "window_id": "018f2a4b-7c31-7d9e-9a2b-3c5d7e9f1a42",
      "minutes": 30,
      "effective_date": "2026-09-18",
      "expires_at": "2026-09-19T05:00:00Z",
      "granted_by": "018f2a4a-5910-7c7b-9e0d-1f3a5c7e9b20",
      "granted_via": "ui",
      "reason": "finishing history essay"
    }
  ],

  "override_policy": {
    "enabled": true,
    "allowed_minutes": [15, 30, 60],
    "max_minutes_per_day": 120,
    "max_grants_per_day": 3
  },

  "expected_online": [
    { "days": ["mon","tue","wed","thu","fri"], "from": "07:00", "until": "21:45" },
    { "days": ["sat","sun"],                    "from": "08:00", "until": "22:45" }
  ],

  "telemetry": {
    "enabled": true,
    "sample_interval_s": 60,
    "flush_interval_s": 300,
    "collect": ["session.state", "enforcement.*", "power.*", "app.usage_sample"],
    "max_queue_events": 50000,
    "max_queue_bytes": 33554432,
    "max_queue_age_days": 14,
    "audit_retention_days": 90
  },

  "staleness": { "warn_after_s": 86400 }
}
```

**Four fields that encode decisions rather than data:**

- **`fail_mode`** (`"open"` | `"closed"`) — O.1 is a *default*, not a hardcode. §4.6.
- **`action_options.shutdown_grace_s`** — the entire remote-recovery budget for a mistaken policy.
- **`confirm_immediate_effect`** — ⚖️ **C3**: set `true` only for a **tightening** that bites within
  15 minutes. A relaxation never sets it. Firing the guard on every +30-minute grant trains the
  parent to click through it in exactly the case it was built for.
- **`override_policy`** — caps are enforced **in the agent** as well as at write time, so a server
  that would happily issue a 6-hour grant cannot produce a UI that lies.

⚠️ **What is deliberately absent from this document, and must stay absent:**
`staleness.behaviour_after_max_age` and any `max_age` field (**X1c** — there is nothing for it to
do); `enforcement_enabled` in any spelling (**X1**); `override.key` / `offline_codes` / anything HOTP
(**D.5**); any field that could disable Remote Login, alter an admin account, touch `sudoers` or
change FileVault (**A.34**); any child-facing request affordance (**A.15**).

### 4.4 `POST /api/agent/v1/events` — telemetry

Flushed every `flush_interval_s` (300 s), **immediately for any `class: "audit"` event**, and in
2,000-event batches (up to 4 per tick) while draining a backlog.

```json
{
  "contract": 1,
  "device_id": "018f2a4c-7b31-7c9e-9d2a-3f5b7c1e4a60",
  "boot_id": "018f2a4c-9d53-7e2a-b4c9-6f8e0a3d5c72",
  "events": [
    { "event_id": "018f2a4e-0011-7a2b-8c3d-4e5f6a7b8c9d",
      "type": "app.usage_sample", "v": 1, "class": "sample",
      "ts": "2026-09-18T20:26:00.000Z", "seq": 41205,
      "data": { "bundle_id": "com.apple.Safari", "foreground_s": 60,
                "active_s": 47, "cpu_pct_avg": 3.1 } },

    { "event_id": "018f2a4e-0012-7b3c-9d4e-5f6a7b8c9d0e",
      "type": "enforcement.warning_shown", "v": 1, "class": "audit",
      "ts": "2026-09-18T20:25:00.000Z", "seq": 41198,
      "data": { "minutes_remaining": 5, "channel": "modal", "displayed": true } }
  ]
}
```

**Response — `202 Accepted`:**

```json
{
  "contract": 1,
  "accepted_event_ids": ["018f2a4e-0011-7a2b-8c3d-4e5f6a7b8c9d",
                         "018f2a4e-0012-7b3c-9d4e-5f6a7b8c9d0e"],
  "rejected_events": [],
  "next_batch_allowed_in_ms": 0
}
```

> ### X5 — settled: `event_id` is **UUIDv7, canonical lowercase hyphenated**
>
> T4's normative R8 says UUIDv7; every worked example in its §4.4 shows a 26-character Crockford
> ULID. Those are the same 128 bits in two spellings, and `UNIQUE(device_id, event_id)` is the
> **only** thing standing between at-least-once delivery and double-counted reports — two spellings
> silently defeat it, with no error anywhere.
>
> **UUIDv7 wins**, on two grounds: it is what T4's normative text says (the ULIDs were only in
> examples), and it is what the Postgres column type already is.
>
> ⚖️ **And the server rejects rather than normalises** — a deviation from T5-D14. The regex is
> `^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`; a non-conforming
> `event_id` becomes `rejected_events[] {retryable: false}` and increments a
> `bad_event_id_format` counter. A normaliser that accepts both spellings keeps the two-spelling
> hazard alive in the codebase; a reject is one implementation, one format, and loud in dev on day
> one. **Pin this in `packages/contract` and hand it to the agent author as a one-line clarification.**

**Ordering is clock-independent.** `ts` is advisory — the local clock is not trustworthy. Ordering is
`(boot_id, seq)`, and the server records `received_at`. A child stepping the clock scrambles nothing;
it produces a `clock.stepped` audit event and some events with implausible `ts`, which the reporting
layer corrects against `received_at`.

**`413`** → halve the batch and retry. **`429`** → honour `Retry-After`. Every other failure leaves
the batch queued, and **nothing about enforcement or liveness changes**.

### 4.5 The remaining endpoints

| Endpoint | Purpose | Notes |
|---|---|---|
| `GET /api/agent/v1/policy` | Canonical policy resource | Proper RFC 9110 conditional GET with `If-None-Match` → `304`. Used by the agent only on cold start or after a sync response fails schema validation; used by operators with `curl` constantly |
| `POST /api/agent/v1/enroll` | One-time code → durable credential | **The only unauthenticated write endpoint.** §5.5 |
| `GET /api/agent/v1/health` | Unauthenticated liveness of the **server** | `{status, contract_versions, server_time}`. Lets the agent tell *"the network is down"* from *"the API is up and rejecting me"*, which changes what it logs and what the parent is told |

**Desired state (`desired[]`), four kinds and no escape hatch:**

| `kind` | Expresses | Convergence observed when |
|---|---|---|
| `credential` | "the credential you should present is this one" | the server sees the new `key_id` actually used |
| `agent_version` | "you should be running 1.4.2" | the device reports a matching `device.agent_version` |
| `diagnostics` | "a bundle for this window should exist" | the bundle arrives on `/events` tagged with the `desired_id` |
| `self_test` | "a completed enforcement self-test should exist" | the result event arrives |

Reconciliation rules, which are the whole point: **idempotent by `desired_id`**; **re-sent every
tick until converged** — no retry policy, no ack bookkeeping, no dead-letter handling, because there
is no delivery to fail; **the server removes an item when it observes convergence**, not when the
agent claims it; **an unknown `kind` is reported as `status: "unsupported"`, a terminal state**,
never silently ignored and never retried forever.

⚖️ There is deliberately **no `kind: "override_key"`** (D.5) and **no generic key/value kind** — a
generic escape hatch would smuggle the deleted command channel back in.

### 4.6 Failure semantics — O.1

> ## Fail-open on ignorance. Fail-closed on knowledge.
>
> Cannot determine what the rules are → **do not lock**, and alert within one tick.
> Knows the rules and merely cannot reach the server → **enforce exactly as written, indefinitely**.

| Class | Failure | Answer |
|---|---|---|
| **A** | Agent not running at all | **Not addressable in-agent** — the deadfall, plus server-side detection |
| **B** | Running, no cached policy at all | **Fail-open, loudly** |
| **C** | Running, policy corrupt / unparseable / bad signature | **LKG → else fail-open, loudly** |
| **D** | Running, policy valid but stale for days | **Fail-closed — enforce as written, indefinitely** |
| **E** | Running, policy valid, clock untrustworthy | **Fail-closed on the last trusted time basis** |

**Why the split is defensible where a blanket "fail-open" would not be.** ⚖️ The harm is asymmetric
*and so is the recovery*: an unearned hour costs a conversation the next morning; a wrongful 19:00
lockout must be corrected in the moment, by the parent, possibly over a network that is by hypothesis
down, on a machine that is by hypothesis locked — and *a parental control that has ever locked a kid
out wrongly is a parental control that gets uninstalled.*

📄 Saltzer & Schroeder's default-deny argument is being cited against itself: it rests explicitly on
open-failures being **silent**. §7's presence-based dead-man's switch removes that premise. And the
*child-reachable* failure — "the network is down" — is already class D, fail-closed. The fail-open
branches are only "never configured" and "the policy file on disk is corrupt": one happens once at
install, the other requires root. **Neither is reachable by unplugging a cable or turning off Wi-Fi**,
so the learnable-bypass surface is nearly empty.

**In every fail-open branch the agent screams.** `agent.degraded` (class `audit`) every tick with
`reason ∈ {policy_missing, policy_corrupt, policy_unverified}`, the device enters `DEGRADED`, and the
parent gets one banner: *"Lucy's Mac is not enforcing — its rules are missing or unreadable."*
**Fail-open is not fail-silent, and the entire argument above depends on that distinction holding.**

**The deadfall** closes class A. A `StartCalendarInterval` launchd job set to the current policy's
earliest `restricted_from`, rewritten by the sync daemon whenever the schedule changes. It fires,
**re-evaluates the full predicate itself — including `overrides[]`** — and locks. If both main
daemons are dead, bedtime still happens. ~30 lines, ⚖️ optional hardening, on by default.

> ⚠️ The override clause is not decoration: without it, a holiday night with both daemons dead would
> lock at the baseline time. T5 caught this and handed it to the agent author; it is specified here.

**Policy staleness — X1c, settled in T4's favour.** Three candidates, two of them wrong:

- *"After N days, stop enforcing."* ❌ A remotely-triggerable bypass. Unplug the cable for three days
  and bedtime evaporates. It hands the child a switch. **Never.**
- *"After N days, get stricter."* ❌ Punishes the child for the parent's cluster being down.
- *"Keep applying it, forever, and say so loudly."* ✅

This is safe **by construction**, not by care: every relaxation carries a mandatory `expires_at` and
only the baseline schedule is durable, so a stale policy can only ever converge *stricter*. A policy
from three days ago is, at worst, a policy whose grants have all expired. There is no reachable state
in which staleness produces a permanent free pass.

What staleness changes is the wording, and the wording is load-bearing:

> ⚠️ *"Lucy's Mac hasn't checked in for 2 days — **it is still enforcing the rules from Tuesday.**"*

The natural parental fear on seeing "offline" is *"so the rules aren't working"*, which is the exact
opposite of the truth.

### 4.7 Status codes and `hpc_action`

📄 RFC 9457 `application/problem+json`, extended with one machine-readable member:

```json
{
  "type": "https://hpc.arch.internal/problems/device-revoked",
  "title": "Device credential revoked",
  "status": 401,
  "detail": "This device's credential was revoked by the account owner at 2026-09-18T19:02:11Z.",
  "instance": "/api/agent/v1/sync",
  "hpc_action": "halt_sync_keep_enforcing"
}
```

| Code | Meaning | `hpc_action` | Enforcement |
|---|---|---|---|
| 200 / 202 / 304 | success | — | continues |
| 400 | malformed request | `drop_batch` | continues |
| **401** | bad or revoked credential | **`halt_sync_keep_enforcing`** | **continues** |
| 403 | scope violation | `halt_sync_keep_enforcing` | **continues** |
| 409 | enrolment conflict | `reenroll` | continues |
| **410** | **decommissioned by the parent** | **`decommission`** | **stops — the one exception** |
| 413 | payload too large | `halve_batch` | continues |
| 422 | schema rejection | `drop_event` | continues |
| 426 | contract version retired | `upgrade_required` | continues |
| 429 | rate limited | `backoff` (honour `Retry-After`) | continues |
| 5xx / timeout / DNS / TCP | anything else | `backoff` | continues |

> ### X1b — settled: `401` keeps enforcing
>
> T3 §3.3 said a 401 makes the agent *"wipe `credential.json` and disable enforcement (fail-open)"*.
> T4 §4.7 says enforcement **continues**. These are opposite answers on a safety-critical path and
> nobody had noticed. **T4 wins, unambiguously: T3's version makes credential revocation a bypass.**
> Anything that gets the credential revoked — including the child, if she ever notices that a mangled
> `credential.json` produces 401s — would stop enforcement entirely.
>
> A revoked device is an **administrative** state, orthogonal to health and orthogonal to
> enforcement. T3's real worry — *"revoking must never leave a child locked out by a machine that
> can no longer be told to stop"* — is answered by **Decommission**, a deliberate, authenticated,
> parent-initiated action, **not** by overloading an error code.

`decommission` requires a valid credential (so a hostile network cannot spoof it) and is initiated
explicitly by the parent. The agent wipes `policy.*` and `credential.json`, emits a final
`agent.decommissioned` event, and `launchctl bootout`s itself. **Everything else — every error, every
timeout, every silence — leaves enforcement running.**

### 4.8 Schema evolution — P2.5

| # | Rule |
|---|---|
| **R1** | **Tolerant readers in both directions.** Never call `.strict()` on anything under `src/contracts/agent/**` — **banned by lint rule**. Zod's default `.parse()` already strips unknown keys. The agent decodes into a struct that discards unknown members and keeps the raw bytes for the signature check |
| **R2** | **Additive-only within a contract version.** Never rename, never change a type, never repurpose a name |
| **R3** | **Major in the path (`/v1/`), minor in a field (`"contract": 1`).** `426` + `upgrade_required` is the retirement signal, and **it does not stop enforcement** |
| **R4** | **Capability negotiation, not version sniffing.** The server sends a device only what that device advertised. Survives backports, partial rollouts and downgrades, and makes the decision legible in a log line |
| **R5** | **Unknown enum values degrade, they do not crash.** An unrecognised `action` maps to the safe default (`lock`), emits `policy_degraded`, and the parent is told which field and which agent version |
| **R6** | **Unknown desired state is reported, never ignored.** `status: "unsupported"` is terminal |
| **R7** | **Policy is full state, never a diff.** No patch semantics, no partial-apply state |
| **R8** | **Telemetry: store first, interpret later.** The transport knows the envelope and **nothing** about `data`. Unknown `type` is stored verbatim in JSONB and increments `unknown_event_type` — never rejected. `v` is per-`type`, not global |
| **R9** | **Nothing on this boundary is a database row.** The wire shapes live in `packages/contract` as zod schemas, are **not** generated from Drizzle, and emit a JSON-Schema artefact in CI for the Swift agent |

**R4 + R8 together are what make D.1 and D.2 genuinely safe to defer.** Adding per-app reporting
later is a *backfill*, not a migration: the data is already sitting in JSONB waiting for a projection
that has not been written.

---

## 5. The control plane

A standard `home*` app. ⚖️ Take `homework`'s newer conventions (`casing: "snake_case"`,
`src/config.ts`, `createApp()`, `knowledge/`, `closeDb()`) and **`homecal`'s auth wholesale**, because
`homecal` is the only sibling that has any.

### 5.1 Identity chain

```
  households ──< household_members >── users (better-auth)      ← parents, and only parents
      │                                  └─ isService: true     ← owns EVERY device api key (A.21)
      ├──< children ──< policy_sets ──< schedule_windows ──< schedule_warnings
      │        │              │
      │        │              ├──< schedule_budgets             (empty until D.4)
      │        │              └──< expected_online_windows
      │        ├──< calendar_exceptions
      │        └──< overrides                                   ← EVERY relaxation, expires_at NOT NULL
      │
      └──< devices ──> children, policy_sets
              ├──< policy_versions      ← compiled, immutable, content-addressed, signed
              ├──< enrollments · desired_items · tripwires
              └──< events / usage_hourly / usage_daily / session_spans / enforcement_log
                   / agent_status_intervals
```

**Five rules that make this survive growth (P2.4):**

1. **`household_id` is denormalised onto every table.** It is the tenancy key and the single most
   expensive column to add later. 31 bytes a row now.
2. **Policy is authored against a `child`, not a `device`** (A.17). The wire document stays
   per-device; the compiler fans one policy set out into one `policy_version` row per device.
3. **The child is not a user** (A.18). No `users` row, no session, no credential. P0.3 is an absence
   in the identity model, not a UI rule a stray route can violate.
4. **Nothing is seeded.** The first household is *claimed* at first run by extending `homecal`'s
   existing `databaseHooks.user.create.before` hook. A migration-seeded singleton is a hardcoded
   identity wearing a costume.
5. **No singleton anywhere.** No `WHERE id = 1`, no `CHILD_ID` env var, no implicit "the device".

### 5.2 Schema — rules half

House conventions throughout: `uuid().primaryKey().defaultRandom()`,
`timestamp({ withTimezone: true })`, snake_case plural table names, the drizzle-0.45 array form for
table extras, `onDelete: "cascade"` as the default posture, a trailing `relations()` block.

```ts
import { relations, sql, type SQL } from "drizzle-orm";
import { boolean, check, date, index, integer, jsonb, pgTable, smallint,
         text, time, timestamp, unique, uuid } from "drizzle-orm/pg-core";

// better-auth core (users / sessions / accounts / verifications / apikeys) is copied from
// homecal verbatim. Two facts matter here and are handled in §5.4:
//   users.isService            — exists already in homecal
//   apikeys.userId             — NOT NULL ON DELETE CASCADE   ✅ verified in their schema
//   apikeys.rateLimitEnabled   — defaults to TRUE per row     ✅ verified in their schema

export const households = pgTable("households", {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
  timezone: text().notNull().default("America/New_York"),   // IANA, never an offset (A.30)
  holidayCountries: text().array(),
  holidaysEnabled: boolean().notNull().default(true),
  // A.21 — device keys MUST hang off this user, not off a human parent. apikeys.userId is
  // NOT NULL ON DELETE CASCADE, so deleting a parent would otherwise silently revoke every Mac.
  serviceUserId: uuid().references(() => users.id, { onDelete: "restrict" }),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const householdMembers = pgTable("household_members", {
  id: uuid().primaryKey().defaultRandom(),
  householdId: uuid().notNull().references(() => households.id, { onDelete: "cascade" }),
  userId: uuid().notNull().references(() => users.id, { onDelete: "cascade" }),
  role: text().notNull().default("parent"),                 // owner | parent — Zod-enforced
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("household_members_household_id_idx").on(t.householdId),
  unique("household_members_household_user_unique").on(t.householdId, t.userId),
]);

// A.18 — a DOMAIN row, never an auth subject. No users row, no session, no credential.
export const children = pgTable("children", {
  id: uuid().primaryKey().defaultRandom(),
  householdId: uuid().notNull().references(() => households.id, { onDelete: "cascade" }),
  displayName: text().notNull(),
  timezone: text(),                                          // NULL = inherit household
  archivedAt: timestamp({ withTimezone: true }),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("children_household_id_idx").on(t.householdId)]);

export const devices = pgTable("devices", {
  id: uuid().primaryKey().defaultRandom(),
  householdId: uuid().notNull().references(() => households.id, { onDelete: "cascade" }),
  childId: uuid().notNull().references(() => children.id, { onDelete: "restrict" }),
  policySetId: uuid().references(() => policySets.id, { onDelete: "restrict" }),
  label: text().notNull(),                                   // "Lucy's Mac mini"

  hardwareUuid: text(),                                      // survives an OS reinstall (§5.6)
  hostname: text(),
  model: text(),

  // Administrative lifecycle. ORTHOGONAL to health state: a revoked device is still alive and
  // still enforcing.  pending | enrolled | active | revoked | decommissioned
  status: text().notNull().default("pending"),
  apiKeyId: uuid().references(() => apikeys.id, { onDelete: "set null" }),

  // Denormalised current state, written by the sync handler every tick, so "Today" is one read.
  lastSyncAt: timestamp({ withTimezone: true }),
  lastTickSeq: integer(),
  lastBootId: text(),
  systemBootTime: timestamp({ withTimezone: true }),         // gap attribution, §7.4
  agentVersion: text(),
  osVersion: text(),
  arch: text(),
  appliedPolicyVersion: integer(),
  healthState: text().notNull().default("UNENROLLED"),
  healthReason: text(),
  healthSince: timestamp({ withTimezone: true }),

  // A.19 / X6 — forces EXPECTED_OFFLINE so a school holiday cannot make SILENT_TOO_LONG fire
  // benignly and get the channel muted. NOT an override: an away device must still enforce
  // bedtime the moment it is switched on.
  awayUntil: timestamp({ withTimezone: true }),
  // Server-side sticky flag behind the 5 s `attended` cadence. Set by opening the device page.
  attendedUntil: timestamp({ withTimezone: true }),

  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("devices_household_id_idx").on(t.householdId),
  index("devices_child_id_idx").on(t.childId),
  // Not globally unique — a decommissioned device keeps its hardwareUuid so a replacement can be
  // recognised. Uniqueness is enforced in the enrol handler against the live statuses.
  index("devices_hardware_uuid_idx").on(t.hardwareUuid),
]);

export const policySets = pgTable("policy_sets", {
  id: uuid().primaryKey().defaultRandom(),
  householdId: uuid().notNull().references(() => households.id, { onDelete: "cascade" }),
  childId: uuid().notNull().references(() => children.id, { onDelete: "cascade" }),
  name: text().notNull().default("Default"),
  kind: text().notNull().default("windows"),                 // D.4 discriminator

  failMode: text().notNull().default("open"),                // O.1, per policy set
  agentLogLevel: text().notNull().default("info"),
  diagnosticsRetentionDays: integer().notNull().default(7),

  pollBaseIntervalS: integer().notNull().default(60),
  pollBoundaryIntervalS: integer().notNull().default(15),
  pollBoundaryLeadS: integer().notNull().default(900),

  // D.5 — ONLINE GRANTS ONLY. There is deliberately no offlineCodes* column, no digit count,
  // no day window, no seq cap, no attempt throttle. If the HOTP card is ever revived, those
  // arrive as an additive migration alongside the tables it needs.
  overrideEnabled: boolean().notNull().default(true),
  overrideAllowedMinutes: smallint().array().notNull().default([15, 30, 60]),
  overrideMaxMinutesPerDay: integer().notNull().default(120),
  overrideMaxGrantsPerDay: integer().notNull().default(3),

  telemetryEnabled: boolean().notNull().default(true),
  telemetrySampleIntervalS: integer().notNull().default(60),
  telemetryFlushIntervalS: integer().notNull().default(300),
  telemetryCollect: text().array().notNull()
    .default(["session.state", "enforcement.*", "power.*", "app.usage_sample"]),
  telemetryMaxQueueEvents: integer().notNull().default(50000),
  telemetryMaxQueueBytes: integer().notNull().default(33554432),
  telemetryMaxQueueAgeDays: integer().notNull().default(14),
  telemetryAuditRetentionDays: integer().notNull().default(90),

  // X1c — warn only. There is NO stalenessMaxAgeS, because a TTL that relaxes enforcement is a
  // remotely-triggerable bypass and there is nothing for such a column to do.
  stalenessWarnAfterS: integer().notNull().default(86400),

  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("policy_sets_child_id_idx").on(t.childId),
  check("policy_sets_override_caps_check", sql`
    ${t.overrideMaxMinutesPerDay} BETWEEN 0 AND 480
    AND ${t.overrideMaxGrantsPerDay} BETWEEN 0 AND 10`),
]);

export const scheduleWindows = pgTable("schedule_windows", {
  id: uuid().primaryKey().defaultRandom(),
  householdId: uuid().notNull().references(() => households.id, { onDelete: "cascade" }),
  policySetId: uuid().notNull().references(() => policySets.id, { onDelete: "cascade" }),
  label: text().notNull(),
  days: text().array().notNull(),                            // ["sun","mon",…] — wire-identical
  restrictedFrom: time().notNull(),
  restrictedUntil: time().notNull(),
  // Derived ONCE so the UI, the compiler and the validator cannot each re-derive the wrap rule
  // slightly differently. Three re-derivations is how an off-by-one-night bug ships.
  crossesMidnight: boolean().generatedAlwaysAs((): SQL =>
    sql`${scheduleWindows.restrictedUntil} <= ${scheduleWindows.restrictedFrom}`),

  // ★ THE ONE DEVIATION from the house's no-DB-enums convention (A.34). This is the column that
  //   can power off a child's computer; its domain does not belong in a Zod schema living inside
  //   the process that might have the bug. A CHECK is the minimum-blast-radius form.
  action: text().notNull().default("lock"),
  shutdownGraceS: integer().notNull().default(300),          // D.3
  escalateAfterFailures: smallint().notNull().default(3),

  sortOrder: smallint().notNull().default(0),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("schedule_windows_policy_set_id_idx").on(t.policySetId),
  check("schedule_windows_action_check",
    sql`${t.action} IN ('warn_only', 'lock', 'shutdown')`),
  check("schedule_windows_days_check",
    sql`${t.days} <@ ARRAY['mon','tue','wed','thu','fri','sat','sun']::text[]
        AND array_length(${t.days}, 1) >= 1`),
  check("schedule_windows_distinct_bounds_check",
    sql`${t.restrictedFrom} <> ${t.restrictedUntil}`),
  check("schedule_windows_grace_check", sql`${t.shutdownGraceS} BETWEEN 0 AND 3600`),
]);

export const scheduleWarnings = pgTable("schedule_warnings", {
  id: uuid().primaryKey().defaultRandom(),
  householdId: uuid().notNull().references(() => households.id, { onDelete: "cascade" }),
  windowId: uuid().notNull().references(() => scheduleWindows.id, { onDelete: "cascade" }),
  leadMinutes: smallint().notNull(),
  channel: text().notNull().default("modal"),                // banner | modal  (§3.3)
}, (t) => [
  index("schedule_warnings_window_id_idx").on(t.windowId),
  unique("schedule_warnings_window_lead_unique").on(t.windowId, t.leadMinutes),
  check("schedule_warnings_lead_check", sql`${t.leadMinutes} BETWEEN 1 AND 240`),
]);

// D.4's seat. Ships EMPTY. `meter` defaults to active_s (A.33) — recorded in the schema so it
// cannot be forgotten when someone finally builds budgets.
export const scheduleBudgets = pgTable("schedule_budgets", {
  id: uuid().primaryKey().defaultRandom(),
  householdId: uuid().notNull().references(() => households.id, { onDelete: "cascade" }),
  policySetId: uuid().notNull().references(() => policySets.id, { onDelete: "cascade" }),
  days: text().array().notNull(),
  budgetMinutes: integer().notNull(),
  meter: text().notNull().default("active_s"),
  resetAt: time().notNull().default("04:00"),
  action: text().notNull().default("lock"),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("schedule_budgets_policy_set_id_idx").on(t.policySetId),
  check("schedule_budgets_action_check", sql`${t.action} IN ('warn_only','lock','shutdown')`),
  check("schedule_budgets_meter_check", sql`${t.meter} IN ('active_s','foreground_s')`),
]);

// Drives EXPECTED_OFFLINE, never enforcement.
export const expectedOnlineWindows = pgTable("expected_online_windows", {
  id: uuid().primaryKey().defaultRandom(),
  householdId: uuid().notNull().references(() => households.id, { onDelete: "cascade" }),
  policySetId: uuid().notNull().references(() => policySets.id, { onDelete: "cascade" }),
  days: text().array().notNull(),
  fromTime: time().notNull(),
  untilTime: time().notNull(),
}, (t) => [index("expected_online_windows_policy_set_id_idx").on(t.policySetId)]);

// Parent INTENT only. date-holidays is called LIVE at compile time; this table never mirrors it.
export const calendarExceptions = pgTable("calendar_exceptions", {
  id: uuid().primaryKey().defaultRandom(),
  householdId: uuid().notNull().references(() => households.id, { onDelete: "cascade" }),
  childId: uuid().references(() => children.id, { onDelete: "cascade" }),   // NULL = all children
  day: date().notNull(),
  effect: text().notNull(),         // treat_as_weekend | no_bedtime | custom | dismiss_holiday
  extendMinutes: integer(),
  windowId: uuid().references(() => scheduleWindows.id, { onDelete: "cascade" }),
  note: text(),
  createdBy: uuid().references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("calendar_exceptions_household_day_idx").on(t.householdId, t.day),
  unique("calendar_exceptions_child_day_window_unique").on(t.childId, t.day, t.windowId),
  check("calendar_exceptions_effect_check", sql`${t.effect} IN
    ('treat_as_weekend','no_bedtime','custom','dismiss_holiday')`),
  check("calendar_exceptions_minutes_check",
    sql`${t.effect} <> 'custom' OR ${t.extendMinutes} > 0`),
]);

// ═══ EVERY relaxation in the system is a row here. ONE table, because D.5 removed the other two.
export const overrides = pgTable("overrides", {
  id: uuid().primaryKey().defaultRandom(),
  householdId: uuid().notNull().references(() => households.id, { onDelete: "cascade" }),
  childId: uuid().notNull().references(() => children.id, { onDelete: "cascade" }),
  deviceId: uuid().references(() => devices.id, { onDelete: "cascade" }),   // NULL = all devices
  type: text().notNull().default("extend"),                  // extend | suspend | grant_minutes
  windowId: uuid().references(() => scheduleWindows.id, { onDelete: "cascade" }),
  minutes: integer(),
  effectiveDate: date().notNull(),

  // ★ A.8 / the load-bearing constraint in this schema. There is no column in which to store
  //   "never expires", so no feature added later can create a permanent relaxation.
  expiresAt: timestamp({ withTimezone: true }).notNull(),

  // D.5 — 'ui' | 'calendar' ONLY. 'offline_code' is not a value, because offline codes do not
  // exist. If they are ever revived, redemptions get their OWN table and are NEVER compiled
  // back into policy.overrides[] (a spent grant that re-arms itself is maddening to reproduce).
  grantedVia: text().notNull().default("ui"),
  grantedBy: uuid().references(() => users.id, { onDelete: "set null" }),
  sourceExceptionId: uuid().references(() => calendarExceptions.id, { onDelete: "cascade" }),
  reason: text(),

  revokedAt: timestamp({ withTimezone: true }),
  revokedBy: uuid().references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("overrides_child_effective_date_idx").on(t.childId, t.effectiveDate),
  index("overrides_expires_at_idx").on(t.expiresAt),
  check("overrides_type_check", sql`${t.type} IN ('extend','suspend','grant_minutes')`),
  check("overrides_granted_via_check", sql`${t.grantedVia} IN ('ui','calendar')`),
  check("overrides_minutes_check", sql`${t.type} = 'suspend' OR ${t.minutes} > 0`),
]);

// ═══ THE WIRE ARTEFACT — immutable, append-only, content-addressed.
export const policyVersions = pgTable("policy_versions", {
  id: uuid().primaryKey().defaultRandom(),
  householdId: uuid().notNull().references(() => households.id, { onDelete: "cascade" }),
  deviceId: uuid().notNull().references(() => devices.id, { onDelete: "cascade" }),
  policySetId: uuid().notNull().references(() => policySets.id, { onDelete: "restrict" }),
  version: integer().notNull(),                              // monotonic PER DEVICE
  document: jsonb().notNull(),                               // the EXACT bytes that were signed
  documentHash: text().notNull(),                            // sha256(canonical JSON)
  jws: text(),
  signingKeyId: text(),
  etag: text().notNull(),                                    // W/"pol-<hash12>-v<version>"
  issuedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  notBefore: timestamp({ withTimezone: true }).notNull().defaultNow(),
  // A.20 / C3 — set TRUE only for a TIGHTENING that bites within 15 min. Relaxations exempt.
  confirmImmediateEffect: boolean().notNull().default(false),
  publishedBy: uuid().references(() => users.id, { onDelete: "set null" }),
  publishReason: text(),          // schedule_edit | override | calendar | restore
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("policy_versions_device_version_unique").on(t.deviceId, t.version),
  index("policy_versions_device_created_at_idx").on(t.deviceId, t.createdAt),
  index("policy_versions_etag_idx").on(t.etag),
]);

// Per-device operational intent that must NOT be persisted into the policy cache.
// Re-sent EVERY tick until the server OBSERVES convergence.
export const desiredItems = pgTable("desired_items", {
  id: uuid().primaryKey().defaultRandom(),
  householdId: uuid().notNull().references(() => households.id, { onDelete: "cascade" }),
  deviceId: uuid().notNull().references(() => devices.id, { onDelete: "cascade" }),
  kind: text().notNull(),
  spec: jsonb().notNull(),
  status: text().notNull().default("pending"),               // pending | converged | unsupported
  unsupportedDetail: text(),
  observedAt: timestamp({ withTimezone: true }),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("desired_items_device_status_idx").on(t.deviceId, t.status),
  // D.5 — 'override_key' is NOT a kind. No generic escape hatch: that would smuggle the deleted
  // command channel back in through the side door.
  check("desired_items_kind_check",
    sql`${t.kind} IN ('credential','diagnostics','self_test','agent_version')`),
]);

export const enrollments = pgTable("enrollments", {
  id: uuid().primaryKey().defaultRandom(),
  householdId: uuid().notNull().references(() => households.id, { onDelete: "cascade" }),
  deviceId: uuid().notNull().references(() => devices.id, { onDelete: "cascade" }),
  codeHash: text().notNull(),                                // sha256 of the normalised code
  codeHint: text().notNull(),                                // "HPC-K7QM" — which code is this
  expiresAt: timestamp({ withTimezone: true }).notNull(),
  consumedAt: timestamp({ withTimezone: true }),
  consumedIp: text(),
  consumedHardwareUuid: text(),
  reissueCount: smallint().notNull().default(0),
  attempts: smallint().notNull().default(0),
  createdBy: uuid().references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("enrollments_code_hash_unique").on(t.codeHash),
  index("enrollments_device_id_idx").on(t.deviceId),
]);
```

**Deleted relative to T5, and it should stay deleted:** `override_keys`, `override_redemptions`,
`override_code_reveals`, `policy_sets.offlineCodes*` (six columns), `desired_items.kind =
'override_key'`, `overrides.grantedVia = 'offline_code'`, and `tripwires.kind =
'override_unmatched'`. All of it exists only to serve the offline HOTP card (**D.5**).

### 5.3 Schema — telemetry half

```ts
// ═══ RAW LANDING ZONE — R8, "store first, interpret later".
export const events = pgTable("events", {
  // No surrogate PK — (device_id, event_id) IS the key.
  householdId: uuid().notNull().references(() => households.id, { onDelete: "cascade" }),
  deviceId: uuid().notNull().references(() => devices.id, { onDelete: "cascade" }),
  // A.12 / X5 — UUIDv7, canonical lowercase hyphenated. The ingest handler REJECTS anything
  // else with retryable:false; it does NOT normalise. One spelling, one format, loud in dev.
  eventId: uuid().notNull(),
  type: text().notNull(),                                    // NEVER rejected when unknown (R8)
  v: smallint().notNull().default(1),
  class: text().notNull(),                                   // 'sample' | 'audit'
  ts: timestamp({ withTimezone: true }).notNull(),           // agent clock: ADVISORY
  receivedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),   // authoritative
  bootId: text().notNull(),                                  // agent-generated, opaque → text
  seq: integer().notNull(),                                  // (bootId, seq) is the true ordering
  data: jsonb().notNull(),
}, (t) => [
  unique("events_device_event_unique").on(t.deviceId, t.eventId),   // idempotency — non-negotiable
  index("events_device_ts_idx").on(t.deviceId, t.ts),               // projector + psql archaeology
  index("events_received_at_brin_idx").using("brin", t.receivedAt), // the retention prune
]);

// Watermark per projection. Keyed on received_at (server clock), NEVER on ts — a child stepping
// the local clock backwards must not push her own events permanently behind the watermark.
export const projectionState = pgTable("projection_state", {
  name: text().primaryKey(),                                 // usage_hourly | sessions | enforcement
  watermarkReceivedAt: timestamp({ withTimezone: true }).notNull()
    .default(sql`'epoch'::timestamptz`),
  lastRunAt: timestamp({ withTimezone: true }),
  lastRunRows: integer().notNull().default(0),
  lastError: text(),
});

export const usageHourly = pgTable("usage_hourly", {
  id: uuid().primaryKey().defaultRandom(),
  householdId: uuid().notNull().references(() => households.id, { onDelete: "cascade" }),
  deviceId: uuid().notNull().references(() => devices.id, { onDelete: "cascade" }),
  childId: uuid().notNull().references(() => children.id, { onDelete: "cascade" }),
  bucketStart: timestamp({ withTimezone: true }).notNull(),  // UTC hour boundary
  bundleId: text().notNull(),                                // "com.apple.Safari"
  foregroundS: integer().notNull().default(0),
  // ★ A.33 — the meter. Only one app is frontmost at a time, so per-app active_s are DISJOINT
  //   and SUM() over a day is correct, not an over-count. This looks wrong; do not "fix" it.
  activeS: integer().notNull().default(0),
  cpuPctAvg: integer().notNull().default(0),                 // ×100, basis points
  sampleCount: smallint().notNull().default(0),
  // D.1 — there are deliberately NO title/url columns. Adding them is additive (R2) AND requires
  // a TCC grant, which under ad-hoc signing dies on every rebuild (§3.6). Read that first.
  projectedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("usage_hourly_device_bucket_bundle_unique").on(t.deviceId, t.bucketStart, t.bundleId),
  index("usage_hourly_child_bucket_idx").on(t.childId, t.bucketStart),
]);

export const usageDaily = pgTable("usage_daily", {
  id: uuid().primaryKey().defaultRandom(),
  householdId: uuid().notNull().references(() => households.id, { onDelete: "cascade" }),
  deviceId: uuid().notNull().references(() => devices.id, { onDelete: "cascade" }),
  childId: uuid().notNull().references(() => children.id, { onDelete: "cascade" }),
  // ★ LOCAL day in policy.timezone, NOT date_trunc('day', ts) in UTC. Get this wrong and Sunday
  //   evening shows up on Monday — the first thing a parent notices, the last thing anyone checks.
  localDay: date().notNull(),
  bundleId: text().notNull(),
  foregroundS: integer().notNull().default(0),
  activeS: integer().notNull().default(0),
  projectedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("usage_daily_device_day_bundle_unique").on(t.deviceId, t.localDay, t.bundleId),
  index("usage_daily_child_day_idx").on(t.childId, t.localDay),
]);

export const sessionSpans = pgTable("session_spans", {
  id: uuid().primaryKey().defaultRandom(),
  householdId: uuid().notNull().references(() => households.id, { onDelete: "cascade" }),
  deviceId: uuid().notNull().references(() => devices.id, { onDelete: "cascade" }),
  childId: uuid().notNull().references(() => children.id, { onDelete: "cascade" }),
  kind: text().notNull(),                                    // awake | active | locked | asleep
  startedAt: timestamp({ withTimezone: true }).notNull(),
  endedAt: timestamp({ withTimezone: true }),                // NULL = still open
  bootId: text(),
  consoleUser: text(),
  // TRUE when the end was inferred from silence rather than observed. Renders as a dashed edge —
  // an honest "we don't actually know".
  endInferred: boolean().notNull().default(false),
}, (t) => [
  index("session_spans_device_started_at_idx").on(t.deviceId, t.startedAt),
  unique("session_spans_device_kind_started_unique").on(t.deviceId, t.kind, t.startedAt),
]);

// THIS IS THE PRODUCT — what a parent means when they ask "but what actually happened?".
export const enforcementLog = pgTable("enforcement_log", {
  id: uuid().primaryKey().defaultRandom(),
  householdId: uuid().notNull().references(() => households.id, { onDelete: "cascade" }),
  deviceId: uuid().notNull().references(() => devices.id, { onDelete: "cascade" }),
  childId: uuid().notNull().references(() => children.id, { onDelete: "cascade" }),
  eventId: uuid().notNull(),            // back-reference into events; survives its pruning
  kind: text().notNull(),               // warning_shown | warning_failed | action_taken |
                                        // action_failed | policy_applied | policy_rejected |
                                        // degraded | clock_stepped | override_granted |
                                        // override_expired | queue_evicted | kill_switch_present |
                                        // agent_started | agent_stopping
  occurredAt: timestamp({ withTimezone: true }).notNull(),
  windowId: uuid().references(() => scheduleWindows.id, { onDelete: "set null" }),
  policyVersion: integer(),
  // The one denormalised human-readable line the report renders. Composed at projection time so
  // a schema change to `detail` cannot break old history.
  summary: text().notNull(),
  detail: jsonb(),
  projectedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("enforcement_log_event_id_unique").on(t.eventId),
  index("enforcement_log_child_occurred_at_idx").on(t.childId, t.occurredAt),
  index("enforcement_log_device_kind_idx").on(t.deviceId, t.kind),
]);

// Five states stored as INTERVALS — ~8 rows/day, not 1,440. See §7.3.
export const agentStatusIntervals = pgTable("agent_status_intervals", {
  id: uuid().primaryKey().defaultRandom(),
  householdId: uuid().notNull().references(() => households.id, { onDelete: "cascade" }),
  deviceId: uuid().notNull().references(() => devices.id, { onDelete: "cascade" }),
  state: text().notNull(),
  reason: text(),
  enteredAt: timestamp({ withTimezone: true }).notNull(),
  exitedAt: timestamp({ withTimezone: true }),
  // Enter UNEXPECTED_SILENCE at 10 min, but do not notify until 60 — a macOS update restart
  // routinely exceeds 10 minutes on Apple silicon.
  notifiedAt: timestamp({ withTimezone: true }),
  // Retrospective reclassification: if system_boot_time lands inside the silence window, the Mac
  // was simply off, and the interval is rewritten to EXPECTED_OFFLINE after the fact. §7.4.
  reclassifiedFrom: text(),
}, (t) => [index("agent_status_intervals_device_entered_at_idx").on(t.deviceId, t.enteredAt)]);

// Cheap non-boundary signals. Surfaced as ONE banner, never eight alerts, and under AR.1
// deliberately never as a notification: the value is that the history exists when someone later
// asks "has she ever tried?".
export const tripwires = pgTable("tripwires", {
  id: uuid().primaryKey().defaultRandom(),
  householdId: uuid().notNull().references(() => households.id, { onDelete: "cascade" }),
  deviceId: uuid().notNull().references(() => devices.id, { onDelete: "cascade" }),
  kind: text().notNull(),               // hardware_uuid_mismatch | unexpected_source_ip |
                                        // concurrent_boot_ids | signature_invalid |
                                        // policy_version_regression | network_time_disabled |
                                        // timezone_mismatch | agent_stopped_while_up |
                                        // kill_switch_present
  firstSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  occurrences: integer().notNull().default(1),
  detail: jsonb(),
  acknowledgedAt: timestamp({ withTimezone: true }),
  acknowledgedBy: uuid().references(() => users.id, { onDelete: "set null" }),
}, (t) => [
  unique("tripwires_device_kind_unique").on(t.deviceId, t.kind),
  index("tripwires_household_last_seen_idx").on(t.householdId, t.lastSeenAt),
]);

// D.2 support — one query service, four sinks, no commitment. Both tables are tiny and exist on
// day one so that "turn on the weekly email" is a config flag rather than a migration.
export const notifications = pgTable("notifications", {
  id: uuid().primaryKey().defaultRandom(),
  householdId: uuid().notNull().references(() => households.id, { onDelete: "cascade" }),
  deviceId: uuid().references(() => devices.id, { onDelete: "cascade" }),
  kind: text().notNull(),
  severity: text().notNull().default("info"),                // info | warning | critical
  title: text().notNull(),
  body: text().notNull(),
  dedupeKey: text().notNull(),
  firstFiredAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  lastFiredAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  deliveredAt: timestamp({ withTimezone: true }),
  deliveryChannel: text(),                                   // ui | email | webhook | grafana
  readAt: timestamp({ withTimezone: true }),
}, (t) => [
  unique("notifications_household_dedupe_unique").on(t.householdId, t.dedupeKey),
  index("notifications_household_last_fired_idx").on(t.householdId, t.lastFiredAt),
]);

export const digests = pgTable("digests", {
  id: uuid().primaryKey().defaultRandom(),
  householdId: uuid().notNull().references(() => households.id, { onDelete: "cascade" }),
  childId: uuid().references(() => children.id, { onDelete: "cascade" }),
  period: text().notNull(),                                  // daily | weekly | monthly
  periodStart: date().notNull(),
  periodEnd: date().notNull(),
  // The EXACT output of reportQuery(). Rendering a stored digest must NEVER re-run the query —
  // otherwise last week's email and last week's archived page disagree after a projector fix.
  payload: jsonb().notNull(),
  generatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  deliveredAt: timestamp({ withTimezone: true }),
  deliveryChannel: text(),
}, (t) => [
  unique("digests_household_child_period_unique")
    .on(t.householdId, t.childId, t.period, t.periodStart),
]);
```

### 5.4 The X2 carve-out — the single most dangerous line in the build

> **The composed failure.** better-auth's API-key plugin does per-key rate limiting at a default of
> **10 requests per 24 hours**, and ✅ **it surfaces as `401`, not `429`**. `homecal` disables it with
> a scar comment recording that the default bricked their Kindle wall display. Compose that with
> A.10 (`401 → halt_sync_keep_enforcing`): **the agent makes 1,440 sync requests a day, so it would
> halt syncing roughly ten minutes after enrolment, permanently, while reporting itself as
> "credential revoked" and continuing to enforce a policy that can never be updated again.** The
> device card shows `REVOKED`. The parent re-enrols. It happens again ten minutes later.

**Four mitigations. All four are required, because the first one alone is not sufficient.**

```ts
// 1. PLUGIN LEVEL — copied from homecal with its scar comment intact.
apiKey({
  apiKeyHeaders: "x-api-key",
  defaultPrefix: "hpc_dk_",
  // DO NOT ENABLE. The 10-req/24h default surfaces as 401, not 429, and composes with the
  // agent's `401 → halt_sync_keep_enforcing` into a permanent, self-inflicted outage that
  // reports itself as a revoked credential. homecal was bitten by this in production.
  rateLimit: { enabled: false },
})
```

```ts
// 2. ROW LEVEL — ✅ apikeys.rateLimitEnabled defaults to TRUE per row, verified in their schema.
//    The plugin-level flag does NOT retroactively clear it, so pass it explicitly at creation.
await auth.api.createApiKey({
  body: {
    userId: household.serviceUserId,            // A.21 — never a human parent
    prefix: "hpc_dk_",
    name: `dev:${device.id}`,
    rateLimitEnabled: false,                    // ← the row-level half of the carve-out
    permissions: { device: ["sync", "policy:read", "events:write"] },
    metadata: { device_id: device.id, hardware_uuid, agent_version },
  },
});
```

```ts
// 3. BOOT ASSERTION — refuse to start rather than run into it.
const bad = await db.select().from(apikeys).where(eq(apikeys.rateLimitEnabled, true));
if (bad.length) throw new Error(`X2: ${bad.length} device key(s) have rateLimitEnabled=true`);
```

```ts
// 4. INTEGRATION TEST — 30 consecutive /sync calls, assert 30 × 200. Non-negotiable.
```

**The `/api/*` `hono-rate-limiter` stays on, unchanged.** At **600/min keyed on `x-api-key`** it is
correctly calibrated: the agent's steady state is 1/min and its worst case (`attended`, 5 s) is
12/min. Because the agent presents `x-api-key` (**A.13**), the limiter keys **per device** for free —
so a second, third or fourth Mac gets its own budget with no configuration.

**`POST /api/agent/v1/enroll` gets its own hard limiter**, keyed on IP because it is the only
unauthenticated write endpoint: **5/min/IP, 20/hour globally**, plus a per-enrolment `attempts`
counter that burns the row after 5 failures. ⚖️ It must **never** be tightened to a point where a
parent fat-fingering a code three times locks themselves out of adding their own Mac. A bad code is
a `404`/`400`, never a `401` — so it can never be confused with a revoked credential.

### 5.5 Enrolment

```
 Parent (browser)          Hono API                              Mac mini (root shell)
 ────────────────          ────────                              ─────────────────────
 Devices → "Add a Mac"
   name it, pick child  ─► BEGIN
   pick policy set         INSERT devices (status='pending')
                           code = crockford32(60 bits)
                           INSERT enrollments (device_id, code_hash=sha256(code),
                                   code_hint='HPC-K7QM', expires_at=now()+60min)
                           COMMIT
                        ◄─ show the code ONCE plus a copyable line:

                             sudo hpc-agent enroll \
                               --server http://hpc-api.arch.internal \
                               --code HPC-K7QM-3ZTD-9F2W
                                                          ─────►  (parent types it)
                        ◄─ POST /api/agent/v1/enroll
                           ── ONE TRANSACTION ─────────────────────────────────────
                           UPDATE enrollments SET consumed_at=now(), consumed_ip=…,
                                  consumed_hardware_uuid=…
                             WHERE code_hash=$1 AND consumed_at IS NULL
                               AND expires_at > now()
                             RETURNING device_id            ← 0 rows ⇒ 409 / 410
                           auth.api.createApiKey({ … rateLimitEnabled:false … })   (§5.4)
                           UPDATE devices SET status='enrolled', hardware_uuid=…,
                                  api_key_id=…
                           compilePolicy(device) → policy_versions v1
                           ────────────────────────────────────────────────────────
                        ─► 201 { device_id, credential{token,key_id,issued_at,
                                 rotate_after}, policy_signing_keys[], base_url }
                                                          write credential.json 0600 root:wheel
                                                          launchctl bootstrap all daemons
                        ◄─ POST /api/agent/v1/sync   (first tick)
                           UPDATE devices SET status='active'
                        ◄─ device card turns HEALTHY
```

**Five design points, each earning its place:**

1. **The single-use guarantee is the conditional `UPDATE`, not a read-then-write.**
   `WHERE consumed_at IS NULL … RETURNING` is atomic under any concurrency, with no advisory lock
   and no isolation level to get wrong. Two Macs racing one code: exactly one gets a row back.
2. **The code is hashed at rest.** Only `code_hint` is stored in the clear, which is enough for the
   UI to say *which* outstanding code it is showing. The token is returned **once** — better-auth
   stores a hash, not the key.
3. **The device row exists before the code does.** This is what makes every recovery path
   idempotent: an enrolment *targets an existing device*, so retrying, re-issuing and re-enrolling
   all converge on the same `device_id` and the same telemetry history.
4. **Policy v1 is compiled inside the same transaction**, so the very first tick gets a real policy
   rather than a `404` — an unnecessary trip through `DEGRADED` on the first evening is a bad first
   impression for a system whose entire value is trust.
5. **`pending → enrolled → active`.** `enrolled` means "credential issued, never seen"; `active`
   means "it has actually ticked". Collapsing those loses the ability to distinguish "the install
   failed" from "nobody has run the installer yet".

**Interruption cases**, because this decides whether "add a Mac" is a five-minute job or a phone call:

| # | Interruption | Behaviour |
|---|---|---|
| i | Agent crashed after commit, before writing `credential.json` | Parent issues a new code for the same device; the handler revokes the unused key and mints a fresh one |
| ii | Response lost; the agent retries the **same code** from the **same hardware**, inside the TTL, previous key never used | ⚖️ **Re-issue, do not 409.** `reissue_count++`, return `201`. Turns the most likely LAN failure into "the retry just worked". **Guarded by all four conditions; any one missing → `409`** |
| iii | Two different Macs race one code | `409` + `reenroll`. (ii) is gated on hardware UUID, so it cannot be abused to clone a device |
| iv | Code expires | `410`. **TTL is 60 minutes, not T4's 15** — the real flow is *generate on a phone → walk to the other room → find Terminal → remember the sudo password* |
| v | Never attempted | Device sits `pending`, card shows *"setup never completed"* with one-click delete. **Do not auto-delete the device row** |
| vi | Wrong code repeatedly | `attempts` climbs; 5 strikes burns the row |

**Re-enrolment after a wipe** preserves history: `hardware_uuid` is the physical identity,
`devices.id` is the logical identity, and **the logical identity survives a reinstall**. A hardware
UUID change on re-enrol is **accepted and raises a tripwire**, not refused — ⚖️ under AR.1 the likely
explanation is a repair, and refusing strands the parent mid-fix. Recorded as a choice so it can be
flipped in one line.

**Bootstrap, before any device exists:**
- **First-run claim** reuses `homecal`'s existing `databaseHooks.user.create.before` hook: if
  `count(users) === 0`, create the household, create its `isService` user, add the human as
  `role: "owner"`, seed a default school-night and weekend window. **After that, signup is closed.**
- **The Ed25519 policy keypair** is generated once; the private half lives in
  `homeparentcontrol-secrets` as `POLICY_SIGNING_KEY` via the house's out-of-band
  `create-cluster-secret.sh`. The public half is handed to the agent in the enrolment response.
  ⚠️ **This is trust-on-first-use over plain HTTP** (X4). Under AR.2 and AR.1 it is acceptable; the
  documented upgrade is one installer flag, `--pin-key sha256:…`, compared against the received key
  before anything is written. **Put it in the runbook even if it is never used.**

**Decommission vs Revoke** — the UI must make these typed-confirmation actions and must say what each
does, because they look similar and behave oppositely:

> **Revoke** — the Mac stops talking to the server **but keeps enforcing bedtime**. Use this if you
> think the credential leaked.
> **Decommission** — the agent uninstalls itself and **stops enforcing anything**. Use this when the
> Mac is leaving the house.

Decommission is `410` + `hpc_action: "decommission"`: `devices.status='decommissioned'`, API key
revoked, every `desired_items` row dropped, **and all telemetry retained** — the child's history is
not the device's property.

### 5.6 The policy compiler

```
compile(device) →
  set        = policySets[device.policySetId]
  tz         = child.timezone ?? household.timezone
  windows    = scheduleWindows[set] + their scheduleWarnings
  horizon    = today … today + 21 days
  holidays   = holidaysService.get(household.holidayCountries, horizon)    # LIVE, homecal's file
  exceptions = merge(calendarExceptions[horizon], holidays)   # manual > dismiss > library
  grants     = overrides WHERE child = … AND revoked_at IS NULL
                                     AND expires_at > now()   # ← the NOT NULL earns its keep
  doc        = { policy_version: next, device_id, subject, timezone: tz, fail_mode, poll, agent,
                 schedule: {kind, windows}, overrides: grants ∪ exceptionsAsOverrides,
                 override_policy, expected_online, telemetry, staleness }
  hash       = sha256(canonicalJson(doc))
  if hash == currentVersion.documentHash: RETURN unchanged    # ← kills recompile churn
  sign(doc) with Ed25519 → jws ; INSERT policy_versions ; bump ETag
```

**Three properties this buys.** The compiler is a **pure function** of authoring state plus the date,
so it is unit-testable with no database and no clock injection beyond one argument — which matters,
because POC 1's two bugs were both on the enforcement path and *"the dry-run suite caught neither"*.
The output is **content-addressed**, so no change means no new version and no ETag churn. And
**calendar exceptions and parent grants land in the same array**, so there is exactly one code path
for "something relaxed the rules", on both ends of the wire.

**The holiday insight:** a holiday is not a new kind of rule. It is *a relaxation of a known window,
for a known date, that must end* — which is the exact definition of an override.
`treat_as_weekend` → an `extend`; `no_bedtime` → a `suspend`; `custom` → an `extend` with explicit
minutes. **Zero new agent capability, a mandatory `expires_at` for free, and it appears in the audit
trail as *"+60 min, calendar: Christmas Day"*.**

**`date-holidays` is called live at compile time**, reusing `homecal`'s `services/holidays.ts`
unchanged — per-country instance cache, `type === "public"` filter, 100-entry FIFO result cache,
**no table, no sync job.** ⚖️ A persisted mirror of a pure function creates an idempotency problem, a
staleness problem and a "the library renamed a holiday and now there are two" problem, for a value
that costs microseconds to recompute. `calendar_exceptions` stores **parent intent only** — a row
exists because a human added, edited or **dismissed** something. *"The bank is shut"* and *"she has
no school"* are different facts and the parent needs one click to say which, **in both directions**.

**21-day horizon**, ⚖️ a guess, and easy to change — it is one constant, not a schema decision. Say
what it means in the UI: *"Exceptions are sent to Lucy's Mac 21 days ahead. If it is offline longer
than that, the normal school-night rules apply until it reconnects."* That is A.8's converge-stricter
property stated as a product behaviour rather than left as a surprise.

**What a calendar exception cannot do: make bedtime earlier.** Overrides are relaxations only. A
genuinely earlier bedtime is a **schedule change** — a new `policy_version`, subject to
`confirm_immediate_effect` if it bites within 15 minutes. Tightening enforcement is the dangerous
direction and deserves the guard.

### 5.7 Telemetry pipeline

**Ingest** — one table, one conflict clause, nothing clever:

```sql
INSERT INTO events (household_id, device_id, event_id, type, v, class, ts, received_at,
                    boot_id, seq, data)
VALUES … ON CONFLICT (device_id, event_id) DO NOTHING
RETURNING event_id;
```

⚠️ **The `RETURNING` populates `accepted_event_ids[]`, and a conflicting row is still *accepted*** —
it is already durable. Returning only newly-inserted rows would make the agent retry the same batch
forever. Batch as a **single multi-row `INSERT`**, not a loop (a 2,000-event drain must not become
2,000 round-trips). **Validate per event, not per batch**, so *"I took 1,998 of your 2,000"* is
expressible.

**Projection** — scheduled every 5 minutes, watermarked on `received_at`, **recomputing whole
buckets**:

```
w      = projection_state.watermark_received_at
rows   = events WHERE received_at > w ORDER BY received_at LIMIT 50_000
dirty  = distinct (device_id, date_trunc('hour', ts)) over rows
for each dirty bucket: RECOMPUTE THE WHOLE BUCKET from events, then upsert
projection_state.watermark_received_at = max(rows.received_at)
```

⚖️ **Recomputing rather than incrementing is the whole design.** An incremental projector must know
whether it already counted a row — a second idempotency problem on top of the one `event_id` already
solves. A full recompute is idempotent by construction. At ~85 rows per bucket it costs nothing. A
nightly job additionally re-projects the trailing 48 hours unconditionally.

**Keyed on `received_at`, never `ts`** — the agent's clock is advisory, and a child stepping it
backwards would otherwise push her own events permanently behind a `ts`-based watermark.

**Retention ladder:**

| Tier | Retention | Size |
|---|---|---|
| `events` where `class='sample'` | **90 days** | the bulk |
| `events` where `class='audit'` | **400 days** | ~3.6 MB |
| `usage_hourly` | **400 days** | |
| `usage_daily` · `session_spans` · `enforcement_log` · `policy_versions` | **forever** | ~5.4 MB/yr combined |
| `agent_status_intervals` | 400 days | ~0.5 MB/yr |

> ⚠️ **Hard invariant, asserted at boot — refuse to start if violated:**
> **`RAW_SAMPLE_RETENTION_DAYS` (90) must exceed the agent's `telemetry.max_queue_age_days` (14).**
> Otherwise a long outage delivers events that are ingested and then pruned *before* the projector
> touches them — data that arrived, was stored, and evaporated, with no error anywhere. 90 vs 14–29
> gives 3× headroom.

Pruning is `DELETE … WHERE received_at < now() - interval` in the nightly job, carried by the BRIN
index. **No partitioning** — ~730 k rows/year; revisit above ~50 M rows, which at this rate is
roughly the year 2094.

**Storage, one child one Mac 60 s tick:** ~2,000 events/day × ~360 B = **720 KB/day · ~22 MB/month
raw**; rolled up **~0.35 MB/month** (~62× compression); **~79 MB steady state after year 1, ~101 MB
after five years**; **+68 MB per additional Mac.** The house chart's existing
`db.persistence.size: 5Gi` on `local-path` is already right. **Do not change it.**

**Two honesty rules the ladder must not break:**

1. **Gaps are data.** `queue.evicted` is projected into `enforcement_log` as a first-class row, and
   `SILENT_TOO_LONG` intervals render as a hatched band. **Zero usage and no data look identical on
   a bar chart and mean opposite things.**
2. **A pruned window is still visibly pruned.** Reports read rollups, which outlive raw, so pruning
   removes detail and never removes the fact that time passed.

### 5.8 Deltas against the `home*` template

Everything not listed is **as per template, copied verbatim**.

| Component | Delta | Why |
|---|---|---|
| **Monorepo** | plus **`packages/contract`** | R9. Zod wire schemas consumed by the API and — via a JSON-Schema artefact emitted in CI — by the Swift agent. Keeping them in `apps/api` is how "the payload evolves later" becomes "every payload change is a migration" |
| **Hono mount** | **single mount**: `/api/parent/v1/*` and `/api/agent/v1/*` | The stock dual `/api` + `/api/v1` mount exists only to carry a legacy client through a `Sunset` header. A greenfield app inherits the debt for nothing |
| **better-auth (agent)** | `apiKeyHeaders: "x-api-key"`, `defaultPrefix: "hpc_dk_"` | **A.13.** No hand-rolled bearer-stripping middleware needed |
| **API-key rate limiting** | **`rateLimit: {enabled: false}` + per-row `rateLimitEnabled: false` + boot assert + integration test** | **X2, §5.4. The single most dangerous line in the build** |
| **Hono rate limiter** | **unchanged on `/api/*`** (600/min, keyed on `x-api-key`); a **hard** limiter on `/api/agent/v1/enroll` only (5/min/IP, 20/h) | Correctly calibrated as-is once the agent keys per device |
| **Device credential ownership** | **one `isService` user per household** owns every device key | **A.21.** ✅ `apikeys.userId` is `NOT NULL ON DELETE CASCADE` |
| **Drizzle** | plus **`casing: "snake_case"`** and **exactly one `check()`** on `schedule_windows.action` | Follows `homework`, the newest generation. The check is A.34 made structural |
| **Error shape** | parent routes: house flat `{error}`. **Agent routes: RFC 9457 `problem+json` + `hpc_action`**, via an `onError` scoped to the agent sub-app | `hpc_action` decides whether the agent backs off, re-enrols, halts sync or decommissions. **Do not add a global `onError`** — it would swallow the parent routes' hand-mapped errors |
| **pino** | plus a **`redact` list**: `hpc_dk_*`, enrolment codes, `x-api-key` | Biome's `noSecrets` will not catch a runtime log line |
| **Schedulers** | three in-process `setInterval`: liveness 60 s, projection 5 min, nightly | **The house already solved this**: `replicaCount: 1` + `strategy: Recreate` guarantees no overlap. ⚠️ If replicas ever exceed 1, the liveness job needs `pg_try_advisory_lock` |
| **Policy signing** | **Ed25519 JWS**; key in `homeparentcontrol-secrets` as `POLICY_SIGNING_KEY` | Node's `crypto` does Ed25519 natively; no library |
| **Helm chart** | as per template. Added secret key `POLICY_SIGNING_KEY`; added `api.env`: `AGENT_DESIRED_VERSION`, `AGENT_PKG_SHA256`, `AGENT_PKG_URL`, `RAW_SAMPLE_RETENTION_DAYS` | ⚠️ **no `tls:` block** — X4, accepted |
| **PVC** | **unchanged at `5Gi`** | §5.7 |
| **Testing** | plus a **golden-file suite for the policy compiler** | It is a pure function — the one genuinely cheap thing to pin down, and POC 1's bugs were on the path the dry-run suite missed |
| **Env validation** | **config-at-boot validation** (`homework`'s `src/config.ts` + `process.exit(1)`), including the X2 and retention assertions | Genuine additions, not template gaps |
| **CI** | plus a fourth job **`bump-agent-version`**, `if: startsWith(github.ref, 'refs/tags/v')`; and **`bump-arch-infra` made a hard failure** | §6.6 |

**What is deliberately absent from the UI** — and there is no route to delete later, because there is
no route: **no child-facing surface of any kind** (no login, no status page, no time-remaining widget,
no request button, no notification inbox), and **no "disable enforcement" button**. The nearest legal
action is a `suspend` override with a mandatory `expires_at` — *"No bedtime tonight"*, never *"off"*.

**Parent UI pages:** `/` (Today — one card per device, health in plain language, tonight's boundary
with overrides folded in, today's screen time, **one** tripwire banner not eight, and the 15/30/60
grant buttons right here because this is the page open when the child asks) · `/devices/[id]`
(**opening it sets `attendedUntil = now() + 10 min`**, which is the whole mechanism behind the 5-second
grant; 7-day state timeline; clock posture; **Away until…**; Revoke / Re-enrol / Decommission) ·
`/rules` (draft → diff → publish; the diff shows the **compiled document**, because that is what the
agent obeys) · `/rules/calendar` · `/rules/history` (**Restore publishes a new version with old
content; it never mutates history** — `git revert` applied to bedtime) · `/override` · `/reports` ·
`/settings` · `/setup`.

**`/override` must show two-stage state, and "Applied" is driven by the agent's own next tick**
reporting the new `policy_version` and a shifted `next_boundary_at` — **never by the server's own
write.** Claiming success on the write is the *"the server thinks it delivered"* failure mode that
polling was chosen to avoid.

```
+30 min for Lucy            Sent ✓ 21:29:58  →  Applied ✓ 21:30:03  (5 s)
Bedtime tonight: 21:30 → 22:00 · expires 06:00
```

If it has not landed in 30 s: `Sent ✓ — not yet applied`, plus the device's health. If enforcement
already fired, the sentence from §3.5. **If the device is offline:** *"Lucy's Mac hasn't checked in
for 14 minutes. This grant will apply when it reconnects."* — and under **D.5** that is where the
sentence ends. There is no code to read out.

**`/reports` keeps D.2 open** with one query service and four sinks:

```
reportQuery({ householdId, childId?, deviceId?, from, to, grain }) → ReportPayload
   ├── dashboard    /reports renders it                          ← built now
   ├── on-demand    GET /api/parent/v1/reports returns it         ← built now
   ├── digest       digests.payload stores it, email renders it   ← table exists, off
   └── alerts       notifications rows + channel adapter          ← table exists, UI only
```

Choosing a delivery mode later is **a config flag and one adapter**, never a schema migration or a
second query implementation that drifts. ⚠️ **A stored digest renders from its stored `payload`,
never by re-running the query** — otherwise last week's email and last week's archived page disagree
after any projector fix, which is worse than either being wrong alone. And **label what `active_s`
is**: *"Active time — minutes she was actually using the Mac, not minutes it was switched on."*

### 5.9 X4 — plain HTTP, stated rather than assumed

✅ The house template has **no TLS**: `ingress-api.yaml` has no `tls:` block and no annotations,
every host is `http://<name>.arch.internal` on Traefik, `BETTER_AUTH_URL` and `CORS_ORIGINS` are
`http://`, and `arch-infra/infra/` — where cert-manager would live — is an empty directory with a
`.gitkeep`.

**So the device credential, the enrolment code, and the parent's session cookie all cross the LAN in
cleartext.** ⚖️ **Accepted for v1** under AR.2 (trusted LAN) and the design's own posture — *make the
credential boring to steal rather than hard to steal*. Diverging from the house on ingress for one
app is worse than the risk it removes. **But it is written down here so nobody later reads T4's
"over TLS" as a description of what was built.**

The upgrade is cheap and self-contained — cert-manager with a self-signed cluster issuer in
`arch-infra/infra/`, a `tls:` block on this one ingress, and the agent trusting that CA — and it
would benefit every `home*` app, so **it belongs as an `arch-infra` issue rather than in this repo**.

**Scope is the actual security control, not the transport.** The device key can call `/sync`,
`/policy` (read) and `/events` for *its own* `device_id` and nothing else — and every agent handler
must re-check that the key's `metadata.device_id` matches the `device_id` in the body. Stolen, it
buys you the ability to read your own bedtime and to lie in your own telemetry, both of which you can
already do by reading the policy cache and unplugging the cable.

---

## 6. Install, update, rollback

### 6.1 What E.2 deleted

> ✅ **`.pkg` CAN downgrade.** Two pkgs, same identifier, v2.0 then v1.0. `installer` reported
> *"Upgrading at base path"*, exited 0, the payload reverted to `VERSION_ONE` and the receipt to
> `1.0`. The limitation everyone cites is **Munki's policy, not `installer`'s.**

T3's versioned-directory + atomic-symlink-flip layout existed **because rollback could not be an
install**. That premise is gone, so the layout goes with it: no `versions/` tree, no `current`
symlink, no `last-good` symlink, no postinstall flip, no `mv -T` dance.

**Is there another reason to keep the symlink? One candidate, and it does not survive.** Layers 1–2
of the rollback ladder (crash-loop and unhealthy rollback) must work **offline, with no download** —
that is genuinely load-bearing. But it needs a *cached artefact*, not a versioned directory:

> ⚖️ **Keep `/var/db/homeparentcontrol/pkgs/<version>.pkg`, newest 3.** Rollback is
> `installer -pkg pkgs/1.0.3.pkg -target /`. Offline, one directory, no symlink, no flip, no
> ordering hazard, and the same code path as a forward install.

⚠️ **Verification owed — V-PKG-1.** The downgrade was observed in the **user** domain
(`-target CurrentUserHomeDirectory`). **`sudo installer -pkg … -target /` was not tested** — it needs
passwordless sudo, which was correctly not arranged. `installer` treated the operation as an upgrade
without consulting version direction, so the mechanism is not domain-specific in any obvious way, but
**this is 📄 inference until someone runs it.** It is 10 minutes and it gates the whole rollback
story. Until it passes, the fallback is to republish the old build under a higher version number —
the version-number fraud T3 rightly disliked, kept only as a named contingency.

### 6.2 On-disk layout

```
/usr/local/libexec/homeparentcontrol/
    hpc-supervisor        root:wheel 0755   ad-hoc signed, FIXED PATH, ~300 lines, no enforcement
    hpc-enforcer          root:wheel 0755   ad-hoc signed, links NO HTTP client
    hpc-sync              root:wheel 0755   ad-hoc signed
    hpc-deadfall          root:wheel 0755   ad-hoc signed, one predicate, one action
/usr/local/etc/homeparentcontrol/
    config.json           0644 root:wheel   base_url, device_id
/var/db/homeparentcontrol/                  dir 0700 root:wheel
    policy.current.json · policy.lkg.json · credential.json · clean_exit
    enforcer.health · sync.health · spool/*.ndjson · queue.sqlite(+-wal)
    pkgs/<version>.pkg    0600              rollback cache, newest 3
    quarantine            0600              versions that failed; never reinstalled
    DISABLE               (absent)          kill switch, time-boxed (§3.7)
/Library/LaunchDaemons/com.hpc.{supervisor,enforcer,sync,deadfall}.plist   root:wheel 0644
/var/log/homeparentcontrol/{supervisor,enforcer,sync}.log
```

**Why the supervisor is still a separate, fixed-path binary**, now that BTM no longer forces it
(E.1): ⚖️ **it is the watchdog launchd cannot be.** launchd sees exit codes; it does not know the
process is *wrong*, and F2 ("agent runs but ticks are wrong") is where POC 1's bugs actually lived.
It also contains no enforcement logic, so it cannot lock, shut down or log anyone out — by
construction — and it is the one component that cannot be rolled back in place, which is exactly why
it must stay tiny, static and **non-self-updating (A.24)**.

### 6.3 Install — one time, attended

1. Parent clicks **Add a Mac**, gets a one-time code (60 min, single use).
2. Download the pkg. ⚠️ **Ship a tarball or `rsync` the tree — never a `.zip`.** ✅ `unzip` and
   `ditto -x -k` **do** propagate quarantine on macOS 26, contradicting widespread folklore; `tar`,
   `rsync`, `scp` and `curl` do not. ✅ A quarantined non-notarized Mach-O is **SIGKILLed silently at
   `exec`** (rc=137), and 📄 macOS 27 additionally refuses to load a quarantined `.plist`.
3. `sudo installer -pkg hpc-agent-1.0.0.pkg -target /`. Postinstall `launchctl bootout`s any running
   service, then `bootstrap`s all four jobs.
4. **`xattr -r /usr/local/libexec/homeparentcontrol /Library/LaunchDaemons/com.hpc.*` must be clean.**
   This is a post-deploy gate, not a suggestion — it is what makes notarization unnecessary.
5. `sudo hpc-agent enroll --server … --code …`. Agent writes `credential.json`, deletes the code.
6. **Verify Remote Login is on and the parent's admin account can SSH in.** ⚠️ The installer should
   **refuse to install** if the parent has no out-of-band path to the machine. Write it down.
7. Optional but free: `sudo sfltool dumpbtm | grep -A10 com.hpc` to confirm the disposition. ✅ E.1
   says it will read `[enabled, allowed, notified]`; the user **is** notified that a background item
   was added, which is visible and acceptable under AR.3.

**Notarization is not required**, ✅ conditional on step 2 and step 4's hygiene. Nothing this project
installs is ever quarantined, so Gatekeeper never assesses it. `spctl -a` reports "rejected" for a
local ad-hoc binary that runs fine — it is advisory here, not a gate.

### 6.4 Update and rollback

```
sync daemon (60 s tick):
  desired[] item kind:"agent_version" → {version, pkg_url, sha256}
  if version == running: report converged, done
  if version in quarantine: log, raise a notification, done       ← never reinstall a known-bad
  if pkgs/<version>.pkg absent:
      download pkg_url → pkgs/<version>.pkg.tmp
      verify sha256 == pinned                                     ← the ONLY gate; see below
      rename(2) into place

supervisor (60 s tick):
  a new pkgs/<version>.pkg appeared and version != running:
      RE-VERIFY sha256 itself                                     ← defence in depth
      /usr/sbin/installer -pkg pkgs/<version>.pkg -target /       ← no prompt: already root
      launchctl kickstart -k system/com.hpc.{enforcer,sync}
      new version starts in SHADOW MODE (§6.5)
  enforcer.health or sync.health stale > 5 min, or 3 non-zero exits in 5 min:
      write the bad version to `quarantine`
      installer -pkg pkgs/<last-good>.pkg -target /  ; kickstart   ← OFFLINE, no network
  prune pkgs/ to the newest 3 plus last-good
```

⚠️ **`installer -pkg` run as root bypasses Gatekeeper** — 📄 *"When you install software using the
`installer` command from the Terminal or a script, it will bypass quarantine and the Gatekeeper
check."* **The OS will not check the signature for you on the unattended path.** Under D.7 there is
no Developer ID Installer certificate to check, so **the pinned SHA-256 is the whole gate**, and it
is verified twice — once by the downloader, once by the process that runs `installer` as root. The
control plane's only job is to publish the digest honestly; **a digest nobody checks is worse than no
digest, because it looks like a control.**

| Trigger | Mechanism | Human? | Network? | Time |
|---|---|---|---|---|
| 3 non-zero exits in 5 min | supervisor reinstalls the cached last-good pkg, quarantines the bad version | No | **No** | < 1 min |
| Heartbeat stale > 5 min | same | No | **No** | < 5 min |
| Soak failure (§6.5) | version never promoted; alert | No | No | ≤ 24 h |
| Parent decides | `git revert` the version bump in `arch-infra` → Argo CD → `desired[]` → next tick | Yes | Yes | ≤ 5 min |
| Everything is on fire | SSH: `echo '{"until":"…"}' > /var/db/homeparentcontrol/DISABLE` | Yes | SSH only | Next tick |
| Nothing is reachable | power button; log in as admin | Yes | No | Immediate |

**Supervisor updates are deliberately different.** A supervisor bump does **not** self-apply. It
raises a notification — *"supervisor update available — run the pkg"* — and is an attended install, a
couple of times a year. **That is the price of not having the updater update itself.**

### 6.5 Shadow mode, and what the simplification cost

⚖️ Population-based staged rollout is meaningless at n=1. **The purpose survives in a different form:
stage in time, not in population.** A newly installed version starts with enforcement disabled, runs
the full tick loop, and computes every decision it *would* make.

> ⚠️ **One thing E.2's simplification genuinely cost.** T3's shadow mode diffed the new version's
> decisions against *the outgoing version running concurrently* — which the versioned-directory
> layout gave for free and a single-pkg install does not. **The n=1 form that survives compares
> against the server-side record instead:** the candidate emits `enforcement.shadow_decision` events
> and the control plane diffs them against `enforcement_log`'s history for equivalent inputs. That is
> a better place for the comparison anyway — it is durable, queryable, and visible in the UI — but it
> is a real change from T3's design and it is stated here rather than glossed.

Promotion is **automatic** on the soak criteria (≥24 h, ≥1 full bedtime window, zero crashes, zero
heartbeat gaps, zero *unexpected* decision divergences) — ⚖️ a manual gate will be skipped at 23:00 on
a Sunday. A release declares its expected divergences (`expect_divergence: true` with a reason), so
an intentional fix does not fail its own soak. **Keep shadow mode as a permanent flag** after the
soak; it is the best test harness this project will ever have.

### 6.6 GitOps — and the green-build trap

The agent version pin folds into the house mechanism with **zero new endpoints and zero chart
template changes** — `arch-infra`'s `apps/*.yaml` already carries values in
`spec.source.helm.parameters`, and the chart already does `range $k, $v := .Values.api.env`:

```yaml
# arch-infra/apps/homeparentcontrol.yaml
      parameters:
        - name: api.image.tag
          value: "<sha>"          # bumped by CI on every main push
        - name: web.image.tag
          value: "<sha>"          # bumped by CI on every main push
        - name: migrate.enabled
          value: "true"
        - name: api.env.AGENT_DESIRED_VERSION
          value: "1.4.2"          # ← bumped ONLY on a v* tag
        - name: api.env.AGENT_PKG_URL
          value: "https://github.com/…/releases/download/v1.4.2/hpc-agent-1.4.2.pkg"
        - name: api.env.AGENT_PKG_SHA256
          value: "9f2c…"          # the supervisor verifies this itself (§6.4)
```

The API reads these from the environment and publishes them as a `desired[]` item of
`kind: "agent_version"`, converged when the device reports a matching `device.agent_version`. **Argo
CD reconciles git → cluster; `desired[]` reconciles cluster → device; `git revert` is the rollback**
— the chain T3 wanted, without T3's bespoke endpoint.

⚖️ **Two deliberate asymmetries:** containers bump on every `main` push; **the agent bumps only on a
`v*` tag**, because the shadow soak and attended supervisor upgrades both require agent releases to
be deliberate.

> ### ⚠️ A.22 — `bump-arch-infra` must be a hard failure
>
> ✅ The stock job **soft-skips with `::warning::` and `exit 0`** when `ARCH_INFRA_TOKEN` is unset or
> `apps/<name>.yaml` does not exist. **An entirely unwired GitOps chain therefore looks like a green
> build** — CI passes, the badge is green, and nothing is deployed.
>
> **Change it to fail:**
> ```yaml
> - name: Bump arch-infra
>   run: |
>     set -euo pipefail
>     : "${ARCH_INFRA_TOKEN:?ARCH_INFRA_TOKEN is not set — the GitOps chain is unwired}"
>     test -f "apps/homeparentcontrol.yaml" \
>       || { echo "::error::Argo CD Application CR missing"; exit 1; }
>     …
> ```
> And **create the Application CR and the PAT secret before trusting the pipeline**, then check the
> first bump landed by hand. A warning nobody reads is not a control.

---

## 7. Observability

### 7.1 Log emission

**Structured JSON, one object per line, to stdout**, captured by launchd's `StandardOutPath`. ✅ E.5
settles the alternative: **zero lines came back from `log show`** for an ad-hoc binary at `.default`,
`.error` and `.fault`, queried by subsystem, by process, and by free text across the whole store.

> ⚠️ **T6's conclusion is right; T6's reason is not.** T6 blamed macOS 26's `<private>` redaction of
> dynamic strings. **We never saw `<private>` at all, because nothing came back.** Whatever the
> mechanism — signing identity, subsystem registration, or something else — `os_log` from this
> binary is not retrievable, and the redaction argument should not be repeated as if it were the
> operative one.

Keep **one** `%{public}s` `os_log` breadcrumb on `agent.started` / `agent.stopping` anyway. It costs
two lines and it is the one thing unified logging would be good at — correlating with `pmset -g log`
and system shutdown records **when the agent itself is gone**. ⚠️ Given E.5, treat it as best-effort
and verify it independently; **nothing depends on it.**

```json
{"ts":"2026-09-18T20:59:31.412Z","level":"info","event":"enforcement.warning_shown",
 "device":"018f2a4c-7b31-7c9e-9d2a-3f5b7c1e4a60","boot_id":"018f2a4c-9d53-…",
 "agent_version":"1.4.2","policy_version":43,"seq":88134,
 "msg":"5-minute warning displayed","detail":{"window":"School nights","minutes_left":5}}
```

`seq` is a monotonic per-boot counter — it makes **gap detection** trivial ("we have 88130..88134,
88131 is missing") with no clever infrastructure. Cheap, and it turns *"did we lose logs?"* from a
guess into a fact.

⚠️ **launchd does not rotate.** Add `/etc/newsyslog.d/homeparentcontrol.conf` at `100 KB × 7`,
compressed. 📄 The classic trap: a rename-based rotation leaves the daemon writing to the orphaned
inode unless it is signalled to reopen — use newsyslog's pidfile/signal fields, or handle `SIGHUP`.
**Verify empirically** (§8.3). The file is a forensic tail for the one time someone SSHes in. **Loki
is the system of record.**

### 7.2 Log flow

```
 Mac: agent → stdout → launchd StandardOutPath → /var/log/… (forensic tail)
              └─► spool (capped, seq'd) → POST /api/agent/v1/events → control plane
 Cluster: control plane → pino stdout → existing Alloy DaemonSet → Loki → Grafana
```

**Nothing new runs on the child's Mac.** ⚖️ Grafana Alloy ✅ does run on darwin/arm64 (official
`alloy-darwin-arm64.zip` v1.19.2, Homebrew formula, launchd via `brew services`) — **but there is no
darwin log source**, no equivalent of `loki.source.journal`. It could only tail a file the agent
already wrote and forward it over a path the agent already has. **It adds a hop, not a capability.
Rejected.** Promtail is separately disqualified — **EOL 2026-03-02**.

⚠️ **Telemetry events are Postgres-authoritative; Loki gets live lines only.** 📄 Loki accepts
out-of-order lines only within `max_chunk_age / 2` — **1 hour** by default — and **silently drops**
anything older. Any outage longer than an hour would therefore destroy exactly the data the parent
most wants to see. Two rules: (1) `POST /events` writes to Postgres with the agent's `ts` **and** the
server's `received_at`, and nothing in the reporting path ever infers time from ingestion order —
this path is immune; (2) on replaying a backlog older than the window, the forwarder **re-stamps with
the current time and carries the true time in a structured field (`original_ts`, `delayed: "true"`),
or skips Loki entirely** — the record already exists in Postgres. **Never drop a line to satisfy
Loki**, and emit a `log.backfill` event so the backfill is itself visible.

### 7.3 The heartbeat and the five-state machine

**The tick is the heartbeat (A.26).** `POST /sync` *is* the liveness signal. There is no
`/heartbeat` endpoint and there must not be one — ⚖️ a second liveness path can be healthy while the
real one is broken, and a heartbeat that can lie is worse than none.

The control plane — a k3s pod, reliably running, unlike the Mac — evaluates every device **once a
minute** and emits its verdict.

| State | Condition | Parent sees | Notifies |
|---|---|---|---|
| `HEALTHY` | last tick within 180 s (3 ticks) | green | — |
| `DEGRADED` | ticking normally, but self-reporting `policy_missing`, `policy_corrupt`, `signature_invalid`, `enforcement_failed`, `clock_untrusted`, `disk_full`, `enforcer_heartbeat_missing`, `kill_switch_present` | **red** | **immediately** (after 3 consecutive evaluations) |
| `EXPECTED_OFFLINE` | last event was `agent.stopping`, **or** outside `expected_online`, **or** `away_until > now` | grey *"Asleep"* | never |
| `UNEXPECTED_SILENCE` | **10 min** silent, no `stopping`, inside an `expected_online` window | amber | **after 60 min** |
| `SILENT_TOO_LONG` | **36 h** silent, regardless | red | immediately |

> ⚖️ **Resolution of an ambiguity the inputs left.** T6's `DEGRADED` list includes *"policy fetch
> failing"* and *"spool near capacity"*; T4's does not. **T4's narrower list wins.** `DEGRADED` must
> mean *enforcement is impaired*, not *sync is impaired* — sync impairment does not affect
> enforcement, and a red immediate notification for a transient 500 trains the parent to ignore the
> badge. Sync trouble is already visible as `UNEXPECTED_SILENCE` and on the health card.

**Two escalation rules layered on top of the states, both deliberate:**

1. **A notification threshold distinct from the state threshold.** Enter `UNEXPECTED_SILENCE` at
   10 minutes; notify at 60. A macOS software-update restart routinely exceeds 10 minutes on Apple
   silicon, and an amber a parent can see is not the same event as a phone buzzing.
2. **Do not arm at the start of a window.** Require one `HEALTHY` observation inside the *current*
   `expected_online` window before `UNEXPECTED_SILENCE` can be entered, or every late start produces
   a 07:00 amber. (`SILENT_TOO_LONG` is deliberately window-independent.)

**Device lifecycle is a separate axis.** `pending` / `enrolled` / `active` / `revoked` /
`decommissioned` are values of `devices.status`, orthogonal to the five health states — a `REVOKED`
device is still alive and still enforcing. Conflating the axes is how a UI ends up unable to say
*"alive, enforcing, and locked out of the API"*, which is exactly what a revoked device is.

**Storage — the correction that matters.** ⚖️ A row per device per minute is 1,440 rows/day; at a
400-day ladder that is **~69 MB, larger than the entire raw telemetry store and ~16× every rollup
combined** — to record a value that changes about eight times a day. **But the row was never the
point.** T6's requirement is that alerting keys off a **presence**, and T6's own alert rules read a
**Loki stream**, not a table. So:

> **The once-a-minute evaluation emits a pino line** (`log.info({ event: "agent_status", … })`,
> stdout → Alloy → Loki), exactly as T6's rules assume.
> **Postgres stores intervals** — one row per *state change* — plus the current state denormalised
> onto `devices`.

Every T6 alert rule works unmodified; the table drops to ~8 rows/day and stops being the largest
object in the database; and the 7-day state timeline reads a handful of interval rows instead of
aggregating ten thousand samples.

### 7.4 Off vs broken, with no probe

**A.29 — no ICMP or TCP probe of the Mac, ever.** 📄 A Bonjour Sleep Proxy answers ARP on behalf of a
sleeping Mac, so a ping succeeds against a machine that is asleep — **the probe lies**. And with Wake
for network access enabled, a probe can **wake the machine at 03:00**, which is both a false signal
and an actively harmful one in a bedtime-enforcement product.

The distinction comes free from one field already on the wire, `device.system_boot_time`:

| Observation | Reading |
|---|---|
| `system_boot_time` falls **inside** the silence window | The Mac was off or restarted — benign. **Reclassify the interval to `EXPECTED_OFFLINE` retrospectively** (`reclassified_from`) |
| `system_boot_time` is unchanged and earlier — the machine was up throughout | **The Mac was running and the agent was not** |
| …and `clean_exit_previous_run: true` with `reason: "signal"` | Something issued a clean stop (`launchctl bootout`) while the machine stayed up — **the strongest available tell** |
| …and `clean_exit_previous_run: false` | A crash. Pair with the crash-loop counter; an engineering bug, not a child |

⚖️ **Weighting, deliberately:** surface all of it on the device health card alongside the tripwires,
**not as a notification**. Under AR.1 the value of a tamper signal is that it exists to be found when
someone later asks *"has she ever tried?"*, not that it pages a parent tonight — and at that point
the signal is already collected and historical, which is worth considerably more than an alert nobody
wired up.

### 7.5 Alerts

📄 **The Grafana No-Data trap, and why every rule is shaped this way.** A LogQL metric query returns
**no series** when nothing matches, not `0`. Grafana evaluates that as **No Data**, which fires a
**synthetic** `DatasourceNoData` alert that *"may not inherit existing silences or notification
policies"* — so the alert carefully routed to the parent fires as a differently-labelled alert the
notification policy may drop on the floor. **You would discover this the first time it mattered.**

Two mitigations, use both: alert on the **control plane's** always-alive stream, never the agent's;
and force a numeric result with `or vector(0)` applied to an *aggregated* expression.

```logql
# A1 — agent unexpectedly silent                      for: 5m    severity: critical
sum(count_over_time(
  {app="homeparentcontrol", component="control-plane"}
  | json | event="agent_status" | status="UNEXPECTED_SILENCE" [5m]
)) or vector(0)                                        # condition: > 0

# A2 — silent too long      status="SILENT_TOO_LONG"   for: 10m   severity: warning
# A3 — degraded             status="DEGRADED"          for: 3m    severity: warning

# A4 — crash loop                                      for: 0m    severity: critical
sum(count_over_time(
  {app="homeparentcontrol", component="agent"} | json | event="agent.started" [10m]
)) or vector(0)                                        # condition: > 3

# A5 — the watcher of the watchman                     for: 10m   severity: critical
sum(count_over_time(
  {app="homeparentcontrol", component="control-plane"} | json | event="agent_status" [10m]
)) or vector(0)                                        # condition: < 5
#      ↑ the ONLY rule that must set  No Data = Alerting
```

**Five alerts. For a one-agent home system that is the upper limit; resist adding more.** Every alert
that fires and does not need action trains the parent to ignore the next one.

**One deliberately non-alerting signal:** if the agent is silent at T-5 min before a window, that is
when silence has consequences — but *"silent at bedtime"* is also exactly what *"she went to bed
early"* looks like. Emit it as an **informational notification**, not an alert: *"Agent unreachable
at 20:55; no bedtime enforcement occurred tonight."*

⚠️ **Provision the rules and the dashboard as code.** Rules clicked into the Grafana UI are invisible
to Argo CD and vanish on a reinstall — directly at odds with P3.2/P3.4.

**Dashboard — six panels**, of which #4 earns the page: agent status (stat, value-mapped) · last seen
("4 minutes ago" vs "2 days ago" answers the question before you read anything else) · version ·
**⭐ online/offline state timeline, 7 days** (it renders the *shape* of normal, so an anomaly is
visible without anyone defining what anomalous means) · warnings & errors (logs) · enforcement events
(logs).

⚖️ **Deliberately excluded: anything about the child's usage.** That is *product* data and it belongs
in the parent UI. **The app answers "what did my kid do"; Grafana answers "is my system working."**
Keeping that line clean is an architecture decision, not a cosmetic one — it keeps long-retention,
high-cardinality per-child data out of Loki and keeps the parent's daily surface out of an operator
tool. Also excluded: CPU/memory of the mini, latency histograms, anything with a p99. One agent, one
tick a minute. **There is nothing to tune, and no Prometheus for the agent.**

---

## 8. Open items

### 8.1 Owner decisions — no research will help

| # | Decision | State of the evidence |
|---|---|---|
| **D.2** | **Reporting delivery**, including **pull-vs-push for agent-death alerts** | The transport exists; `reportQuery()` has four sinks and two of them are built. **Pull** (it shows on the dashboard next time you look) is simplest and free, but the heartbeat is then only as reliable as the habit of checking. **Push** is email or a webhook — **never an app (P2.6)**. ⚠️ Push depends entirely on §8.3 item C6: a Grafana contact point that demonstrably reaches the parent. **An alert nobody receives is decoration.** |
| **D.4** | **Bedtime window vs daily budget** | Mechanically unblocked: `active_s` is the meter, `schedule_budgets` is seated and empty, `policy_sets.kind` is the discriminator. Server side is a feature flag. ⚠️ **The agent side is real work** — a budget needs *elapsed* accounting, which is a genuinely different state machine and a new event type |
| **O.2** | **Away from home** | Never answered. Both candidate shapes are LAN-scoped. If yes: revisit the credential (add a short-lived token tier) and the transport (mTLS with an internal CA, terminating at Traefik). **The §4 contract does not change** — authentication is a transport concern |
| **O.4** | **Timeline** — term deadline or evenings-and-weekends? | Never answered. Sets how much of the PRO surface is worth building up front. §9's build order is written so that stopping after phase 3 still leaves a working, observable system |

### 8.2 Mac-side verifications

| # | Item | Cost | Consequence if skipped |
|---|---|---|---|
| **V-PKG-1** | ⚠️ **`sudo installer -pkg … -target /` downgrade in the system domain** | 10 min | §6.1. The user-domain result is ✅; the system domain is 📄 inference. **This gates the whole rollback story** |
| **V1–V9** | **T4's nine-case enforcement-isolation matrix** — the central unproven claim of the contract | ~2 h | See §8.4 |
| **V-SLEEP** | `IORegisterForSystemPower` delivery to a root LaunchDaemon on macOS 26, and how much time exists between `kIOMessageSystemWillSleep` and `IOAllowPowerChange` | 30 min | Expect: not enough for a network round-trip. **Confirms the `clean_exit` file must be load-bearing** (§3.8) |
| **V-NTP** | `systemsetup -getusingnetworktime` from a daemon without FDA | 5 min | A tripwire only |
| **V-DEADFALL** | `launchd StartCalendarInterval` on wake-from-sleep, and reloading its plist from another daemon | 20 min | §4.6's class-A backstop |
| **V-ROTATE** | Does `newsyslog` rotate a launchd `StandardOutPath` file for a running root daemon, and does the daemon write to the **new** inode (`lsof -p`)? | 15 min | §7.1. Otherwise the log silently goes to an orphaned inode |
| **V-LOCK** | **Two independent lock paths plus a boot-time self-test** | 1 h | §3.5. 📄 `ScreenSaverEngine.app` is the next `CGSession`, and macOS 27 has already been reported to have removed the `CGSession` path |
| **V-27** | Re-verify everything above on **macOS 27** | — | ⚠️ **Everything empirical here is macOS 26.6.2.** macOS 27 shipped 2026-09-14 with a rewritten Screen Time. **Pin the Mac mini to 26.x and re-test every enforcement primitive before accepting the upgrade** |

### 8.3 Cluster verifications — the 11, still owed

None has been done; there has been no cluster access throughout. Ordered by leverage.

| # | Check | Why it matters |
|---|---|---|
| **C6** | ⚠️ **What contact point exists, and does a test notification actually reach the parent?** | **Highest priority. Everything in §7 is inert otherwise**, and it is the gate on D.2's push option |
| **C2** | **Does the existing Alloy DaemonSet scrape pod stdout cluster-wide?** Read its ConfigMap/CR: `discovery.kubernetes` + relabel rules, which namespaces, which labels | **If yes, the control plane needs zero Loki-specific code.** The single highest-leverage check after C6 |
| **C8** | **The real Loki stream labels** in `arch-infra/platform/observability/alloy/values.yaml` | §7.5's rules assume `{app=, component=}`; the chart labels pods `app.kubernetes.io/*`. ⚠️ **Nobody has read this file** — every statement about how logs get labelled is inference |
| **C1** | Loki push endpoint and auth — `auth_enabled`? `X-Scope-OrgID`? a gateway with basic auth? | Sizes the forwarder's auth code |
| **C3** | Loki `limits_config` — `reject_old_samples_max_age`, `max_chunk_age`, ingestion rates, `max_streams_per_user` | Sizes the agent spool and decides whether §7.2's backfill rewrite is needed |
| **C4** | Is the compactor running with `retention_enabled: true`? | Without it, nothing ages out and the store grows forever |
| **C5** | Is there a Prometheus or Mimir at all? | Decides whether an optional gauge is worth exposing. **The design must not depend on it** |
| **C7** | How are Grafana alert rules and dashboards provisioned — sidecar ConfigMaps, grafana-operator CRs, provisioning files? | Rules must be GitOps'd, not clicked in. Determines the file format |
| **C10** | Notification-policy routing for `alertname=DatasourceNoData` | A5 depends on No Data → Alerting actually being delivered |
| **C11** | Grafana version | Confirms Unified Alerting, `or vector(0)` handling, State timeline |
| **C9** | Can the k3s node reach the mini at L3? | **Not required by this design (A.29).** Listed only so it is not re-proposed |

**Plus four day-one build checks**, all cheap, all before migration 0002:

| # | Check | Cost |
|---|---|---|
| B1 | ⚠️ **`casing: "snake_case"` against better-auth's drizzle adapter** — sign up, create a session, mint an API key, then `\d+ sessions` and confirm `user_id`, not `"userId"`. ✅ `homework` has no auth, so this has never been run in this house. `homecal`'s camelCase is the zero-risk fallback | 15 min |
| B2 | ⚠️ **The X2 carve-out** — 30 consecutive `/sync` calls, assert 30 × `200` | 20 min |
| B3 | **Create the `arch-infra` Application CR and `ARCH_INFRA_TOKEN` before trusting CI**, then make `bump-arch-infra` fail hard (A.22) and check the first bump landed by hand | 20 min |
| B4 | Confirm better-auth's `createApiKey` supports the `permissions` shape against the pinned version (`better-auth@^1.4.19`) | 15 min |

### 8.4 T4's V1–V9 enforcement-isolation matrix

**The central unproven claim of the whole contract.** Every case injects a failure at 21:00 with
bedtime at 21:30 and asserts enforcement is unaffected.

| # | Injected failure | Expected |
|---|---|---|
| V1 | Cluster powered off | Lock at 21:30 |
| V2 | Ethernet unplugged | Lock at 21:30 |
| V3 | DNS blackholed for the API host | Lock at 21:30 |
| V4 | Server returns 500 forever | Lock at 21:30 |
| V5 | Server accepts then hangs 120 s | Lock at 21:30 — **proves total sync timeout < one tick** |
| V6 | `launchctl bootout system/com.hpc.sync` | Lock at 21:30, **byte-identical enforcer logs** — the direct proof |
| V7 | Disk 100 % full | Lock at 21:30; telemetry drops, enforcement does not |
| V8 | `chmod 000 policy.current.json` | Falls back to `policy.lkg.json`, locks at 21:30 |
| V9 | Kill the enforcer at 21:29 with the deadfall installed | Lock at 21:30 from launchd |

Plus the two static assertions from §3.1 (`lsof` count = 0, `otool -L` has no HTTP client), which
belong in CI rather than in a manual matrix.

### 8.5 New contradictions found during synthesis — flagged, not resolved

Two, both of the same class as X1/X1b: a *local* stop-enforcing lever that nobody adjudicated against
A.7.

> ### ⚠️ X8 (new) — T3's freshness-token gate is a fourth stop-enforcing lever, unadjudicated
>
> T3 §5.3 makes the dead-man's switch **gate enforcement**: *"Before any enforcement action, the
> enforcement path re-reads that file. If `ts` is older than 3 × tick_interval, **the action does not
> fire.** … **It fails open.** If the file is missing, unreadable, or malformed, the answer is 'do not
> enforce'."*
>
> X1, X1b and X1c each removed a *remote* stop-enforcing lever. **Nobody checked the local one.**
> Under the two-daemon split it is worse than redundant:
>
> - The enforcer both **writes and reads** `enforcer.health`, so the check is a tautology — always
>   fresh, worth nothing.
> - If it is made non-tautological (some other component writes it), it becomes a **local bypass the
>   child can pull with one command**, since she has admin: `chflags uchg`, `chmod 000`, or simply
>   deleting the file stops enforcement and **fails open by design**.
> - That is the same shape as X1b — a failure condition that hands the child a lever — and it was
>   adopted into T3's blast-radius table as a **Day-1, highest-value/effort control**.
>
> **My reading, offered not applied:** the health file should be **the supervisor's input, not the
> enforcer's gate**. Staleness triggers rollback and an alert (which is T3's Layer 2 and is genuinely
> valuable), and **the enforcer never consults it**. That preserves the F2 detection T3 wanted while
> removing a lever A.7 exists to forbid. **Needs a ruling before the enforcer is written**, because
> the two designs differ by one `if` in the hottest safety path.

> ### ⚠️ X9 (new) — T3's enforcement rate limit is incompatible with D.3's ladder and with re-locking
>
> T3 §5.7: *"Hard cap: at most **1 enforcement action per 10 minutes**, and at most **5 per 24
> hours**… Exceeding the cap is a **health failure** — it trips the dead-man's switch, **disables
> enforcement**, and alerts."*
>
> Two collisions, neither noticed:
>
> 1. **D.3's ladder is two actions in five minutes** — `lock` at T-0, `shutdown` at T+300 s. The
>    "1 per 10 minutes" cap forbids the second one.
> 2. **Enforcement *is* re-locking every tick** while the predicate holds (that is how a late grant
>    releases the Mac at all). At 60 s that is 60 actions/hour against a cap of 5/day — so a
>    correctly-functioning agent trips its own circuit breaker within minutes, **and the penalty is
>    "disable enforcement"**, i.e. a self-inflicted bypass on the first ordinary bedtime.
>
> **My reading, offered not applied:** the cap should count **distinct enforcement *episodes*** —
> transitions from `outside_window` into `inside_window` — where one episode covers its whole ladder
> and every idempotent re-lock within it. `5 per 24 h` is then generous and F3 (the shutdown-loop bug
> class) is still caught. And ⚖️ **the penalty must not be "disable enforcement"**, for the same
> reason X1b rejected T3's 401 handling: it converts a bug into a bypass. The correct penalty is
> **stop escalating** — hold at `lock`, never reach `shutdown` — plus `DEGRADED` and an immediate
> notification. **Needs a ruling before the enforcer is written.**

---

## 9. Build order

**The control plane is buildable locally against a Postgres container today.** k3s is unreachable, so
every cluster dependency is deferred to phase 5 and nothing before it is blocked.

### Phase 0 — scaffold (½ day)

`pnpm/turbo` monorepo from `homework`'s newer conventions plus `homecal`'s auth wholesale.
`apps/api`, `apps/web`, `packages/contract`. Biome, tsconfig, Dockerfiles, `.claude/`.
**Do B1 (`casing` × better-auth) before writing migration 0002.**

### Phase 1 — contract package (½ day)

`packages/contract` first, before either consumer. Zod schemas for the sync request/response, the
policy document, the events envelope, the enrolment pair, and the `problem+json` + `hpc_action`
shape. **`.strict()` banned by lint. `event_id` pinned to UUIDv7 with its regex (A.12).** JSON-Schema
emitter wired into CI for the Swift side.

⚖️ *Why first:* R9. If the wire shapes are born inside `apps/api` they will be coupled to Drizzle
within a week, and "the payload evolves later" quietly becomes "every payload change is a migration".

### Phase 2 — control plane core (3–4 days, local Postgres)

1. Schema + migration 0001. **Assert `RAW_SAMPLE_RETENTION_DAYS > max_queue_age_days` at boot.**
2. Auth: parent sub-app (session cookie) + agent sub-app (`x-api-key`). **The X2 carve-out in all
   four places, with B2's test written in the same commit.** The `isService` user in the same
   transaction as the household (A.21).
3. **The policy compiler** — a pure function, with the golden-file suite. This is the riskiest logic
   and the cheapest to pin down; write the tests first.
4. `POST /enroll` (conditional `UPDATE … RETURNING`), `POST /sync`, `GET /policy`, `POST /events`,
   `GET /health`. Agent-scoped `onError` emitting `problem+json` + `hpc_action`.
5. Projection + rollups + the nightly prune.

**Exit criterion:** `curl` can enrol a fake device, fetch a signed policy, post events, and read them
back projected — entirely on a laptop.

### Phase 3 — the agent (5–7 days, on the Mac)

1. **`enforcer` first, and offline.** Tick loop, policy load + JWS verify + LKG fallback, the
   predicate, warnings via `osascript` and `CFUserNotification` (✅ both proven), the D.3 ladder,
   spool writes, `clean_exit`. **No network code, and `otool -L` proves it.**
2. **Run V1–V9 (§8.4) here**, against the local control plane from phase 2. This is the central
   unproven claim and it is cheapest to falsify before the sync daemon exists to confuse it.
3. `sync` daemon: tick, adaptive cadence, `queue.sqlite`, two-class eviction with the synthetic
   `queue.evicted` audit event, desired-state reconciliation, credential rotation.
4. `supervisor`: watchdog, pkg staging, install, offline rollback from the pkg cache. **V-PKG-1
   before relying on any of it.**
5. `deadfall`, including the override clause in its predicate.

⚠️ **Get a ruling on X8 and X9 before step 1**, because both change one `if` in the hottest safety
path.

### Phase 4 — parent UI (3–4 days)

`/` and `/devices/[id]` first — the two pages that carry the product. Then `/rules`, `/override`,
`/rules/calendar`, `/rules/history`, `/reports`, `/settings`, `/setup`.
**The wording is load-bearing in four places** and all four are specified: the still-enforcing banner
(§4.6), the no-unlock sentence (§3.5), Revoke vs Decommission (§5.5), and the `active_s` label
(§5.8).

### Phase 5 — cluster (1–2 days, gated on access)

Helm chart, `create-cluster-secret.sh` for `POLICY_SIGNING_KEY`, Argo CD Application CR,
`ARCH_INFRA_TOKEN`, **`bump-arch-infra` made to fail hard (B3, A.22)**. Then C2 and C8 before writing
a line of Loki code — **if the Alloy DaemonSet already scrapes pod stdout cluster-wide, there is no
Loki code to write.** Dashboard and the five alert rules, provisioned as code. **C6 last and loudest:
until a test notification demonstrably reaches the parent, §7 is decoration.**

### Phase 6 — hardening (ongoing)

Shadow mode and the soak (§6.5). Tripwire surfacing. `away_until`. The D.2 adapter, once the owner
picks a sink.

---

## Appendix — what this document deliberately does not contain

Recorded so a future reader does not go looking, and so nothing quietly grows back.

| Removed | Why |
|---|---|
| HOTP, `K_ovr`, the offline card, the printed fallback, `override_keys` / `override_redemptions` / `override_code_reveals`, `granted_via: 'offline_code'`, `desired kind: 'override_key'`, X3's reveal-record reconciliation, `/override/card` | **D.5.** T8's design stands in `raw/T8-parent-override.md` if it is ever needed |
| Window titles, browser URLs, `knowledgeC`, Biome, FDA, Screen Recording, per-browser Automation, `usage_hourly.topTitle` / `topUrlHost` | **D.1.** Re-read §3.6 before adding any of it |
| The $99/yr Apple Developer Program, Time Sensitive notifications, Developer ID signing, notarization, provisioning profiles | **D.7.** Ad-hoc throughout |
| `versions/` directory, `current` / `last-good` symlinks, the postinstall flip | **E.2.** Rollback is installing the older pkg from a local cache (§6.1) |
| `enforcementEnabled` in any spelling, `staleness.behaviour_after_max_age`, `stalenessMaxAgeS` | **X1, X1c.** There is nothing for them to do |
| The child→parent "Ask for more time" button, `request.extension`, a request table, a request inbox, any child-facing route | **C1 / X7**, P0.3 / P1.5 / P2.6 |
| The RPC command channel, `force_policy_refetch`, `set_log_level`, ack/retry/dead-letter machinery, a generic `desired` kind | **A.6.** Desired state took them all with it |
| Grafana Alloy on the Mac, Promtail, Prometheus for the agent, a Pushgateway | §7.2. A hop, not a capability — and Pushgateway serves stale values forever, which is actively harmful for liveness |
| Any ICMP/TCP probe of the Mac | **A.29.** The probe lies, and it can wake her Mac at 3 a.m. |
| MDM, declarative device management, reinstall survivability, heavy tamper resistance, non-Mac devices | De-scoped in `needs.md` §5 under **AR.1** |

---

## ⚠️ INVARIANT E — the enforcer has no off switch

**Ruled 2026-09-18. This governs X1, X1b, X1c, X8 and X9, and any future proposal of the same shape.**

> **No code path inside `enforcerd` may disable, suspend or skip enforcement.**
> Health signals, breakers and staleness checks are **inputs to the parent's view**, never **gates on
> the action**. The only legitimate relaxation is a policy-carried `override` with a mandatory
> `expires_at`; the only legitimate stop is an authenticated, parent-initiated decommission.

### Why this needed stating

**Six separate "stop enforcing" levers were proposed**, each locally reasonable. Five came from T3;
the sixth (X10) was written into this spec itself. What was independent was the *catching* — T5's
X-audit, then the ADR pass. That is the point: the levers cluster, the detection does not.

| | Lever | Track | Trigger |
|---|---|---|---|
| X1 | `enforcementEnabled: false` GitOps flag | T3 | parent, remote |
| X1b | 401 / credential revocation disables enforcement | T3 | server or network |
| X1c | cached policy expires past TTL | T3 | network outage |
| **X8** | **dead-man's-switch gates enforcement, fails open** | **T3** | **agent's own health** |
| **X9** | **action-rate breaker whose penalty is "disable enforcement"** | **T3** | **normal operation** |

Every one converts a *failure condition* into a *bypass*. Under **AR.1** the child has admin, so any
of them is reachable. The pattern is the hazard, not any single instance.

### X8 — dead-man's switch: RULED

The dead-man's switch is **the supervisor's input and an observability signal**, never the enforcer's
gate. `enforcerd` does not read its own health file to decide whether to act — that is either
tautological (it writes and reads its own liveness) or, for an admin child, a one-command bypass.

Its purpose is to tell the **parent** something is wrong. It keeps that purpose and loses the gate.

### X9 — enforcement-action breaker: RULED

T3's "1 action per 10 min, 5 per 24 h, penalty = disable enforcement" is incompatible with **D.3's own
ladder** (lock + shutdown = 2 actions inside the 300 s grace) and with per-tick re-locking (~60/hour).
**A correctly functioning agent would trip its own breaker into a self-inflicted bypass on the first
ordinary bedtime.**

Ruled:
- **Count episodes, not actions.** One bedtime window = one episode, however many locks, re-locks and
  the terminal shutdown it contains.
- **The penalty is "stop escalating", never "stop enforcing".** On trip, the enforcer holds at its
  current rung — it does not advance lock → shutdown — and emits a `breaker_tripped` event.
- **Runaway re-assertion is throttled, not broken.** POC 1 §5.2 already solved this with
  `REASSERT_MINUTES`; that is the right mechanism and it does not disable anything.

### Standing test

Any future proposal must answer: *"can this path result in the Mac staying usable past bedtime?"*
If yes, it does not belong in `enforcerd`.

---

## ⚠️ Invariant E — three further rulings (2026-09-18)

Raised by the ADR pass. Each is one `if` in the hottest safety path.

### X10 — "a warning that could not be displayed is a reason not to enforce this tick": **OVERRULED**

§3.3 contains a **sixth** stop-enforcing lever, written into this spec after Invariant E was
declared. Against the standing test — *can this path leave the Mac usable past bedtime?* — the answer
is **yes, and indefinitely**, if the warning surface fails persistently.

**Ruled: a failed warning delays *escalation*, never *enforcement*.**

- Bedtime still locks, warning or no warning. Lock costs a password and destroys nothing, so it is
  safe to apply unwarned.
- **The ladder may not advance past `lock` until a warning has been delivered successfully.**
  Shutdown without notice destroys work — that is the one thing D.3 exists to prevent.
- A persistent warning failure is a **health signal** (`warning_undeliverable`), surfaced to the
  parent like any other degradation. It is never a gate.
- **No console user logged in is not a skip** — it is a no-op. There is nobody using the Mac and
  nothing to warn. Distinguish the two cases explicitly in code; conflating them is how this lever
  got written in the first place.

### X11 — `policy.fail_mode`: **REMOVED**

The field lives *inside the signed policy document*, so in exactly the two classes where fail-open
applies — no policy, corrupt policy — **it cannot be read.** Its only reachable uses are in classes
that are already unconditionally fail-closed.

A configuration field that can only ever be read when it does not matter is worse than useless: it
implies the failure behaviour is tunable when it is not. **Fail behaviour is a compiled-in invariant,
not configuration.** You cannot configure your way out of enforcement — that is the whole point of
Invariant E. Remove the field.

### X12 — `shutdown_grace_s` may be zero: **CONSTRAINT TIGHTENED**

`CHECK (shutdown_grace_s BETWEEN 0 AND 3600)` lets `0` silently reconstitute bare shutdown, deleting
all four arguments that produced D.3's ladder — without anyone editing the enforcement action.

**Ruled: `CHECK (shutdown_grace_s BETWEEN 60 AND 3600)`.** The grace period is what makes the ladder
different from the thing it replaced; it cannot be nulled by a config value.

Two related cleanups: §4.3's example window still shows `"action": "shutdown"` and should show the
ladder; and T4 §11 row 25 describes a `lock → logout → shutdown` escalation whose **logout rung does
not exist** in D.3.

### The pattern, restated

Six levers now. Five were caught by audit, one was written into the spec *after* the invariant was
declared — by an author who had read it. **Assume the seventh is already in the code you are about to
write**, and run the standing test on every branch in the enforcement path.

---

## ⚠️ Invariant E — the dev-mode corollary (2026-09-18)

Enforcement is developed on the owner's MacBook Air, not the target Mac mini — the mini is in another
room and in constant use. The terminal `shutdown` rung is therefore stubbed during development.

**This is lever #7 if implemented carelessly.** A runtime switch that skips enforcement is exactly the
shape of X1, X8 and X10, and on a machine where the child has admin it is a one-line bypass.

### Ruled: the stub is compile-time only

- Enforcement actions sit behind an `EnforcementBackend` protocol.
- The recording backend is guarded by a compilation condition (`#if DEV_ENFORCEMENT`) and **is not
  compiled into release builds**.
- **No environment variable, no plist key, no config field selects it.** If it can be chosen at
  runtime it is a bypass, regardless of how it is named or documented.
- Release verification is mechanical, alongside the existing `otool -L` check that proves the enforcer
  links no networking: the shipped binary must contain **no symbol path** reaching the recording
  backend.

### What this leaves genuinely untested

| Rung | Dev coverage on the Air |
|---|---|
| Warnings | ✅ real — both surfaces proven on this hardware (§2 #12, #13) |
| Lock | ✅ real — costs a password, destroys nothing |
| 300 s grace | ✅ real |
| Shutdown | 🔷 recorded intent only |

The residual risk is **one line**: whether the Swift code correctly invokes `/sbin/shutdown`. The
primitive itself is already proven — POC 1's `test_shutdown.sh` performed a real power-off on this
same OS build. The *ladder as a sequence* is fully testable with the call stubbed, by asserting the
decision fired at the correct moment.

**Exit condition:** one scheduled end-to-end run on the actual Mac mini, with the real backend, before
production trust. Once — not a dev loop. `sudo killall shutdown` aborts a scheduled
`shutdown -h +N` if it goes wrong (POC 1 §8).

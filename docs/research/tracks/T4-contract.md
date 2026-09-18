# T4 — Agent ↔ control plane contract

**Date:** 2026-09-18
**Track:** T4 of [`poc2-plan.md`](../poc2-plan.md) · settles **H2** (polling vs push) and open question **O.1** (fail-open vs fail-closed)
**Inputs:** [`requirements.md`](../../requirements.md) — P2.1, P2.2, P2.4, P2.5, AR.1, AR.2
**Status:** design complete. Items marked ⚠️ need empirical verification on the M4 or against live k3s.

---

## 0. Verdicts first

| # | Question | Verdict |
|---|---|---|
| **V1** | **Polling or push?** | **Polling. H2 survives.** No requirement needs unconditional sub-minute latency. The one latency-sensitive interaction — parent grants time while the child is at the keyboard — is solved by *adaptive cadence* (60 s → 15 s near a boundary → 5 s while a parent is in the UI), not by an inbound listener. Worst case 5 s, zero new components on the Mac, no open port. Long-polling is the documented additive upgrade if ever needed. |
| **V2** | **Fail-open or fail-closed?** | **Fail-open on ignorance, fail-closed on knowledge.** If the agent cannot determine what the rules are → do not lock, and alert within one tick. If it knows the rules and merely cannot reach the server → enforce exactly as written, forever. Backed by an optional independent `deadfall` timer so that *total* agent death still locks at the last known bedtime. |
| **V3** | **Auth** | **A one-time enrolment code exchanged for one durable, device-scoped bearer credential** (a better-auth API-key record), remotely rotatable via the sync response, one-click revocable, scoped so narrowly that stealing it is boring. mTLS is the right answer at 100 devices, not at 1. |
| **V4** | **Policy staleness** | **Never expires.** A max-age that relaxes enforcement is a remotely-triggerable bypass (unplug the cable for 3 days). Staleness is a *reporting* concern, not a *behaviour* concern. Safe by construction because **every relaxation carries an expiry and only the baseline is durable** — so staleness can only ever converge toward stricter, never toward permanent permissiveness. |
| **V5** | **Shape** | **The policy tick *is* the heartbeat** — there is no separate heartbeat endpoint. `POST /api/agent/v1/sync` carries agent status + the ETag of the policy the agent holds, and returns policy-or-`unchanged` + desired state + cadence. **Telemetry goes to a separate endpoint** (`POST /events`) so a large, slow, rejected or poisoned batch can never make a live agent look silent. Adopted from track T6 — see §14. |
| **V6** | **Liveness** | **The control plane owns the state machine, not the agent.** A once-a-minute job emits an `agent_status` record for every device across five states — `HEALTHY` / `DEGRADED` / `EXPECTED_OFFLINE` / `UNEXPECTED_SILENCE` / `SILENT_TOO_LONG` — so alerting keys off the *presence* of a status record rather than the *absence* of data. T6's design, adopted verbatim; §9. |
| **V7** | **Schema evolution** | **Store first, interpret later.** Telemetry events are `{event_id, type, v, ts, data}` with `data` opaque to the transport; the server persists unrecognised event types verbatim into JSONB rather than rejecting them. Capability negotiation, not version sniffing. Tolerant readers in both directions. |
| **V8** | **Desired state, not RPC** | **Adopted in full, and pushed further than the first draft went.** There is no command channel. The server publishes *what should be true*; the agent reconciles every tick and reports convergence. A missed message is self-healing because the next tick re-reads and converges — whereas a missed command is simply lost. This also matches how the owner's existing infrastructure already works (Argo CD reconciles from Git; it does not push commands at the cluster), so it scores on "consistent" as well as on correctness. Prior art from T7; §4.6 and §14.6. |

**The single most important invariant in this document:**

> **The wire protocol has no "stop enforcing" verb.**
> No server response, error code, timeout or absence of response can cause the agent to stop
> enforcing a policy it holds. The only way to relax enforcement is a policy document
> containing an override that carries a mandatory `expires_at`. The sole exception is the
> explicit, authenticated, parent-initiated `410 Gone` decommission (§4.7) — which is an
> administrative action, not an error path.

This invariant is what makes hard requirement 1 ("enforcement MUST work with the server down") true
*structurally* rather than as a promise about code quality.

---

## 1. Design constraints this contract is answering

| Source | Constraint | Where it lands |
|---|---|---|
| Hard req 1 | Enforcement survives a dead server | §3 two-daemon split, §6 store-and-forward, §7 failure semantics, §9 matrix |
| Hard req 2 / P2.5 | Channel fixed now, payload evolves later | §5 schema evolution rules R1–R8 |
| Hard req 3 / P2.4 | 1 child now, N later, no hardcoded identity | `device_id` + `child_id` in every payload; policy is per-device; auth is per-device |
| Hard req 4 / H2 | Agent-initiated | §2 cadence, §10 falsification attempt |
| AR.1 | Child has admin, but is not an attacker | §5.6 signing is defence-in-depth not a boundary; §8 tamper signals are *tripwires* |
| AR.2 | Trusted LAN, mutual reachability | No relay, no NAT traversal, no mTLS tax |
| H1 | Location transparency | `base_url` is a config value; `http://localhost:8787` and `https://hpc.home.arpa` are the same contract |

---

## 2. Cadence

The agent has exactly one timer. Everything below is that timer changing its period.

| Mode | Period | Entered when | Cost on a LAN |
|---|---|---|---|
| `base` | **60 s** | default | 1440 req/day |
| `boundary` | **15 s** | `now` is within `poll.boundary_lead_s` (default 900 s) of the next warn-or-enforce transition | ~60 extra req/day |
| `attended` | **5 s** | server sets `next_poll_after_ms: 5000` because a parent has the device open in the UI (server-side 10-minute sticky flag) | ~120 req per parent session |
| `backoff` | 1 s → 300 s, full jitter | consecutive sync failures | fewer |

**The server owns the cadence.** Every response carries `next_poll_after_ms`; the agent obeys it,
clamped to `[1000, 300000]`. The agent's own boundary-proximity logic can only ever *shorten* the
interval below the server's suggestion, never lengthen it — so a server bug cannot slow the agent
down past 5 minutes, and a cold policy cannot make it hammer.

Backoff uses **full jitter** — `sleep = random(0, min(cap, base × 2^n))` — the AWS-canonical form,
which matters even at N=1 because it de-correlates the agent from the cluster's own restart storms.
`Retry-After` always wins over the formula when present.

Because sync and enforcement are **separate daemons** (§3), backoff can never slow enforcement. The
enforcer's 60 s tick is unconditional.

**Telemetry runs on its own clock, deliberately.** `POST /events` flushes every
`telemetry.flush_interval_s` (default **300 s**), *except* that any event with `class: "audit"` —
an enforcement action, a warning shown, a degradation, a clock step — forces an immediate flush.
So the things a parent would actually ask about arrive within seconds, while per-minute activity
samples arrive in five-minute batches. Separating this from the tick is T6's call and it is correct:
a 413, a 429, a poisoned batch or a slow 20-second upload must never be able to turn a live,
enforcing agent into an apparently silent one. **The liveness signal must be the cheapest and most
reliable request the agent makes.**

---

## 3. Topology: two daemons, one directory

The strongest available proof of hard requirement 1 is structural, not behavioural.

```
                      HOME LAN (trusted, mutual reachability — AR.2)
 ┌───────────────────────── child's Mac mini (Apple Silicon M4, macOS 26) ──────────────────────────┐
 │                                                                                                  │
 │   ┌──────────────────────────────┐            ┌──────────────────────────────┐                   │
 │   │ com.hpc.enforcer   (root)    │            │ com.hpc.sync   (root)        │                   │
 │   │ LaunchDaemon · 60 s tick     │            │ LaunchDaemon · 60 s tick     │                   │
 │   │ KeepAlive=true               │            │ KeepAlive=true               │                   │
 │   │ ██ OPENS NO SOCKET, EVER ██  │            │ the only thing that does IP  │                   │
 │   ├──────────────────────────────┤            ├──────────────────────────────┤                   │
 │   │ 1. read policy.current.json  │◀── write ──│ policy: tmp + rename(2)      │                   │
 │   │ 2. verify sig, else LKG      │   (atomic) │ (same fs ⇒ never torn)       │                   │
 │   │ 3. resolve now → IANA tz     │            │                              │                   │
 │   │ 4. predicate: now ∈ window?  │            │ ingests spool/*.ndjson       │                   │
 │   │ 5. warn / lock / shutdown    │── append ─▶│ into queue.sqlite, drains it │                   │
 │   │ 6. append event to spool     │  (NDJSON)  │ to the server, deletes only  │                   │
 │   └───────────────┬──────────────┘            │ what the server ACKed        │                   │
 │                   │                           └──────────────┬───────────────┘                   │
 │      /var/db/homeparentcontrol/   root:wheel, dir 0700       │                                    │
 │      ├── policy.current.json 0600  ◀━━ THE ONLY INPUT TO ENFORCEMENT                              │
 │      ├── policy.lkg.json     0600  ◀── last successfully parsed + signature-verified              │
 │      ├── credential.json     0600  ◀── device bearer key (sync daemon only)                       │
 │      ├── spool/*.ndjson      0600  ◀── enforcer's append-only handoff (single writer)             │
 │      └── queue.sqlite (+-wal) 0600 ◀── store-and-forward queue (sync daemon owns exclusively)     │
 │                                                              │                                    │
 │   ┌──────────────────────────────┐                           │                                    │
 │   │ com.hpc.deadfall  (optional) │ launchd StartCalendarInterval, regenerated on every policy      │
 │   │ fires at last-known bedtime  │ change; re-checks the wall-clock predicate before acting        │
 │   │ locks even if BOTH die       │ → the backstop for total agent death                            │
 │   └──────────────────────────────┘                           │                                    │
 └──────────────────────────────────────────────────────────────┼────────────────────────────────────┘
                                                                │
              HTTPS · agent-initiated · OUTBOUND ONLY · no inbound port anywhere on the Mac
                                                                │
        POST /api/agent/v1/sync    every 60 s │ 15 s near a boundary │ 5 s while a parent watches
        POST /api/agent/v1/events  every 5 min, or immediately for any class:"audit" event
                                                                ▼
 ┌────────────────────────── owner's single-node k3s cluster (aaron-desktop-arch) ───────────────────┐
 │                                                                                                   │
 │  Traefik ingress ──▶ Hono API ──┬── better-auth (API-key plugin) · verifies `Bearer hpc_dk_…`     │
 │                                 ├── zod, loose objects · tolerant reader (R1)                     │
 │                                 ├── policy svc · Ed25519 JWS · ETag = W/"pol-<hash>-v<version>"   │
 │                                 ├── telemetry ingest · UNIQUE(device_id, event_id) ⇒ idempotent   │
 │                                 ├── desired-state svc · retained until convergence observed  │
 │                                 └── liveness · `alert_due_at` deadline row (dead-man's switch)    │
 │                        Drizzle ▼                                                                  │
 │   Postgres  devices · policies · policy_versions · events(JSONB) · commands · api_keys · alerts   │
 │                                                                                                   │
 │  Next.js parent UI ──▶ edit rules · grant +30 min · see health · revoke device · decommission     │
 │  pino ──▶ Loki/Grafana ──▶ alerts fire on the ABSENCE of news, not on its presence                │
 └───────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 3.1 Why two daemons rather than one process with careful try/catch

A single process can be written so that a network failure cannot affect enforcement. Two processes
make it so that it *provably* cannot, and the proof is cheap to state and cheap to test:

1. `enforce(policy_bytes, now_utc) → action` has exactly two inputs: a local file and a clock.
2. The enforcer binary links no HTTP client. Assertable in CI and at runtime:
   `lsof -p $(pgrep -x hpc-enforcer) | grep -c -E 'TCP|UDP'` must equal `0`.
3. The two daemons share only a directory. The policy write is `write(tmp) + fsync + rename(2)` on
   the same filesystem, so the enforcer never observes a partial document.
4. The enforcer never blocks on the sync daemon: no locks, no XPC, no pipes, no SQLite contention.
   Telemetry handoff is enforcer → append-only NDJSON spool; the sync daemon is the sole SQLite
   writer. If the spool write fails, the enforcer drops the *telemetry* and continues the *tick*.
5. `launchd` supervises each independently; a crash-looping sync daemon has literally no code path
   into the enforcer.

⚠️ **Verification to run on the M4** (T4.3 asks for this empirically):

| # | Injected failure | Expected |
|---|---|---|
| a | Cluster powered off at 21:00 | Lock at 21:30 |
| b | Ethernet unplugged at 21:00 | Lock at 21:30 |
| c | DNS blackholed for `hpc.home.arpa` | Lock at 21:30 |
| d | Server returns 500 forever | Lock at 21:30 |
| e | Server accepts then hangs 120 s | Lock at 21:30 (proves total sync timeout < tick) |
| f | `launchctl bootout system/com.hpc.sync` at 21:00 | Lock at 21:30, byte-identical logs |
| g | Disk 100 % full | Lock at 21:30; telemetry drops, enforcement does not |
| h | `chmod 000 policy.current.json` | Falls back to `policy.lkg.json`, locks at 21:30 |
| i | Kill the enforcer at 21:29 with `deadfall` installed | Lock at 21:30 from launchd |

---

## 4. Endpoints

Base URL is configuration, not code (H1): `control_plane.base_url`. Everything below is relative to it.

### 4.0 Common headers

Every agent request:

```
Authorization: Bearer hpc_dk_01JB7ZQK9V8P0X3M2R5T6W.9f4c7a2e...
Content-Type:  application/json
Accept:        application/json
User-Agent:    hpc-agent/1.4.2 (darwin/arm64; macOS 26.0.1)
X-HPC-Device-Id:  dev_01JB7ZQK9V8P0X3M2R5T6W
X-HPC-Request-Id: 01JB8C3QD5F7H9K1M3P5R7T9Z      (UUIDv7, log correlation both ends)
```

Every server response carries `Date:` (a free, standards-defined clock reference — RFC 9110 §6.6.1)
and, on policy responses, `ETag:` and `Cache-Control: no-cache`.

Timeouts on the agent side, all strictly less than one tick: **connect 5 s, TLS 5 s, total 20 s.**

### 4.1 `POST /api/agent/v1/sync` — the tick

This is the agent's steady-state call and **it is the heartbeat** — there is no separate heartbeat
endpoint (T6; §14). It is simultaneously the liveness signal, the conditional policy fetch and the
command channel. It deliberately does **not** carry telemetry — that goes to `POST /events` (§4.4).

Putting the policy ETag in the *request body* rather than an `If-None-Match` header is deliberate:
the tick is a `POST` because it carries telemetry, so conditional-GET semantics do not apply. This is
exactly the pattern osquery adopted for TLS config refresh — the client sends its last `etag` in the
request body and the server answers with a minimal "unchanged" body — which cut config traffic by
>99 % while keeping immediate pickup. `GET /policy` (§4.2) remains available with proper RFC 9110
conditional semantics for cold start and for humans with `curl`.

**Request**

```json
{
  "contract": 1,
  "device": {
    "device_id": "dev_01JB7ZQK9V8P0X3M2R5T6W",
    "boot_id": "b_01JB8A2N4C6E8G0J2L4N6Q",
    "hardware_uuid": "4C3F2A1B-6D5E-4F7A-8B9C-0D1E2F3A4B5C",
    "agent_version": "1.4.2",
    "os_version": "26.0.1",
    "arch": "arm64",
    "system_boot_time": "2026-09-18T07:01:44.000Z"
  },
  "agent": {
    "started_at": "2026-09-18T07:02:11.412Z",
    "uptime_s": 48291,
    "tick_seq": 805,
    "clean_exit_previous_run": true,
    "previous_stop_reason": "shutdown",
    "capabilities": [
      "policy.v1",
      "policy.signature.ed25519",
      "policy.overrides",
      "telemetry.session",
      "telemetry.app_usage",
      "cmd.rotate_credential",
      "cmd.collect_diagnostics"
    ]
  },
  "clock": {
    "local_utc": "2026-09-18T20:29:58.004Z",
    "system_timezone": "Europe/London",
    "policy_timezone": "Europe/London",
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
    "consecutive_eval_failures": 0
  },
  "queue": {
    "depth": 37,
    "bytes": 21488,
    "oldest_event_at": "2026-09-18T19:41:02.000Z",
    "evicted_since_last_sync": 0
  },
  "converged": [
    {
      "desired_id": "des_01JB8B9X2Y4Z6A8C0E2G4J",
      "status": "converged",
      "observed_at": "2026-09-18T20:15:04.000Z",
      "detail": null
    }
  ]
}
```

**Response — steady state, nothing changed** (`200 OK`)

```json
{
  "contract": 1,
  "server_time": "2026-09-18T20:29:58.244Z",
  "device_status": "active",
  "policy": { "unchanged": true, "etag": "W/\"pol-7f3c9a21-v42\"", "policy_version": 42 },
  "desired": [],
  "next_poll_after_ms": 60000,
  "server_capabilities": ["policy.v1", "policy.signature.ed25519", "telemetry.app_usage", "cmd.rotate_credential"]
}
```

The unchanged-policy response is ~300 bytes and the request ~1.5 KB. At 1440 ticks/day that is
under 3 MB/day for one device — irrelevant on a LAN, but the same property is what makes the design scale
to N devices without thought.

**Response — policy changed** (`200 OK`)

```json
{
  "contract": 1,
  "server_time": "2026-09-18T20:31:02.101Z",
  "device_status": "active",
  "policy": {
    "unchanged": false,
    "etag": "W/\"pol-91b4e6d0-v43\"",
    "policy_version": 43,
    "jws": "eyJhbGciOiJFZERTQSIsImtpZCI6ImhwYy1wb2xpY3ktMjAyNi0wMSIsInR5cCI6ImFwcGxpY2F0aW9uL2hwYy1wb2xpY3kranNvbiJ9.eyJwb2xpY3lfdmVyc2lvbiI6NDMsIC4uLn0.q3Rn8w..."
  },
  "desired": [],
  "next_poll_after_ms": 15000
}
```

The policy travels as a **compact JWS** (RFC 7515) with `alg: EdDSA` / Ed25519 (RFC 8037). This is
not ceremony — it solves a real problem: signature verification must happen over *exactly the bytes
that were signed*, and a JWS payload is by construction a byte string, so there is no JSON
canonicalisation question (no need for RFC 8785 JCS, no risk of a re-serialisation mismatch). The
agent verifies the JWS, **then** parses the payload. When `policy.signing.enabled = false` the server
instead sends `"document": { … }` as a plain object and agents that advertise
`policy.signature.ed25519` log a `policy_unsigned` warning.

**Decoded policy document** (the JWS payload):

```json
{
  "policy_version": 43,
  "issued_at": "2026-09-18T20:30:55.000Z",
  "not_before": "2026-09-18T20:30:55.000Z",
  "device_id": "dev_01JB7ZQK9V8P0X3M2R5T6W",
  "subject": { "child_id": "chi_01JB7YHT4M6P8R0T2V4X6Z", "display_name": "Lucy" },

  "timezone": "Europe/London",
  "fail_mode": "open",
  "confirm_immediate_effect": false,

  "poll": { "base_interval_s": 60, "boundary_interval_s": 15, "boundary_lead_s": 900 },

  "agent": { "log_level": "info", "diagnostics_retention_days": 7 },

  "schedule": {
    "kind": "windows",
    "windows": [
      {
        "id": "win_school_night",
        "days": ["sun", "mon", "tue", "wed", "thu"],
        "restricted_from": "21:30",
        "restricted_until": "07:00",
        "action": "lock",
        "action_options": { "shutdown_grace_s": 300, "escalate_after_failures": 3 },
        "warnings": [
          { "lead_minutes": 15, "channel": "banner" },
          { "lead_minutes": 5,  "channel": "modal"  },
          { "lead_minutes": 1,  "channel": "modal"  }
        ]
      },
      {
        "id": "win_weekend",
        "days": ["fri", "sat"],
        "restricted_from": "22:30",
        "restricted_until": "08:00",
        "action": "lock",
        "warnings": [{ "lead_minutes": 10, "channel": "banner" }]
      }
    ]
  },

  "overrides": [
    {
      "id": "ovr_01JB8DFG2H4J6K8M0N2P4R",
      "type": "extend",
      "window_id": "win_school_night",
      "minutes": 30,
      "effective_date": "2026-09-18",
      "expires_at": "2026-09-19T05:00:00Z",
      "granted_by": "usr_01JB7X9A1B2C3D4E5F6G7H",
      "reason": "finishing history essay"
    }
  ],

  "expected_online": [
    { "days": ["mon","tue","wed","thu","fri"], "from": "07:00", "until": "21:45" },
    { "days": ["sat","sun"],                    "from": "08:00", "until": "22:45" }
  ],

  "telemetry": {
    "enabled": true,
    "sample_interval_s": 60,
    "collect": ["session.state", "enforcement.*", "app.usage_sample"],
    "max_queue_events": 50000,
    "max_queue_bytes": 33554432,
    "max_queue_age_days": 14,
    "audit_retention_days": 90
  },

  "staleness": {
    "warn_after_s": 86400,
    "behaviour_after_max_age": "continue_enforcing"
  }
}
```

Three fields deserve a note because they encode decisions rather than data:

- **`fail_mode`** (`"open"` | `"closed"`) — the O.1 answer is a *default*, not a hardcode. §7.
- **`staleness.behaviour_after_max_age`** — the only value permitted in contract v1 is
  `"continue_enforcing"`. The field exists so the decision is visible in the artefact rather than
  implicit in the code, and so the debate can be reopened without a schema change.
- **`action_options.shutdown_grace_s`** — see §8.5. When `action` is `shutdown`, the agent locks
  first and shuts down only after this grace period, *and only if still inside the window*. This
  exists because a shutdown destroys every remote recovery path (T7): you cannot push a corrected
  policy to a machine that is off.
- **`confirm_immediate_effect`** — blast-radius guard (T3.5). If a new policy would change
  enforcement state within 15 minutes of `issued_at`, the agent **refuses it** unless this flag is
  `true`. The parent UI sets it only after showing "this will lock Lucy's Mac in 4 minutes. Continue?"
  A fat-fingered `21:30` → `19:30` edit at 19:26 therefore cannot ruin an evening by accident.

### 4.2 `GET /api/agent/v1/policy` — canonical policy resource

Proper RFC 9110 conditional GET. Used by the agent only on cold start (no cached policy at all) or
when a sync response fails schema validation; used by operators with `curl` constantly.

```
GET /api/agent/v1/policy HTTP/1.1
Authorization: Bearer hpc_dk_…
If-None-Match: W/"pol-7f3c9a21-v42"
```

```
HTTP/1.1 304 Not Modified
ETag: W/"pol-7f3c9a21-v42"
Cache-Control: no-cache
Date: Fri, 18 Sep 2026 20:29:58 GMT
```

On change, `200 OK` with `ETag` and the same `{ unchanged:false, jws | document }` envelope as §4.1.

### 4.3 `POST /api/agent/v1/enroll` — one-time code → durable credential

Unauthenticated except by the code itself. Rate-limited hard (5/min/IP, 20/hour globally).

```json
{
  "contract": 1,
  "enrollment_code": "HPC-K7QM-3ZTD-9F2W",
  "device": {
    "hardware_uuid": "4C3F2A1B-6D5E-4F7A-8B9C-0D1E2F3A4B5C",
    "hostname": "lucy-mini.home.arpa",
    "model": "Mac16,10",
    "os_version": "26.0.1",
    "agent_version": "1.4.2"
  },
  "agent": { "capabilities": ["policy.v1", "policy.signature.ed25519", "telemetry.session"] }
}
```

```json
{
  "contract": 1,
  "device_id": "dev_01JB7ZQK9V8P0X3M2R5T6W",
  "credential": {
    "type": "bearer",
    "token": "hpc_dk_01JB7ZQK9V8P0X3M2R5T6W.9f4c7a2e13b58d06c4e79a2f5b1d8036",
    "key_id": "ak_01JB7ZR8S9T0U1V2W3X4Y5",
    "issued_at": "2026-09-18T10:00:00.000Z",
    "rotate_after": "2026-12-17T10:00:00.000Z"
  },
  "policy_signing_keys": [
    { "key_id": "hpc-policy-2026-01", "alg": "ed25519", "public_key": "MCowBQYDK2VwAyEA3s…" }
  ],
  "base_url": "https://hpc.home.arpa"
}
```

The token is returned **once** and never again (better-auth's API-key plugin stores a hash, not the
key). Errors: `400` malformed, `404`/`400` unknown code, `409` code already consumed, `410` code
expired — all as `application/problem+json`.

### 4.4 `POST /api/agent/v1/events` — telemetry

**All** telemetry goes here, never on the tick. Flushed every `telemetry.flush_interval_s`
(default 300 s), immediately for any `class: "audit"` event, and in 2 000-event batches (up to 4 per
tick) while draining a backlog. Keeping this off the tick is T6's call and it is right: the liveness
signal must not be able to fail because of the bulk data path (§14).

**Request**

```json
{
  "contract": 1,
  "device_id": "dev_01JB7ZQK9V8P0X3M2R5T6W",
  "boot_id": "b_01JB8A2N4C6E8G0J2L4N6Q",
  "events": [
    {
      "event_id": "01JB8C3QD5F7H9K1M3P5R7T9V",
      "type": "session.state",
      "v": 1,
      "class": "sample",
      "ts": "2026-09-18T20:25:00.000Z",
      "boot_id": "b_01JB8A2N4C6E8G0J2L4N6Q",
      "seq": 41203,
      "data": { "console_user": "lucy", "idle_s": 12, "screen_locked": false }
    },
    {
      "event_id": "01JB8C3QD5F7H9K1M3P5R7T9W",
      "type": "enforcement.warning_shown",
      "v": 1,
      "class": "audit",
      "ts": "2026-09-18T20:20:00.000Z",
      "boot_id": "b_01JB8A2N4C6E8G0J2L4N6Q",
      "seq": 41198,
      "data": { "minutes_remaining": 10, "channel": "modal", "acknowledged": false }
    },
    {
      "event_id": "01JB8C3QD5F7H9K1M3P5R7T9X",
      "type": "app.usage_sample",
      "v": 2,
      "class": "sample",
      "ts": "2026-09-18T20:26:00.000Z",
      "boot_id": "b_01JB8A2N4C6E8G0J2L4N6Q",
      "seq": 41205,
      "data": { "bundle_id": "com.apple.Safari", "foreground_s": 60, "active_s": 47, "cpu_pct_avg": 3.1 }
    }
  ]
}
```

**Response** — `202 Accepted`

```json
{
  "contract": 1,
  "accepted_event_ids": [
    "01JB8C3QD5F7H9K1M3P5R7T9V",
    "01JB8C3QD5F7H9K1M3P5R7T9W",
    "01JB8C3QD5F7H9K1M3P5R7T9X"
  ],
  "rejected_events": [{ "event_id": "01JB…", "reason": "malformed", "retryable": false }],
  "next_batch_allowed_in_ms": 0
}
```

`413` → the agent halves its batch size and retries. `429` → honour `Retry-After`. Every other
failure → the batch stays queued (§7.3) and **nothing about enforcement or liveness changes**.

Lifecycle events — `agent.started`, `agent.stopping { reason }` — are ordinary `class: "audit"`
events on this endpoint and therefore flush immediately (§9.2).

**`active_s` versus `foreground_s`, and why both are on the wire (T7).** Time accounting should be
gated on *activity*, not on an app merely existing or merely being frontmost — otherwise an idle
Spotify window left open overnight burns an hour of a daily budget. So the sample carries three
numbers: `foreground_s` (wall time frontmost), `active_s` (seconds in which the session was not
idle, from `HIDIdleTime` — T1.5), and `cpu_pct_avg`. **`active_s` is the number a budget must be
computed from.** Shipping all three now costs a few bytes and means the reporting layer can change
its mind later without a new agent — which is R8 doing its job. ⚠️ This matters for **D.4**: if the
rules ever become a daily budget rather than a bedtime window, `active_s` is the meter.

### 4.5 `GET /api/agent/v1/health` — unauthenticated liveness of the *server*

Returns `{"status":"ok","contract_versions":[1],"server_time":"…"}`. Exists so the agent can
distinguish "the network is down" from "the API is up but rejecting me", which changes what it logs
and what the parent is told.

### 4.6 Desired state, not commands

> **T7's reconciliation framing is adopted in full.** The first draft of this contract kept a small
> RPC command channel alongside the declarative policy. T7's prior-art finding — that the nearest
> existing project (`mac-screentime-enforcer`) uses a retained desired-state flag the agent
> reconciles continuously, and that a missed message is then self-healing — is correct and applies
> to every item that channel carried. **So the command channel is deleted.** §14.6 records what
> changed.

There are two places desired state lives, split by durability, not by semantics:

**(a) In the signed policy document** — durable agent configuration: the schedule, overrides,
telemetry collection, poll cadence, `agent.log_level`. Cached on disk, survives reboots, is what
enforcement reads.

**(b) In `desired[]` on the sync response** — per-device operational intent that should *not* be
persisted into the policy cache (because it is transient, or because it carries a secret). Re-sent
on **every** tick until the server observes convergence.

```json
"desired": [
  {
    "desired_id": "des_01JB8B9X2Y4Z6A8C0E2G4J",
    "kind": "credential",
    "spec": { "key_id": "ak_01JB9…", "token": "hpc_dk_…", "rotate_after": "2027-03-18T10:00:00Z" }
  },
  {
    "desired_id": "des_01JB8B9X2Y4Z6A8C0E2G4K",
    "kind": "diagnostics",
    "spec": { "since": "2026-09-18T18:00:00Z", "include": ["agent_log", "policy_cache", "queue_stats"] }
  }
]
```

| `kind` | Desired state it expresses | How convergence is observed |
|---|---|---|
| `credential` | "the credential you should be presenting is this one" | the server sees the new `key_id` actually used (§6.5) |
| `diagnostics` | "a diagnostics bundle for this window should exist" | the bundle arrives on `/events` tagged with the `desired_id` |
| `self_test` | "a completed enforcement self-test for this `desired_id` should exist" | the result event arrives |

Reconciliation rules, which are the whole point:

1. **Idempotent by `desired_id`.** The agent checks whether the desired state already holds before
   acting. Receiving the same item twenty times produces one action.
2. **Re-sent every tick until converged.** There is no retry policy, no `expires_at`, no ack
   bookkeeping, no dead-letter handling — because there is no delivery to fail. A dropped response,
   a crashed agent mid-action, a reboot: the next tick re-reads and converges.
3. **The server removes an item once it observes convergence**, not once the agent claims it.
   `converged[]` in the request is a *hint that lets the server check sooner*, not the proof.
4. **Unknown `kind` is reported, not ignored** (R6): `{"desired_id": "…", "status": "unsupported"}`.

**What this deletes outright:** `force_policy_refetch` was an RPC that existed only to defeat
caching — meaningless under reconciliation, since the agent re-evaluates every tick. `set_log_level`
was configuration masquerading as a command, and moved into the policy document.

**Grants were never commands** and this is the same principle: a grant is *state*, in
`policy.overrides[]`. This is also the direction Apple moved MDM with DDM — the server declares,
the device reconciles and reports — and, as T7 notes, the direction the owner's own Argo CD
deployment already works in.

### 4.7 Status codes and the `hpc_action` contract

Errors are RFC 9457 `application/problem+json`, extended with one machine-readable member:

```json
{
  "type": "https://hpc.home.arpa/problems/device-revoked",
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
| 401 | bad or revoked credential | `halt_sync_keep_enforcing` | **continues** |
| 403 | scope violation | `halt_sync_keep_enforcing` | **continues** |
| 409 | enrolment conflict | `reenroll` | continues |
| **410** | **device decommissioned by parent** | **`decommission`** | **stops — the one exception** |
| 413 | payload too large | `halve_batch` | continues |
| 422 | schema rejection | `drop_event` | continues |
| 426 | contract version retired | `upgrade_required` | continues |
| 429 | rate limited | `backoff` (honour `Retry-After`) | continues |
| 5xx / timeout / DNS / TCP | anything else | `backoff` | continues |

`decommission` is the only path by which the server can stop enforcement. It requires a valid
credential (so it cannot be spoofed by a hostile network), it is initiated explicitly by the parent
in the UI, and the agent's response is to wipe `policy.*`, wipe `credential.json`, emit a final
`agent.decommissioned` event, and `launchctl bootout` itself. Everything else — every error, every
timeout, every silence — leaves enforcement running.

---

## 5. Schema evolution (hard requirement 2 / P2.5)

The owner's instruction is that the channel is fixed now and the reported payload evolves later,
cheaply, without breaking older agents. That is achievable, but only if the rules are written down
*before* the first field is added. Here they are, as a contract, numbered so they can be cited in
review.

### R1 — Tolerant readers in both directions

Both ends **MUST** ignore fields they do not recognise. This is the single most important rule for
API resilience and it is one line of configuration in both languages:

- **Server (zod):** never call `.strict()` on anything on this boundary. Zod's default `.parse()`
  already strips unknown keys without throwing; `.strict()` is the only thing that breaks forward
  compatibility, and it must be banned by lint rule on `src/contracts/agent/**`.
- **Agent:** decode into a struct that discards unknown members, and keep the raw bytes for the
  signature check and for forwarding.

### R2 — Additive-only within a contract version

New fields are optional with a server-side default. **Never** rename, **never** change a type,
**never** repurpose a name. A field whose meaning must change gets a new name and the old one is
deprecated, then dropped only at the next major.

### R3 — Major version in the path, minor in a field

`/api/agent/v1/…` is the breaking-change axis. `"contract": 1` in every body is belt and braces for
logs and for bodies that arrive without their URL (queued replays). A `v2` is served alongside `v1`
for at least one full release cycle; `426` with `hpc_action: upgrade_required` is the retirement
signal, and **it does not stop enforcement**.

### R4 — Capability negotiation, not version sniffing

The agent advertises `agent.capabilities[]`; the server advertises `server_capabilities[]`. The
server sends a device only what that device has said it understands. This is strictly better than
`if (semver.gte(agent_version, "1.6.0"))` because it survives backports, partial rollouts and
downgrades, and because it makes the *decision* legible in a log line.

This is the concrete mechanism by which **D.1 (monitoring depth)** lands later without a flag day:
when T1 establishes that per-app foreground identity is permission-free, agent 1.6 starts
advertising `telemetry.app_usage`, the server starts requesting it from *only* those agents, and
agent 1.4 is completely unaffected.

### R5 — Unknown enum values degrade, they do not crash

`action` is a string, not an exhaustive union that throws. An unrecognised value (`"suspend_account"`
from a future server) maps to the agent's configured safe default (`lock`), emits a
`policy_degraded` audit event, and the parent sees "Lucy's Mac is running agent 1.4, which doesn't
understand the 'suspend account' action — it locked instead." Silent misbehaviour is the thing to
avoid; refusing to run is not the alternative.

### R6 — Unknown desired state is reported, never ignored

`{"desired_id": "…", "status": "unsupported", "detail": "unknown kind 'wipe_browser'"}`. The server
stops re-sending that item and the UI shows the capability gap. Silently discarding something the
server asked for is how you get a parent who believes they changed something and did not — and under
reconciliation, silently *retrying forever* is the other failure, which is why "unsupported" must be
a reportable terminal status rather than an absence of convergence.

### R7 — Policy is full state, never a diff

Every policy response is the complete document. No patch semantics, no ordering requirements, no
"apply failed halfway" state. Declarative, in the DDM sense. The cost is a few hundred bytes on
change; the benefit is that the agent's state is a pure function of the last document it accepted.

### R8 — Telemetry: store first, interpret later

This is the rule that actually delivers P2.5.

```
{ "event_id": <uuidv7>, "type": <string>, "v": <int>, "ts": <rfc3339>,
  "boot_id": <string>, "seq": <int>, "class": "sample" | "audit",
  "data": <opaque object> }
```

The transport knows about the envelope. It knows **nothing** about `data`. The server:

- persists every event into `events(device_id, event_id, type, v, ts, received_at, boot_id, seq, class, data JSONB)`;
- does **not** reject an unknown `type` — it stores it and increments a `unknown_event_type` metric;
- projects *known* `(type, v)` pairs into typed tables for reporting, on a schedule or on read.

So a new agent can start emitting `app.usage_sample v2` before a single line of server code knows
what that is, and the data is not lost — it is sitting in JSONB waiting for the projection to be
written. Adding per-app reporting later is then a *backfill*, not a *migration*, and certainly not a
redesign. This is what makes D.1 and D.2 genuinely safe to defer.

`v` is per-`type`, not global. `app.usage_sample v1` and `v2` coexist forever; the projection
handles both or ignores the one it doesn't know.

### R9 — Nothing on this boundary is a database row

The wire shapes in §4 are owned by `packages/contract/` and are **not** generated from the Drizzle
schema, and the Drizzle schema is not generated from them. Coupling them is how "the payload evolves
later" quietly becomes "every payload change is a migration". One zod schema module, published as a
package, consumed by the Hono API and by the agent's codegen. ⚠️ If the agent is not TypeScript
(T2.1 pending), this becomes a JSON-Schema artefact emitted from the zod schemas in CI.

---

## 6. Agent identity and authentication (T4.2)

### 6.1 The framing error to avoid

The four options in the brief are not four alternatives. **"Device enrolment" is a *flow*; bearer
token, mTLS cert and better-auth service account are *credential types*.** You need one of each. So
the real questions are (a) which credential type, and (b) how does it get onto the machine and how
does it leave.

### 6.2 What actually threatens this credential

Per **AR.1**, the child is not an attacker — but she *is* an admin on the machine, so the credential
is readable by her if she ever goes looking. No credential type fixes that. `sudo cat` defeats a file;
`sudo security` defeats the keychain; only a Secure Enclave non-exportable key resists it, and a root
LaunchDaemon can still *use* such a key without extracting it, which is the same practical outcome
for anyone sitting at the machine.

Therefore the design target is **not** "make the credential hard to read". It is:

1. **Make it boring to steal** — scope it so tightly that possessing it is worthless.
2. **Make it revocable in one click** without visiting the machine.
3. **Make it rotatable remotely** without visiting the machine.
4. **Make its misuse visible** — a tripwire, which is precisely what AR.1 asks for ("the tell would be
   any attempt to interfere with the agent at all").

### 6.3 Comparison

| | Long-lived bearer token | mTLS client cert | better-auth "service account" (human-session shaped) | **Device enrolment → scoped API key (recommended)** |
|---|---|---|---|---|
| Survives unattended reboot | ✅ file on disk | ✅ file/keychain | ✅ | ✅ |
| Rotate without visiting the machine | ⚠️ only if you build it | ⚠️ needs EST/ACME-style renewal | ✅ | ✅ **built in — §6.5** |
| Revoke instantly | ✅ delete row | ❌ needs CRL/OCSP or short TTLs | ✅ | ✅ one click |
| Resists a child with admin | ❌ | ❌ (unless SEP-backed) | ❌ | ❌ — **and neither does anything else** |
| Blast radius if stolen | whatever it is scoped to | same | ⚠️ often a *user* session = far too much | ✅ read own policy, post own telemetry, nothing else |
| Infra cost at N=1 | none | **own CA, renewal, Traefik `ssl-verify-client`, key distribution** | none (reuse) | none (reuse) |
| Reuses the sibling app's stack | — | ❌ | ✅ | ✅ |
| Hashed at rest server-side | build it | n/a | ✅ | ✅ |

### 6.4 Recommendation

> **One durable, device-scoped bearer credential, created by an enrolment flow, registered as a
> better-auth API-key record, presented as `Authorization: Bearer hpc_dk_…` over TLS.**
> No short-lived access-token exchange in v1.

Reasoning, explicitly:

- **Reuse, not novelty.** better-auth's API-key plugin already provides hashed storage, per-key
  expiry, per-key metadata, per-key `permissions: Record<string, string[]>`, and per-key rate
  limiting (`rateLimitEnabled` / `rateLimitTimeWindow` / `rateLimitMax`). That is the entire feature
  list we would otherwise hand-roll. Use `metadata: { device_id, hardware_uuid, agent_version }` and
  `permissions: { device: ["sync", "policy:read", "events:write"] }`.
- **Do not reuse the sibling app's *human* service-account shape.** A daemon is not a user. Binding a
  user identity to the device (which is what better-auth's Device Authorization plugin does — it
  implements RFC 8628, designed for signing a *person* into a TV) gives the stolen credential a
  user's blast radius. Wrong shape. Use a plain one-time enrolment token instead.
- **Skip the second tier.** A `client_credentials`-style exchange (durable key → 60-minute access
  token) reduces how often the durable secret is on the wire. On a TLS-protected LAN, the wire is not
  the threat; the disk is, and a token exchange does nothing for the disk. It adds a code path, an
  expiry failure mode, and a reason for the agent to need the server. Revisit only if **O.2** ("does
  'from my end' ever mean away from home?") resolves to yes.
- **Scope is the actual security control.** The device credential can call `/sync`, `/policy` (read)
  and `/events` for *its own* `device_id` and nothing else. It cannot read another child's data, it
  cannot write policy, it cannot reach the parent UI, it cannot enumerate devices. Stolen, it buys
  you: the ability to read your own bedtime, and the ability to lie in your own telemetry. Both of
  which you can already do by reading the policy cache and unplugging the cable. **The credential is
  not worth stealing, which is a stronger property than making it hard to steal.**

### 6.5 Remote rotation — the feature that earns its keep

The requirement "rotate without physically visiting the machine" is met by expressing the credential
as **desired state** (§4.6), overlapped so that a failure cannot lock the device out:

```
tick N     agent → sync (OLD key)   server → desired:[{ desired_id:"des_…",
                                                         kind:"credential",
                                                         spec:{ key_id:"ak_…NEW",
                                                                token:"hpc_dk_…NEW",
                                                                rotate_after:"2027-03-…" }}]
           agent writes credential.new.json, fsync, rename() over credential.json
           old key retained in credential.prev.json

tick N+1   agent → sync (NEW key) + converged:[{ desired_id:"des_…", status:"converged" }]
           server observes the NEW key_id actually in use ⇒ revokes OLD, drops the desired item

failure    if tick N+1 with NEW returns 401, the agent rolls back to credential.prev.json and
           carries on with OLD. The server never saw NEW used, so OLD is still live and the
           desired item is simply re-sent next tick. Nothing to retry, nothing to expire.
```

Note what reconciliation bought here: the failure path is *"do nothing and try again next tick"*,
because the desired item was never consumed. Under an RPC command channel the same failure needs an
ack timeout, a retry counter and a dead-letter state.

Schedule it every 90 days (`rotate_after`). It costs ~40 lines and converts "rotate the credential"
from a physical errand into a background non-event. It is also the disaster-recovery path: if the
credential leaks, the parent clicks Revoke, the agent goes to `credential_revoked` — **and keeps
enforcing the cached policy** — and re-enrolment is a single `sudo hpc-agent enroll --code …`.

### 6.6 Enrolment flow, concretely

```
 Parent UI                       Hono API                        Mac mini (installer, root)
 ─────────                       ────────                        ─────────────────────────
 "Add a device"  ──────────────▶ create devices row (pending)
                                 mint enrolment code
                                 HPC-K7QM-3ZTD-9F2W
                 ◀────────────── show code + copy-paste command
                                 (~60 bits Crockford base32, TTL 15 min, single use)

                                                    sudo hpc-agent enroll \
                                                      --server https://hpc.home.arpa \
                                                      --code HPC-K7QM-3ZTD-9F2W
                                 ◀─────────────────── POST /api/agent/v1/enroll
                                 validate + consume code
                                 create better-auth API key (scoped)
                                 ──────────────────▶ 201 { device_id, credential, signing keys }
                                                     write /var/db/…/credential.json 0600 root:wheel
                                                     bootstrap both LaunchDaemons
                                 ◀─────────────────── POST /sync  (first tick)
                                 devices.status = active
                 ◀────────────── device appears HEALTHY
```

### 6.7 Credential at rest on macOS

**File, not keychain.** `/var/db/homeparentcontrol/credential.json`, mode `0600`, owner `root:wheel`,
inside a `0700` directory; FileVault covers at-rest disk. The System keychain is writable only by
root anyway, and Apple's own forums are a catalogue of daemons fighting keychain access from outside
a user context — the recommended workaround is literally "make a 0700 directory and put a keychain
plus its password file in it", which has the same security properties as the file and more moving
parts. Since our daemon *is* root, the file is the honest answer.

Discipline that matters more than the storage mechanism:
- never log the token (redact `hpc_dk_[A-Za-z0-9_.-]+` in the pino redaction list and in the agent's
  logger);
- never put it in a `launchd` plist `EnvironmentVariables` block (world-readable);
- never put it in a command line (`ps` is world-readable);
- the enforcer daemon must not have it at all — it does not need it, and it does not open sockets.

### 6.8 Tripwires (AR.1's "tell")

Cheap, non-boundary signals the server should alert on:

| Signal | Detected by |
|---|---|
| Credential presented from a different `hardware_uuid` | `device.hardware_uuid` mismatch vs enrolment |
| Credential presented from an unexpected source IP | ingress log vs last-known |
| Two concurrent `boot_id`s for one `device_id` | replay / cloned credential |
| `policy_state.signature_valid: false` | cache edited on disk |
| `policy_version` regression (agent reports v41 after v43) | cache rolled back |
| `clock.using_network_time: false` | network time deliberately disabled |
| `clock.system_timezone != policy.timezone` | timezone changed on the Mac |
| Sync stops but the Mac is demonstrably awake (§9) | agent tampered with |

None of these is a security boundary. All of them are exactly the "any attempt to interfere at all"
that **AR.1** nominates as the trigger to reopen the threat model. Surface them as a single UI
banner, not as eight separate alerts.

### 6.9 Documented upgrade path

If device count grows or the Mac ever leaves the LAN (**O.2**): move to mTLS with a per-device
Secure-Enclave-backed key and an EST-style renewal against an internal CA, terminating at Traefik.
**The contract in §4 does not change** — authentication is a transport concern and the bodies are
identical. That is the point of keeping it in a header.

---

## 7. Store-and-forward (T4.3)

### 7.1 Where

`/var/db/homeparentcontrol/queue.sqlite` in WAL mode, **owned exclusively by the sync daemon**. The
enforcer hands off via append-only NDJSON spool files, so it never contends on a SQLite lock and
never blocks on I/O it doesn't control.

SQLite rather than flat files because dequeue must be atomic with the delete-after-ack, and it ships
with macOS. This is structurally the same design the OpenTelemetry Collector's persistent queue uses
— a write-ahead log on local disk, each batch keyed, **deleted only after the exporter confirms
delivery** — which is the right pattern and worth copying rather than reinventing.

```sql
CREATE TABLE queue (
  event_id   TEXT PRIMARY KEY,          -- UUIDv7, generated at the producer
  ts         TEXT NOT NULL,             -- advisory: the local clock, which may be a lie
  boot_id    TEXT NOT NULL,             -- authoritative ordering, with seq
  seq        INTEGER NOT NULL,
  class      TEXT NOT NULL,             -- 'audit' | 'sample'
  type       TEXT NOT NULL,
  v          INTEGER NOT NULL,
  bytes      INTEGER NOT NULL,
  payload    TEXT NOT NULL,             -- the full event JSON
  attempts   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX queue_drain ON queue (class DESC, boot_id, seq);
```

### 7.2 How much, and what gets thrown away first

Sizing from real numbers: ~2 events/minute while awake × 14 waking hours ≈ **1 700 events/day**, at
~250 bytes ≈ **420 KB/day**. So:

| Cap | Value | Rationale |
|---|---|---|
| `max_queue_events` | 50 000 | ≈ 29 days of normal production |
| `max_queue_bytes` | 32 MiB | ≈ 76 days; disk-safety bound, not capacity bound |
| `max_queue_age_days` | 14 (`sample`) | older activity samples are not worth the bytes |
| `audit_retention_days` | 90 (`audit`) | enforcement history is the product |

**Eviction is two-class FIFO:**

1. When any cap is hit, drop the **oldest `class:"sample"`** events first.
2. `class:"audit"` events are evicted **last, and only** if audit alone exceeds its own 10 000-event /
   90-day sub-cap.
3. Every eviction emits a synthetic `queue.evicted` **audit** event recording
   `{dropped_count, oldest_ts, newest_ts, reason}`.

Rule 3 matters more than it looks: it means the telemetry record is **honest about its own gaps**. A
report that silently omits four days because the queue wrapped is worse than no report. `audit`
covers enforcement actions, warnings shown, policy transitions, clock steps, agent start/stop,
degradation and eviction — i.e. everything a parent would ever ask "but what actually happened?"
about. `sample` covers per-minute session and app activity.

### 7.3 Draining without duplicating or losing

**At-least-once delivery + an idempotent sink = effectively-once.** The idempotency key is
`event_id`, applied **per event**, not per request:

```sql
INSERT INTO events (device_id, event_id, …) VALUES (…)
ON CONFLICT (device_id, event_id) DO NOTHING;
```

The retry sequence that must not break:

```
  agent ──▶ POST /events  events:[A,B,C]
                         server commits A,B,C
  agent ◀──  ✗ response lost (Wi-Fi drops mid-flight)
  agent still holds A,B,C; attempts++ ; backoff with full jitter
  agent ──▶ POST /events  events:[A,B,C]         ← same event_ids
                         ON CONFLICT DO NOTHING ⇒ 0 new rows
  agent ◀── accepted_event_ids:[A,B,C]
  agent deletes A,B,C from queue
```

The IETF `Idempotency-Key` header draft standardises the *request-level* version of this. We use a
**per-event** key instead, deliberately: a request-level key forces the whole batch to succeed or
fail as a unit and gives no vocabulary for "I took 498 of your 500 and rejected 2 as malformed". The
per-event form handles partial acceptance natively, which is exactly what `rejected_events[]` needs.
The header remains available if we ever need request-level replay protection on `/enroll` (where we
do not, because the code is single-use by construction).

**The agent deletes only what the server named in `accepted_event_ids`.** Never "delete everything I
sent". `rejected_events[].retryable:false` → delete and count; `retryable:true` → leave queued,
increment `attempts`, drop after 10 attempts with a `queue.poisoned` audit event so one malformed
event can never wedge the drain forever.

**Ordering is clock-independent.** `ts` is advisory because the local clock is not trustworthy (§8.3).
Ordering is `(boot_id, seq)`, and the server also records `received_at`. So a child stepping the clock
scrambles nothing — it just produces a `clock.stepped` audit event and some events with implausible
`ts`, which the reporting layer can correct against `received_at`.

**Drain rate:** steady state is one `POST /events` every 5 minutes carrying ~10 events, plus an
immediate flush per `audit` event. Draining a backlog uses 2 000-event batches, up to 4 per tick, so
a full day's backlog (1 700 events) clears in one tick and a fortnight's (24 000) in ~3 ticks.
Backpressure is `429` + `Retry-After`.

### 7.5 ⚠️ Replay hazard: Loki's out-of-order ingestion window (from T6)

T6 flagged that Loki accepts out-of-order lines only within `max_chunk_age / 2` — **1 hour** by
default — and **silently drops** anything older. Any outage longer than an hour therefore destroys
the replayed data on the Loki path without an error. Two rules follow, and they are why the queue
design above is Postgres-first:

1. **Telemetry events are authoritative in Postgres, not in Loki.** `POST /events` writes to the
   `events` table with the agent's own `ts` *and* the server's `received_at`. Nothing in the
   reporting path ever infers time from ingestion order. This path is immune to the hazard.
2. **Agent *log lines* forwarded to Loki are live-only.** On replay of a backlog older than the
   out-of-order window, the forwarder must either stamp lines with the current time and carry the
   true time in a structured field (`original_ts`), or skip Loki entirely for that replay — the
   record already exists in Postgres. Never replay old lines at their original timestamps and assume
   they landed.

This is a real cross-track catch: a naive implementation would have produced a reporting layer that
looks complete and silently loses precisely the outage data the parent most wants to see.

### 7.4 Proof that enforcement is unaffected

1. `enforce()` reads `policy.current.json` (falling back to `policy.lkg.json`) and the clock. That is
   the complete input set. The queue is not in it. The network is not in it. The credential is not in it.
2. The enforcer process opens no socket (§3.1, assertion 2) and links no HTTP client.
3. The enforcer's only write outside its own logs is an `O_APPEND` line to the spool. If that write
   fails — disk full, permissions, anything — it is caught, counted, and the tick continues. **The
   enforcement decision is taken before the spool write is attempted**, so the failure is strictly
   after the decision.
4. The enforcer takes no lock the sync daemon can hold and performs no IPC.
5. `launchd` supervises the two independently. `KeepAlive` on both; a crash-looping sync daemon
   cannot exhaust anything the enforcer needs (it is `ThrottleInterval`-limited by launchd).
6. Empirically: the nine-case table in §3.1 — and case (f), `launchctl bootout system/com.hpc.sync`
   at 21:00, is the direct proof, because the sync daemon simply isn't there and 21:30 still locks.

⚠️ The one shared resource is the filesystem. Disk-full is therefore the single genuine coupling, and
it is mitigated by: the 32 MiB queue cap; the sync daemon refusing to grow the queue below 1 GiB free;
and the enforcer treating a failed spool write as non-fatal by construction (point 3).

---

## 8. Failure semantics (T4.4)

### 8.1 "Fail-open or fail-closed" is too coarse a question

There are five distinct failures behind that one phrase, and they do not have the same answer.

| Class | Failure | Answer |
|---|---|---|
| **A** | Agent not running at all (crashed, unloaded, uninstalled) | **Not addressable in-agent.** See below. |
| **B** | Agent running, no cached policy at all | **Fail-open, loudly** |
| **C** | Agent running, cached policy corrupt / unparseable / bad signature | **Fall back to LKG → else fail-open, loudly** |
| **D** | Agent running, policy valid but stale (no server contact for days) | **Fail-closed — enforce as written, indefinitely** |
| **E** | Agent running, policy valid, but the clock is untrustworthy | **Fail-closed on the last trusted time basis** |

**Class A deserves being said out loud: you cannot fail closed from a process that isn't running.**
Anyone arguing for fail-closed has to confront that the most likely total failure — the daemon is
gone — is precisely the one where the agent has no say. `KeepAlive=true` makes the realistic version
a crash loop rather than an absence, and the *only* real answers are (i) server-side detection (§9)
and (ii) an enforcement mechanism that does not depend on the agent being alive — the **deadfall**:

> A third, trivially simple LaunchDaemon with a `StartCalendarInterval` set to the current policy's
> `restricted_from`. The sync daemon rewrites and reloads its plist whenever the schedule changes.
> It fires, re-checks the wall-clock predicate itself (so a wake-from-sleep late fire at 07:00 is a
> no-op), and locks. If both main daemons are dead, bedtime still happens.

It is ~30 lines and it closes the largest hole in the fail-open recommendation. Mark it **optional
hardening**, on by default.

### 8.2 The recommendation, and why

> ## Fail-open on ignorance. Fail-closed on knowledge.
>
> If the agent cannot determine what the rules are → **do not lock**, and alert within one tick.
> If the agent knows the rules and merely cannot reach the server → **enforce exactly as written**.

**The case for fail-open on ignorance (B, C):**

1. **Asymmetry of harm.** An unearned hour costs a conversation the next morning. A child locked out
   of homework at 19:00 by a parse bug costs a broken tool, a distressed child, a parent doing
   sysadmin at bedtime, and — decisively — the system's legitimacy. *A parental control that has ever
   locked a kid out wrongly is a parental control that gets uninstalled.* The project's own success
   depends on it never doing that.
2. **Asymmetry of recovery.** A missed bedtime is discovered the next morning and corrected socially.
   A wrongful 19:00 lockout must be corrected *in the moment*, by the parent, possibly over a network
   that is by hypothesis down, on a machine that is by hypothesis locked. The fail-closed branch has
   no reliable in-band recovery — the classic fail-closed trap, where a control that blocks without a
   documented recovery path gets permanently bypassed instead of fixed.
3. **Saltzer & Schroeder is being cited against itself.** The 1975 "fail-safe defaults" argument for
   default-deny rests explicitly on a *failure-behaviour* claim: a permission-based system fails by
   refusing, which is noticed and corrected, whereas an exclusion-based system fails by permitting,
   which "may go unnoticed indefinitely". **We remove that premise.** §9's dead-man's switch makes
   every open-failure loud — a self-reported `DEGRADED` notifies the parent immediately, and an
   unexplained silence is a state within 10 minutes. Once open-failures are noisy, the 1975 argument for
   closed-failure does not apply. Note also what the principle is *for*: it protects confidentiality
   of an asset. The asset here is a parenting outcome, and it is not leaked by an hour of Minecraft.
4. **The owner's own threat model says so.** **AR.1** states the child is not attacking the agent. The
   scenario "she induces a failure to win an hour" is therefore out of scope by the owner's explicit
   risk acceptance — and if she ever *does*, that attempt is exactly the signal AR.1 nominates as the
   trigger to reopen the model. Fail-open plus alerting converts a bypass attempt into a *detection
   event*, which is strictly more useful to a parent than a silent lock.
5. **Blast radius (T3.5).** POC 1 found both its bugs on the enforcement path. Fail-open is the only
   setting under which a bad deploy at 18:00 cannot ruin the evening.

**The case for fail-closed, stated fairly, because it is not weak:**

> Fail-open makes the failure mode *the reward state*. Any bug that kills the agent grants exactly
> what the child wants. Over months, a child with no technical intent whatsoever will still learn the
> correlation — "when the Wi-Fi is weird, bedtime doesn't happen" — and a learned correlation becomes
> a deliberate behaviour. Fail-open can therefore *teach* the child to break the system. That is a
> real cost and it is the strongest argument on that side.

**Why the rebuttal is targeted rather than dismissive:** the child-reachable failure is "the network
is down", and **that case is already fail-closed** (class D). The fail-open branches are *only*
"never configured" and "the policy file on disk is corrupt" — one happens once at install, the other
requires root. Neither is reachable by unplugging a cable, closing a lid, or turning off Wi-Fi. So the
learnable-bypass surface is nearly empty, and the deadfall (§8.1) covers the residue. That is what
makes the split defensible where a blanket "fail-open" would not be.

**Escape hatch:** `policy.fail_mode` is `"open"` by default and settable to `"closed"` per device, so
this is a decision the owner can revisit in the UI rather than in a pull request. Under
`fail_mode: "closed"`, classes B and C lock during any window present in the LKG policy, or — if no
policy has ever existed — during a compiled-in conservative default (`21:30–07:00`, action `lock`).

**In every case the agent screams.** A fail-open branch emits `agent.degraded` (class `audit`) every
tick with `reason: "policy_missing" | "policy_corrupt" | "policy_unverified"`, the device enters
`DEGRADED` and notifies the parent immediately, and the parent gets one banner: *"Lucy's Mac is not enforcing —
its rules are missing or unreadable."* Fail-open is not the same as fail-silent, and the entire
argument above depends on that distinction holding.

### 8.3 Policy staleness

> **Verdict: the cached policy never expires. Staleness changes what the parent is told, never what
> the agent does.**

Three candidate behaviours, and why two are wrong:

- **"After N days, stop enforcing."** ❌ This is a remotely-triggerable bypass. Unplug the ethernet
  cable for three days and bedtime evaporates. It hands the child a switch. Never.
- **"After N days, get stricter."** ❌ This punishes the child for the parent's cluster being down,
  which is a wrongful-restriction failure — the exact harm §8.2 is organised around avoiding.
- **"Keep applying it, forever, and say so loudly."** ✅

This is only safe because of a contract rule that makes it safe **by construction**:

> **Every relaxation carries a mandatory `expires_at`. Only the baseline schedule is durable.**

`overrides[]` entries — a +30-minute grant, a "no bedtime tonight" suspension — **must** carry
`expires_at`, and the agent rejects any override without one. Consequently a stale policy can only
ever converge toward *stricter* (grants age out and the baseline reasserts itself), never toward
permanently permissive. A policy from three days ago is, at worst, a policy whose grants have all
expired. There is no reachable state where staleness produces a permanent free pass.

What staleness *does* change:

| `policy_state.age_s` | Agent | Server / parent UI |
|---|---|---|
| < 1 h | normal | `HEALTHY` |
| 1 h – 24 h | normal | shows "rules confirmed 4 h ago", no alert |
| > 24 h (`staleness.warn_after_s`) | normal, emits `policy.stale` audit event each 6 h | ⚠️ banner: "Lucy's Mac hasn't checked in for 2 days — it is still enforcing the rules from Tuesday" |
| > 7 d | normal | escalated alert; UI stops showing "what Lucy did today" as authoritative |

Note the wording of the banner. It tells the parent *both* facts — that contact is lost **and** that
enforcement continues — because the natural parental fear on seeing "offline" is "so the rules aren't
working", which is the opposite of the truth.

### 8.4 Time: clock, timezone, DST

The prior POC compares wall-clock time-of-day rather than elapsed time, deliberately, so that
sleeping through bedtime banks nothing. That choice is correct and it also turns out to be what makes
the DST story easy. Here is why, and where it still bites.

#### 8.4.1 A predicate, not a trigger — and why that is DST-proof

The agent asks, every tick: **"is `now` inside `[restricted_from, restricted_until)`?"** It does not
schedule a one-shot at 21:30. This distinction is the whole DST answer:

- **Spring forward.** A cron-style "fire at 02:30" is simply *skipped* — that wall-clock instant does
  not exist. A predicate has nothing to skip; it asks a question every 60 seconds and gets a correct
  answer on both sides of the gap. The night is 23 hours long, which is correct.
- **Fall back.** A cron-style "fire at 01:30" *fires twice*. A predicate evaluates "inside the window"
  twice, which is the same answer both times, so nothing is doubled. The night is 25 hours long,
  which is also correct — "you sleep until 07:00 local" is exactly what a parent means.

So the deliberate wall-clock choice is vindicated twice: it prevents banking sleep, and it immunises
the system against the entire class of DST scheduling bugs.

For completeness, the boundary-resolution rules that still need stating:

- A boundary falling in a **skipped** hour snaps forward to the first instant that exists.
- A boundary falling in an **ambiguous** (repeated) hour resolves toward enforcement: **earlier**
  occurrence for `restricted_from`, **later** occurrence for `restricted_until`. All DST transitions
  occur between 01:00 and 03:00 local, i.e. inside the restricted window where the child should be
  asleep, so the harm asymmetry of §8.2 does not bite here.

#### 8.4.2 Rules

1. **`policy.timezone` is an IANA name, never a UTC offset.** An offset is wrong for half the year.
2. **The policy's timezone wins, not the Mac's.** The agent computes local time as
   `utc_now → policy.timezone`, ignoring the system timezone entirely. If the child sets the Mac to
   `Pacific/Honolulu`, bedtime does not move. The system timezone is *reported* (`clock.system_timezone`)
   and a mismatch is a tripwire (§6.8), not an input. Families that genuinely travel change the
   policy timezone — explicit, audited, and one click.
3. **Never precompute more than the current and next boundary**, and never cache a resolved UTC
   instant across ticks. `tzdata` changes by government decree; a cached instant is a latent bug.
   Recompute each tick from `(local_time_string, tz_name)`.
4. **Warning offsets are computed in absolute time, not wall-clock arithmetic.** Resolve
   `restricted_from` to an absolute instant using the IANA zone *first*, then subtract 15/5/1 minutes
   in UTC. Doing "21:30 minus 15 minutes = 21:15" as strings and *then* resolving is the bug that
   produces a warning an hour early on transition night.
5. **Report `tzdata_version`** on every sync so a Mac with stale tz rules is visible.
6. **DST produces no UTC discontinuity.** Because everything is computed in UTC + an IANA zone, a DST
   transition is *not* a clock step, and the tamper detector in §8.4.3 will not false-positive on it.
   A naive local-time-based detector would fire twice a year and train the parent to ignore it.

#### 8.4.3 Clock skew and deliberate clock changes

macOS requires an admin unlock to change Date & Time (`system.preferences.datetime`, and
`system.settings.datetime` on recent releases). The child has admin, so this is a live possibility —
but per **AR.1** it is a tripwire, not a boundary. Detection is cheap and has three independent legs:

**Leg 1 — server reference.** Every response carries `server_time` and an HTTP `Date` header.
`skew = local_utc − server_utc`.

| Skew | Behaviour |
|---|---|
| ≤ 60 s | normal |
| > 60 s | emit `clock.skew` audit event; keep using the local clock |
| > 5 min | **treat the local clock as untrusted**: evaluate policy against `server_time_at_last_sync + monotonic_elapsed`, emit `clock.untrusted`, banner to the parent |

**Leg 2 — offline step detection, via a sleep-surviving monotonic clock.** Between consecutive ticks,
`Δrealtime` should ≈ `Δcontinuous`. If `|Δrealtime − Δcontinuous| > 30 s`, the wall clock was set.
Record `clock.stepped {from, to, delta_s}` and prefer the monotonic projection until the next
successful sync confirms a real time.

⚠️ **Implementation detail that will bite if missed:** on macOS the monotonic clock must be
`mach_continuous_time()` (equivalently `clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW)`), which continues
advancing while the system is asleep. `mach_absolute_time()` / `CLOCK_UPTIME_RAW` **stop during
sleep**, so using them would make every overnight sleep look like a backwards clock step — the
detector would cry wolf every single morning and be turned off within a week. This is the difference
between the feature working and the feature being deleted.

**Leg 3 — network time posture.** Report `clock.using_network_time`. Keep
`systemsetup -setusingnetworktime on`; if it goes off, that is a tell. ⚠️ Verify on macOS 26 whether
`systemsetup` still reports this without Full Disk Access from a daemon.

**Net effect:** setting the clock back to 19:00 at 21:29 does not buy an extra hour — the agent is
evaluating against a monotonic projection — and, more valuably, it produces an audit event that lands
in the parent's UI. The evasion becomes a notification.

### 8.5 The enforcement action changes the cost of every failure (T7)

T7's constraint: **if enforcement is `shutdown`, every remote recovery path disappears.** You cannot
push a corrected policy, collect diagnostics, or SSH into a machine that is off. This is not a
footnote — it changes the meaning of half the failure matrix, so the contract has to carry it.

Three contract-level consequences:

1. **`shutdown` is lock-then-shutdown, never shutdown.** When `action: "shutdown"`, the agent
   performs `lock` immediately and shuts down only after `action_options.shutdown_grace_s`
   (default **300 s**), and only if the wall-clock predicate still holds. That five-minute window is
   the entire remote-recovery budget for a mistaken policy: a corrected policy arriving inside it
   (≤ 15 s in `boundary` mode) cancels the shutdown. Without this, a fat-fingered edit costs someone
   a walk to the child's room.
2. **The agent must never be able to lock the parent out.** A hard invariant, enforced by the
   *schema* rather than by discipline: the policy document has no field that can disable Remote
   Login (`systemsetup -setremotelogin`), modify or disable an admin account, alter `sudoers`, or
   change FileVault state. There is no way to express those things, so no bug and no bad policy push
   can do them. ⚠️ The installer must likewise verify Remote Login is enabled and refuse to install
   if the parent has no out-of-band path to the machine.
3. **`lock` is the contract's default.** D.3 remains formally open, but this contract has an opinion
   and it is on the record: `lock` keeps every recovery path alive, `shutdown` closes them all, and
   the difference costs the parent nothing in enforcement terms — a locked Mac is exactly as unusable
   as an off one.

This also feeds §8.2: under `action: "shutdown"`, a wrongful enforcement is not merely disruptive but
*remotely unrecoverable*. That asymmetry makes the fail-open recommendation stronger, not weaker —
the worse the consequence of a wrong lock, the less appetite there should be for locking on
uncertainty.

---

## 9. Heartbeat and liveness (T4.5) — T6's design, adopted

> **This section is track T6's design, not a parallel one.** T6 completed first and owns the
> liveness state machine; T4 owns the wire shapes that feed it. Where I have added anything, it is
> marked **[T4 addition]**, and the one gap I am handing back to T6 is in §9.6. Full reconciliation
> in §14.

### 9.1 The actual problem

"The agent has gone silent" and "the Mac is off because the child is asleep" look identical from the
server: no requests. Getting this wrong in either direction destroys the feature — alert on every
bedtime and the parent mutes it; never alert and the dead-man's switch is decorative.

### 9.2 What the agent contributes

**The policy tick is the heartbeat.** `POST /api/agent/v1/sync` (§4.1) *is* the liveness signal.
There is no `/heartbeat` endpoint and there must not be one — a second liveness path is a second
thing that can be healthy while the real one is broken.

The agent contributes exactly three things beyond the tick itself:

1. **`agent.started`** — an `audit` event on `POST /events`, flushed immediately, carrying
   `boot_id`, `agent_version`, and `clean_exit_previous_run`.
2. **`agent.stopping { reason }`** — `reason ∈ {"sleep","shutdown","logout","reload","signal"}`,
   emitted on `NSWorkspaceWillSleepNotification` and on `SIGTERM`, flushed synchronously.
3. **A persisted `clean_exit` flag** at `/var/db/homeparentcontrol/clean_exit` — written *before*
   stopping and cleared on start. This is the load-bearing one, because it survives the case where
   the `stopping` event was generated but never delivered (the server was down, or the network went
   with the power). On the next boot the agent reports `clean_exit_previous_run` on its very first
   tick, so the previous shutdown is classified retrospectively and correctly.

**No ICMP or TCP probe of the Mac. Ever.** T6 is right and the reasoning is worth recording so
nobody re-proposes it in six months: a **Bonjour Sleep Proxy** answers ARP on behalf of a sleeping
Mac, so a ping succeeds against a machine that is asleep — the probe *lies*. And with **Wake for
network access** enabled, a probe can *wake the machine at 03:00*, which is both a false signal and
an actively harmful one in a bedtime-enforcement product. Liveness is inferred from what the agent
says, never from what the network says.

### 9.3 The five states — computed by the control plane, once a minute

A scheduled job evaluates every device once a minute and **writes an `agent_status` record**. This
is the property that matters and it is not cosmetic:

> **Alerting keys off the presence of a status record, not the absence of data.**
> A LogQL query that matches nothing returns *no series*, not `0`. An alert written as
> "fire when no lines in 10 minutes" therefore silently degrades to Grafana **"No Data"** — which by
> default is not an alert. Emitting a row per device per minute converts every liveness question
> into a positive assertion that can be compared, graphed and alerted on normally.

| State | Condition | Parent sees | Notifies? |
|---|---|---|---|
| `HEALTHY` | last tick within tolerance | green | — |
| `DEGRADED` | ticking normally, but the agent self-reports a problem: `policy_missing`, `policy_corrupt`, `signature_invalid`, `enforcement_failed`, `clock_untrusted`, `disk_full` | **red** | **immediately** |
| `EXPECTED_OFFLINE` | last event was `agent.stopping`, **or** the device is outside its `expected_online` window | grey "asleep" | never |
| `UNEXPECTED_SILENCE` | **10 minutes** of silence with no `stopping` event and inside an `expected_online` window | amber | after 60 min **[T4 addition]** |
| `SILENT_TOO_LONG` | **36 hours** of silence, regardless of windows or `stopping` events | red | immediately |

**Thresholds are T6's (10 min / 36 h) and I adopt them unchanged.**

**[T4 addition] — a notification threshold layered on top of the state threshold.** A state
transition and a parent's phone buzzing are different things, and `UNEXPECTED_SILENCE` at 10 minutes
will be entered routinely by a macOS software-update restart, which can exceed 10 minutes on an
Apple-silicon Mac. So: enter the state at 10 minutes (visible in the UI, graphed, alertable by the
owner if he wants it), **notify the parent only once it has persisted for 60 minutes**. This changes
nothing about T6's state machine; it adds an escalation policy above it. `DEGRADED` and
`SILENT_TOO_LONG` notify immediately, with no such delay.

**[T4 addition] — do not arm at the start of a window.** Require a device to have been `HEALTHY`
at least once *within the current* `expected_online` window before it can enter
`UNEXPECTED_SILENCE`. Without this, every school holiday and every late start produces a 07:00
amber. (`SILENT_TOO_LONG` is unaffected — it is deliberately window-independent.)

### 9.4 Device lifecycle is a separate axis

`UNENROLLED` / `ACTIVE` / `REVOKED` / `DECOMMISSIONED` are values of `devices.status`, an
administrative field. They are **orthogonal** to the five health states, not additional members of
them — a `REVOKED` device can still be `HEALTHY` in the sense that matters (it is alive and
enforcing; it is simply not being accepted). Conflating the two axes is how a UI ends up unable to
say "alive, enforcing, and locked out of the API", which is exactly the state a revoked device is in.

### 9.5 Who watches the watchman

The state machine lives on the cluster, so a dead cluster means no `agent_status` rows. Two cheap
mitigations, both reusing what the owner already runs (P3.2 / P3.4):

- Export `hpc_agent_status{device_id, state}` and `hpc_device_last_sync_seconds{device_id}` as
  Prometheus gauges. A gauge is itself presence-based — it exists as long as the device row does —
  so this is the same principle applied one layer up. Add a Prometheus `absent()` / `up == 0` rule
  on the API itself so "the cluster is down" is answered by the existing alerting stack.
- The agent's per-tick log line reaches Loki through the existing pipeline (T6), so "the agent is
  alive but the API is rejecting it" stays visible even when the API's own view is wrong.

### 9.6 ⚠️ A gap I am handing back to T6

The five-state machine has **no way to express "the parent already knows, and it's fine"**. A family
away for a long weekend, a Mac put away for the school holidays, a machine at the repair shop — all
of these trip `SILENT_TOO_LONG` at 36 hours. It will fire, it will be benign, and the second or third
time it fires benignly the parent will mute the channel, at which point the dead-man's switch is
decorative again. This is the specific failure mode §9.3's whole design is trying to avoid, arriving
by a different door.

**Proposed fix, for T6 to accept or reject:** a `devices.away_until` timestamp, settable in one click
from the device card, that forces `EXPECTED_OFFLINE` until it passes. It is one column, one UI
control and one clause in the state function, and it is the difference between an alert channel the
parent trusts and one they have muted. Note that it must *not* be expressed as a policy override —
overrides relax **enforcement** (§8.3) and this must relax only **alerting**; a device that is away
should still enforce its bedtime the moment it is switched on.

### 9.7 Heartbeat as a tamper signal — weighted correctly (T7)

T7 notes that the nearest prior-art project treats an absent heartbeat as evidence of *tampering*,
not merely of downtime. That is a real pattern and worth having — but **AR.1 records that the owner
assesses the child as unable to stop an auto-starting daemon**, so it must not be over-weighted.
Silence is mostly evidence of a Mac being off, which is the boring and correct explanation almost
every time.

The useful move is to make the two cases separable *without a probe*, and one field does it:
`device.system_boot_time` (§4.1). On the agent's next contact after any silence, the control plane
compares the silence window against the machine's boot time:

| Observation | Reading |
|---|---|
| `system_boot_time` falls **inside** the silence window | The Mac was off or restarted — benign. Reclassify the gap as `EXPECTED_OFFLINE` retrospectively |
| `system_boot_time` is **unchanged and earlier** than the silence — the machine was up throughout | **The Mac was running and the agent was not.** A crash-loop, or something stopped it |
| … and `clean_exit_previous_run` is `true` with `stopping.reason: "signal"` | Something issued a clean stop (`launchctl bootout`) while the machine stayed up — the strongest available tell |
| … and `clean_exit_previous_run` is `false` | A crash. Pair with the crash-loop counter; this is an engineering bug, not a child |

This delivers the broken-vs-powered-off distinction — which T7 rightly identifies as the more
valuable one — **for free, from data already on the wire, with no network probe** (§9.2).

**Weighting, deliberately:** surface all of it as a line on the device health card alongside §6.8's
tripwires, **not** as a notification. Under AR.1 the value of a tamper signal is that it exists to be
found when someone later asks "has she ever tried?", not that it pages a parent tonight. If the
answer ever becomes yes, that is the trigger AR.1 nominates for reopening the threat model — and at
that point the signal is already collected and historical, which is worth considerably more than an
alert nobody wired up.

---

## 10. The polling-vs-push hypothesis (H2) — falsification attempt

The brief asks specifically whether anything genuinely needs sub-minute latency. The honest answer is:
**one thing does, in a narrow and predictable window, and it does not require push to solve.**

### 10.1 The one latency-sensitive interaction

*The parent grants 30 extra minutes at 21:29 and wants it to take effect now.* With a fixed 60 s poll
the child can see a lock screen for up to 60 seconds after the grant. Annoying, and exactly the moment
when the system's credibility is being judged.

### 10.2 Options, measured

| Mechanism | Worst-case grant latency | New components on the Mac | Inbound port | Behaviour when the server is down |
|---|---|---|---|---|
| 60 s fixed poll | 60 s | none | no | unchanged |
| **Adaptive poll (60 / 15 / 5 s)** | **~5 s while a parent is watching** | **none** | **no** | **unchanged** |
| Outbound long-poll or SSE | ~1 s | held connection, reconnect logic, ingress idle-timeout tuning | no | a second network failure path to reason about |
| True server push | ~1 s | HTTP listener, stable address/DNS, firewall rule, TLS server cert on the Mac | **yes** | server must track reachability |

### 10.3 Verdict: H2 survives

**Polling wins. Do not build push.** Four reasons:

1. **The latency that matters is bounded by a human, not by the protocol.** From "child asks" to
   "parent grants" is 30 seconds at best and usually minutes. Shaving the last 5 seconds off a
   3-minute interaction is not a requirement; it is a rounding error.
2. **Adaptive cadence gets 95 % of push's benefit for 0 % of its cost.** `boundary` mode (15 s within
   15 minutes of any transition) and `attended` mode (5 s for 10 minutes after a parent opens the
   device in the UI — a server-side sticky flag reflected in `next_poll_after_ms`) put the fast
   polling exactly where the human is. Cost: ~120 extra requests per parent session, on a LAN.
3. **Push inverts the dependency that hard requirement 1 exists to protect.** A push channel makes the
   server responsible for reachability and gives the Mac an inbound listening surface on the one
   machine least suited to having one. Polling's failure mode is "the agent keeps doing what it was
   told"; push's failure mode is "the server thinks it delivered".
4. **Apple's own prior art argues for polling.** MDM does not push *content*: APNs sends a
   content-free wake-up containing only a `PushMagic` string, and the device then *polls* the MDM
   server for the queued command. The push exists solely to wake a sleeping device. **Our agent is
   already awake every 60 seconds**, so we already have the thing APNs exists to provide. Pushing
   would be building APNs to solve a problem we do not have.

### 10.4 The upgrade path, if ever needed, is additive

Add `GET /api/agent/v1/wait?etag=…` — a long-poll that holds for up to 50 s and returns early when
policy changes or a command is queued. Agents opt in by advertising `sync.longpoll`; the server offers
it only to those agents (R4). **No existing endpoint changes, no contract break, no inbound port.**
Recorded here so the decision is reversible, not so it is deferred.

### 10.5 A product answer that removes most of the complaint

The warning modal itself should carry an **"Ask for more time"** button. It writes a
`request.extension` audit event, the parent's phone buzzes, the parent taps Grant, and the next tick
— already in `boundary` mode at 15 s, and in `attended` mode at 5 s once the parent opens the UI —
applies it. The perceived latency is dominated by the parent's thumb, not by the poll interval.

---

## 11. Failure matrix

One row per link or component failure. "Enforcement" means: does bedtime still happen correctly?

| # | Failure | Enforcement still works? | Telemetry? | What the parent sees | Recovery |
|---|---|---|---|---|---|
| 1 | k3s cluster down / API unreachable | ✅ **Yes** — cached policy, unchanged | ⏸ Queued on disk (29 days' headroom) | `UNEXPECTED_SILENCE` after 10 min inside an expected-online window; notifies at 60 min; `SILENT_TOO_LONG` at 36 h. The banner states that enforcement continues | Automatic on next successful tick; queue drains in ~4 ticks |
| 2 | Home LAN / Wi-Fi down at the Mac | ✅ Yes | ⏸ Queued | Same as #1 | Automatic |
| 3 | Postgres down, Hono API up | ✅ Yes | ⏸ Queued; agent gets 5xx → backoff | `UNEXPECTED_SILENCE`; the API health alert fires from the existing stack | Automatic |
| 4 | Ingress TLS cert expired | ✅ Yes | ⏸ Queued; agent logs `tls_error` (distinct from network error) | `UNEXPECTED_SILENCE` + a distinguishable `tls_error` reason on the health card | Renew cert; automatic thereafter |
| 5 | `com.hpc.sync` daemon dead | ✅ **Yes — proof case (f)** | ❌ Stops; spool grows on disk | `UNEXPECTED_SILENCE` — the Mac is inside an expected-online window and sent no `agent.stopping` | `launchd KeepAlive` restarts; spool is ingested on start |
| 6 | `com.hpc.enforcer` daemon dead | ❌ **No** (deadfall still locks at the last known bedtime) | ✅ Yes — sync daemon keeps reporting | **`DEGRADED`, red, immediate** — the sync daemon reports `enforcer_heartbeat_missing` | `KeepAlive` restarts it; the sync daemon's report is what makes this visible rather than silent |
| 7 | Both daemons dead / agent uninstalled | ⚠️ Deadfall only | ❌ None | `UNEXPECTED_SILENCE` at 10 min inside an expected-online window, notified at 60 min; `SILENT_TOO_LONG` at 36 h | Manual reinstall; the alert is what makes it noticed |
| 8 | Cached policy corrupt / bad signature | ✅ Yes, from `policy.lkg.json` | ✅ Yes | `DEGRADED` banner: "running on last-known-good rules" | Next policy fetch overwrites `current`; LKG updated after a clean parse |
| 9 | `current` **and** `lkg` both unreadable | ❌ **No — fail-open** (§8.2) | ✅ Yes, if sync is alive | **`DEGRADED`, red, immediate**: "Lucy's Mac is not enforcing — its rules are unreadable" | Next successful `/sync` or `GET /policy` restores it, typically within 60 s |
| 10 | Never enrolled / no policy has ever existed | ❌ No — fail-open | ❌ None | `UNENROLLED` from the moment the device row is created | `sudo hpc-agent enroll --code …` |
| 11 | Credential revoked (401) | ✅ **Yes** — keeps enforcing cached policy | ❌ Rejected | `REVOKED` — intentional, shown as an admin state not an error | Re-enrol with a fresh code |
| 12 | Device decommissioned (410) | 🛑 **Stops, by design** — the only such path | 🛑 Stops | `DECOMMISSIONED` | Deliberate; re-enrol to reverse |
| 13 | Mac powered off or asleep during the restricted window | n/a — nothing to enforce; wall-clock semantics mean nothing is banked | ⏸ Queued until wake | `EXPECTED_OFFLINE` (via `agent.stopping` or the `expected_online` window). Never alerts — until 36 h, when `SILENT_TOO_LONG` fires regardless | n/a |
| 14 | Disk full on the Mac | ✅ Yes — spool write failure is non-fatal and occurs *after* the decision | ⚠️ Degraded; eviction runs; `queue.evicted` recorded | `DEGRADED` with `disk_full` | Sync daemon refuses to grow the queue below 1 GiB free |
| 15 | Queue exceeds its caps | ✅ Yes | ⚠️ Oldest `sample` events dropped; `audit` preserved | Reports show an explicit gap, sourced from the `queue.evicted` event | Automatic; the gap is recorded, not hidden |
| 16 | Duplicate delivery after a lost response | ✅ Yes | ✅ Exactly-once effect via `UNIQUE(device_id, event_id)` | Nothing — invisible by design | Automatic |
| 17 | System clock stepped backwards | ✅ **Yes** — monotonic projection is used while the clock is untrusted | ✅ Yes + `clock.stepped` audit event | `DEGRADED` with `clock_untrusted`, showing old → new | Next successful sync re-anchors on `server_time` |
| 18 | Timezone changed on the Mac | ✅ **Yes** — `policy.timezone` wins; the system timezone is not an input | ✅ Yes + tripwire | Tripwire on the health card | None needed; it is a report, not a fault |
| 19 | DST transition | ✅ Yes — a window predicate has nothing to skip or repeat (§8.4.1) | ✅ Yes | Nothing | n/a |
| 20 | Stale `tzdata` on the Mac | ⚠️ Correct unless a zone's rules changed since that tzdata release | ✅ Yes | `tzdata_version` on the health card | macOS software update |
| 21 | Bad policy pushed — agent cannot parse it | ✅ Yes — rejected, `lkg` retained | ✅ Yes + `policy.rejected` | `DEGRADED`: "the new rules were rejected by Lucy's Mac" | Fix and re-publish; the agent never applied it |
| 22 | Bad policy pushed — parses, but wrong (bedtime set to 19:00 by mistake) | ⚠️ **Enforces the mistake** — unless it takes effect within 15 min, in which case `confirm_immediate_effect` must be `true` | ✅ Yes | UI confirmation dialog beforehand; audit trail of `granted_by` afterwards | Publish a corrected policy; effective within one tick (≤15 s in `boundary` mode) — **but only under `action: "lock"`.** See row 32 |
| 23 | Agent too old for a new policy field | ✅ Yes — unknown fields ignored (R1), unknown enums degrade (R5) | ✅ Yes | `policy_degraded` note naming the field and the agent version | Update the agent (T3) |
| 24 | Server too old for a new event type | ✅ Yes | ✅ Yes — stored verbatim in JSONB (R8) | Nothing; a `unknown_event_type` metric increments | Write the projection later; **no data was lost** |
| 25 | Enforcement action itself fails (lock/`osascript` returns non-zero) | ⚠️ Attempted, failed | ✅ Yes + `enforcement.action_failed` audit event | **`DEGRADED`, red, immediate** | Agent retries next tick with escalation (lock → logout → shutdown per policy) |
| 26 | Clock: network time disabled on the Mac | ✅ Yes (skew detection still runs against `server_time`) | ✅ Yes + tripwire | Tripwire on the health card | Re-enable; agent reports it |
| 27 | ⚠️ `launchd` does not deliver `SIGTERM` on full system shutdown (T6 open question) | ✅ Yes — unaffected | ✅ Yes | A clean shutdown is misread as a crash ⇒ `UNEXPECTED_SILENCE` instead of `EXPECTED_OFFLINE` ⇒ a false amber at every bedtime | **The `clean_exit` flag is the fix**: written to disk *before* stopping, reported on the next boot as `clean_exit_previous_run`, so the previous shutdown is reclassified retrospectively. If `SIGTERM` is genuinely never delivered, the flag cannot be written either — fall back entirely to `expected_online` windows, and accept that a nightly shutdown at 21:45 outside the window is `EXPECTED_OFFLINE` anyway. **See V7.** |
| 28 | Hard power loss / power cut / held power button | ✅ Yes on next boot; nothing enforced while off (nothing is banked — wall-clock semantics) | ⏸ Queued; in-flight spool lines may be lost (last ≤60 s) | `UNEXPECTED_SILENCE` if inside a window — **correct**, a power cut is worth knowing about | Automatic on boot; `agent.started` carries `clean_exit_previous_run: false` so the gap is attributed, not guessed |
| 29 | Backlog replayed to Loki after an outage > 1 h | ✅ Yes | ⚠️ **Loki silently drops the old lines**; Postgres is unaffected | Logs show a hole; reports do not, because reports read Postgres | §7.5 — events are Postgres-authoritative; replayed log lines are re-stamped with `original_ts` or skipped |
| 30 | Family away / school holiday — Mac legitimately off for days | ✅ Yes on next boot | ⏸ Queued | **`SILENT_TOO_LONG` fires benignly at 36 h.** Fires again next holiday, and then the parent mutes the channel | ⚠️ **Unsolved — §9.6.** Proposed `devices.away_until` handed back to T6 |
| 31 | Agent deliberately stopped (`launchctl bootout`) while the Mac stays up | ❌ No — deadfall only | ❌ None | `UNEXPECTED_SILENCE`; on next contact the `system_boot_time` gap analysis (§9.7) reads it as "the Mac was up and the agent was not" | `launchctl bootstrap`; the tripwire is retained in history whether or not anyone acts on it |
| 32 | Bad policy pushed **while `action: "shutdown"`** | ⚠️ Enforces the mistake, then the Mac is **off** | ❌ Stops when the Mac does | `EXPECTED_OFFLINE` — indistinguishable from a normal bedtime | ⚠️ **No remote path exists.** Only `action_options.shutdown_grace_s` (§8.5): a corrected policy landing inside the 5-minute grace cancels the shutdown. Otherwise, physically switch the Mac on |

**Recovery cost is not uniform — it is a function of the enforcement action (T7).** Every "recovery"
cell above assumes `action: "lock"`, under which the Mac stays reachable and a corrected policy lands
within one tick. Under `action: "shutdown"` the recovery column collapses for rows 21, 22, 25 and 32
to "physically switch the machine on", because nothing can be pushed to a powered-off host. That is
§8.5's argument in tabular form, and it is the strongest single reason for `lock` as the default.

---

## 12. Decisions register

| # | Decision | Rationale |
|---|---|---|
| T4-D1 | One tick request: `POST /sync` carries status + policy ETag, **and is itself the heartbeat**. Telemetry is on a separate endpoint | osquery-proven conditional-config pattern; T6's separation keeps the liveness signal off the bulk data path |
| T4-D2 | ETag in the request body, not `If-None-Match` | The tick is a POST because it carries telemetry; `GET /policy` keeps proper conditional semantics for cold start and for humans |
| T4-D3 | Two LaunchDaemons: `enforcer` (no socket) + `sync` (all I/O) | Makes hard requirement 1 structural rather than a code-quality promise |
| T4-D4 | Optional third `deadfall` launchd job at the last-known bedtime | Closes the "agent is entirely dead" hole that fail-open otherwise leaves open |
| T4-D5 | Policy is full-state, signed as a compact JWS (EdDSA/Ed25519) | Verify bytes then parse — no JSON canonicalisation problem; declarative, so no partial-apply state |
| T4-D6 | Grants live in `policy.overrides[]` | State, not action. Kills an entire class of ordering and replay bugs |
| T4-D7 | **Every relaxation carries a mandatory `expires_at`** | The single rule that makes "stale policy applies forever" safe by construction |
| T4-D8 | Per-event idempotency key (`event_id`, UUIDv7), not per-request | Handles partial batch acceptance, which request-level keys cannot express |
| T4-D9 | Two-class queue eviction (`audit` last) + a synthetic `queue.evicted` event | The record stays honest about its own gaps |
| T4-D10 | One durable device-scoped bearer credential via better-auth API-key plugin | Reuses hashing, expiry, metadata, permissions, rate limiting. No token-exchange tier in v1 |
| T4-D11 | Remote credential rotation as overlapped **desired state** | Turns "rotate the credential" from a physical errand into a background non-event |
| T4-D12 | `policy.timezone` (IANA) wins over the system timezone | Changing the Mac's timezone must not move bedtime; the mismatch becomes a tripwire |
| T4-D13 | Window predicate evaluated every tick, never a one-shot trigger | Immunises the whole system against DST skip/repeat bugs |
| T4-D14 | `mach_continuous_time()` for the monotonic clock | `mach_absolute_time()` stops during sleep and would false-positive every morning |
| T4-D15 | Liveness = T6's five-state machine, computed control-plane-side once a minute, emitting an `agent_status` record per device | Presence-based alerting; absence-based queries silently degrade to "No Data". Adopted, not re-designed |
| T4-D16 | Adaptive cadence (60/15/5 s) instead of any push channel | 95 % of push's benefit, 0 % of its cost, no inbound port |
| T4-D17 | `confirm_immediate_effect` required for any policy taking effect within 15 min | T3.5 blast-radius guard; a fat-fingered edit cannot ruin an evening |
| T4-D18 | The protocol has **no** "stop enforcing" verb; `410` decommission is the sole exception | The invariant on which hard requirement 1 rests |
| T4-D19 | Telemetry on `POST /events`, never on the tick; `audit` events flush immediately, `sample` events every 5 min | A 413/429/slow/poisoned batch must never make a live agent look silent (T6) |
| T4-D20 | `agent.started` / `agent.stopping{reason}` + a persisted `clean_exit` flag | The flag survives the case where the `stopping` event is generated but never delivered (T6) |
| T4-D21 | **No ICMP/TCP probe of the Mac, ever** | A Bonjour Sleep Proxy answers ARP for a sleeping Mac (the probe lies), and Wake-for-network-access means a probe can wake the machine at 03:00 (T6) |
| T4-D22 | Telemetry events are Postgres-authoritative with an agent-supplied `ts`; Loki gets live lines only | Loki drops out-of-order lines beyond `max_chunk_age/2` (1 h default) **silently**, which would destroy exactly the outage data the parent wants (T6) |
| T4-D23 | Device lifecycle (`UNENROLLED`/`ACTIVE`/`REVOKED`/`DECOMMISSIONED`) is a separate axis from the five health states | A revoked device is still alive and still enforcing; one axis cannot say that |
| T4-D24 | **No command channel at all.** The server publishes desired state; the agent reconciles every tick and reports convergence | A missed command is lost; a missed desired state is self-healing. Matches Argo CD, which the owner already runs (T7) |
| T4-D25 | `action: "shutdown"` means lock-then-shutdown after `shutdown_grace_s` (default 300 s) | A shutdown destroys every remote recovery path; the grace window is the only budget a mistaken policy gets (T7) |
| T4-D26 | The policy schema **cannot express** disabling Remote Login, changing admin accounts, `sudoers` or FileVault | An invariant enforced by the schema rather than by discipline. No bug can lock the parent out (T7) |
| T4-D27 | `app.usage_sample` carries `active_s` and `cpu_pct_avg` alongside `foreground_s`; **`active_s` is the meter** | An idle app left open must not burn a budget (T7). Matters for D.4 |
| T4-D28 | `device.system_boot_time` on every tick, for retrospective gap analysis | Separates "the Mac was off" from "the Mac was up and the agent was not" with no network probe (§9.7) |

---

## 13. Open questions and things to verify

| # | Item | Blocks |
|---|---|---|
| ⚠️ V1 | Run the nine-case enforcement-isolation matrix (§3.1) on the M4 | The central claim of this document |
| ⚠️ V2 | Confirm `NSWorkspaceWillSleepNotification` is deliverable to a root LaunchDaemon on macOS 26, and that a synchronous beacon POST completes before sleep | §9.2 leg 1; if not, fall back to legs 2 and 3 only |
| ⚠️ V3 | Confirm `systemsetup -getusingnetworktime` works from a daemon on macOS 26 without Full Disk Access | §8.4.3 leg 3 (a tripwire only) |
| ⚠️ V4 | Confirm `launchd StartCalendarInterval` behaviour on wake-from-sleep for the deadfall, and that reloading its plist from another daemon is clean | §8.1 |
| ⚠️ V5 | Confirm better-auth's API-key plugin supports the scoping shape in §6.4 against the sibling app's version | §6 |
| ⚠️ V6 | Decide the contract package's language artefact (TS package vs JSON Schema emitted in CI) | Depends on T2.1 (agent language) |
| ⚠️ V7 | **(T6's question, inherited)** Does `launchd` reliably deliver `SIGTERM` on a full system shutdown, or only on `launchctl bootout`? | Matrix row 27. Determines whether `EXPECTED_OFFLINE` can ever be asserted at shutdown, or only inferred from `expected_online` windows |
| ⚠️ V8 | **Handed back to T6:** `devices.away_until` to suppress `SILENT_TOO_LONG` during holidays and travel | §9.6, matrix row 30. Without it the 36-hour alert fires benignly and gets muted |
| O.1 | **Answered here** — fail-open on ignorance, fail-closed on knowledge, `fail_mode` overridable per device | — |
| O.2 | Does "from my end" ever mean away from home? | If yes: revisit §6.4 (add a token tier) and §6.9 (mTLS) |
| D.1 | Monitoring depth | Unblocked by R4 + R8 — addable without a contract change |
| D.3 | Lock vs shutdown | Already a policy field (`action`); no contract impact |
| ⚠️ V9 | Re-verify V2–V4 and V7 on **macOS 27** (shipped 2026-09-14) as well as macOS 26 | See the version note below |
| D.4 | Bedtime window vs daily budget | ⚠️ **Some contract impact.** `schedule.kind` is discriminated (`"windows"` today) so a `"budget"` kind is additive — but a budget needs *elapsed* accounting, which is a genuinely different agent-side state machine and a new event type. The contract accommodates it; the agent work is real |

### 13.1 OS version sensitivity

The brief specifies **macOS 26** on the target. **macOS 27 shipped on 2026-09-14**, so the agent must
not assume a version — it reports `device.os_version` on every tick precisely so that a
version-dependent behaviour change is attributable rather than mysterious. Nothing in the *contract*
is version-sensitive: the endpoints, payloads, auth and failure semantics are plain HTTP and JSON.
The version-sensitive assumptions are all agent-side, and each is already flagged:

| Assumption | Stated for | Re-verify on |
|---|---|---|
| `mach_continuous_time()` advances during sleep; `mach_absolute_time()` does not (§8.4.3) | Stable Darwin API since 10.12 | low risk, but assert in a unit test |
| `NSWorkspaceWillSleepNotification` reaches a root LaunchDaemon (§9.2, V2) | macOS 26 | **macOS 27** |
| `launchd` delivers `SIGTERM` on full system shutdown (§9.2, V7, matrix row 27) | unknown on both | **macOS 26 and 27** |
| `authorizationdb` right is `system.settings.datetime` (was `system.preferences.datetime`) (§8.4.3) | renamed at Sequoia | **macOS 26 and 27** |
| `systemsetup -getusingnetworktime` works from a daemon without Full Disk Access (§8.4.3, V3) | macOS 26 | **macOS 27** |
| `launchd StartCalendarInterval` behaviour on wake-from-sleep, for the deadfall (§8.1, V4) | macOS 26 | **macOS 27** |
| System keychain is awkward from a daemon ⇒ use a 0600 file (§6.7) | long-standing | low risk |

None of these can break the contract. All of them can break a *tripwire* or a *liveness
classification*, which is why each has a named fallback rather than an assumption.

---

## 14. Cross-track consistency with T6 (observability) and T7 (prior art)

T6 completed before this track and had already designed the heartbeat. This section records exactly
what T4 adopted, what T4 changed in its own design as a result, what T4 layered on top, and the one
point handed back — so that a future reader can see where the seam is rather than guessing.

**Headline: I have no disagreement with T6's design.** The telemetry/tick separation in particular
*improved* this contract and I adopted it. What follows is one substantive clarification, two
additions, and one gap.

### 14.1 Adopted from T6, unchanged

| T6 design point | Where it lands in T4 |
|---|---|
| The policy tick **is** the heartbeat; no separate heartbeat endpoint | §4.1, §9.2, V5, T4-D1 |
| Telemetry/log batches POST to an endpoint **separate** from the tick | §4.4, §2, T4-D19 |
| `agent.started` and `agent.stopping { reason }` events | §4.4, §9.2 |
| A persisted local `clean_exit` flag so a clean stop is distinguishable from a crash | §9.2, request field `agent.clean_exit_previous_run` (§4.1), matrix rows 27–28 |
| Five states computed **control-plane-side** once a minute, emitting an `agent_status` record | §9.3, T4-D15 |
| Presence-based alerting, because LogQL returns no series (not `0`) and degrades into "No Data" | §9.3 |
| Thresholds: **10 minutes** unexplained silence, **36 hours** regardless | §9.3 |
| **No ICMP/TCP probe** — Bonjour Sleep Proxy answers ARP for sleeping Macs; Wake-for-network-access can wake the machine at 03:00 | §9.2, T4-D21 |
| Loki drops out-of-order lines beyond `max_chunk_age/2` (1 h default), silently | §7.5, T4-D22, matrix row 29 |
| "Clean shutdown vs crash is not reliably distinguishable" is a case the matrix must handle | matrix rows 27–28, V7 |

### 14.2 What changed in T4's own design as a result

| Was (T4 first draft) | Now | Why |
|---|---|---|
| `POST /sync` carried up to 500 telemetry events inline; `/events` was a bulk-drain overflow endpoint | `/sync` carries **no** events; `/events` is **the** telemetry endpoint, with `audit` flushing immediately and `sample` every 5 min | T6's separation. A 413, a 429, a 20-second upload or one poisoned event could otherwise fail the tick and turn a live, enforcing agent into an apparently silent one |
| Nine health states of my own (`HEALTHY`/`LAGGING`/`ASLEEP`/`SILENT`/`UNHEALTHY`/`DEGRADED` + admin) | T6's five, plus a **separate** lifecycle axis (§9.4) | One state machine, owned by one track |
| Thresholds 3 min / 15 min / 60 min | T6's 10 min / 36 h | T6 owns this |
| `agent.going_offline` | `agent.stopping { reason }` + `clean_exit` flag | T6's naming, and the flag is strictly better — it survives non-delivery of the event |
| Liveness evaluated via an `alert_due_at` deadline row | A once-a-minute scan emitting `agent_status` per device | Presence-based. At N ≤ 5 devices the deadline-row index buys nothing, so the simpler design wins outright |

### 14.3 ⚠️ One substantive clarification T6 should confirm

T6 says telemetry batches move off the tick. **The per-tick *status summary* must not move with
them.** `policy_state`, `enforcement`, `clock` and `queue` (§4.1) are heartbeat content, not
telemetry: they are ~1 KB, they change every tick, and **`DEGRADED` is computed from them**.

If those fields were to travel on the telemetry endpoint instead, then during exactly the situation
where telemetry is backed up or being rejected — an outage, a poisoned batch, a full disk — the
control plane would lose its ability to compute `DEGRADED`, and a device reporting "I cannot read my
policy" would be indistinguishable from a healthy one. The most important health signal would be
carried on the least reliable channel.

So the split is: **status on the tick, events on `/events`.** I believe this is what T6 intended;
flagging it because "telemetry goes elsewhere" could reasonably be read as including the status
block, and the consequence of that reading is silent.

### 14.4 ⚠️ One gap handed back to T6

`SILENT_TOO_LONG` at 36 hours has no "the parent already knows" exemption, so it fires benignly every
school holiday, every weekend away, and every repair-shop visit — and a benignly-firing alert gets
muted, which returns the dead-man's switch to being decorative. Proposed fix and its constraints are
in §9.6 and matrix row 30: a `devices.away_until` field that forces `EXPECTED_OFFLINE`, explicitly
**not** expressed as a policy override, because an away device must still enforce bedtime the moment
it is switched on.

### 14.5 Two [T4 additions] on top of T6's states

1. **A notification threshold distinct from the state threshold** (§9.3). Enter
   `UNEXPECTED_SILENCE` at T6's 10 minutes; notify the parent at 60. A macOS software-update restart
   can exceed 10 minutes, and an amber state a parent can see is not the same event as a phone
   buzzing. T6's state machine is untouched.
2. **Do not arm at the start of a window** (§9.3). Require one `HEALTHY` observation inside the
   current `expected_online` window before `UNEXPECTED_SILENCE` can be entered, or every late start
   produces a 07:00 amber.

### 14.6 T7 (prior art) — what was adopted

| T7 finding | Verdict | Where |
|---|---|---|
| **Desired-state reconciliation rather than RPC**, per `mac-screentime-enforcer`; a missed message self-heals; matches the owner's Argo CD | **Adopted in full, and pushed further than my first draft.** The command channel is **deleted**, not merely supplemented | V8, §4.6, T4-D24 |
| Heartbeat as a tamper signal, not only a liveness signal — but do not over-weight, per AR.1 | **Adopted, deliberately under-weighted.** Recorded as a health-card tripwire, never a notification; the broken-vs-powered-off distinction is served first | §9.7, T4-D28 |
| `shutdown` destroys every remote recovery path; the agent must never disable Remote Login or lock out the parent's admin account | **Adopted as two hard rules**: lock-then-shutdown with a grace window, and a schema that cannot express account or Remote Login changes | §8.5, T4-D25, T4-D26, matrix rows 22/32 and the note beneath the matrix |
| Time accounting should gate on CPU/activity, not process existence | **Adopted.** `active_s` and `cpu_pct_avg` join `foreground_s` on the wire now; `active_s` is the meter a budget must use | §4.4, T4-D27 |
| macOS 27 shipped 2026-09-14 — state any OS version assumed | **Adopted.** All version-sensitive assumptions tabulated with a re-verify target | §13.1, V9 |

**What changed in T4's own design as a result of T7:** the command channel existed in the first
draft with five verbs. Two of them (`force_policy_refetch`, `set_log_level`) turned out to be RPC
dressing over things reconciliation makes unnecessary or configuration already covers, and the
remaining three re-expressed cleanly as desired state with convergence observed rather than acked.
The retry counters, ack bookkeeping and `expires_at` handling went with them. **The contract got
smaller, which is the usual sign that a framing was right.**

---

## 15. Sources

Cross-track (internal)
- **T6 — observability**: the five-state liveness machine, presence-based alerting, the `clean_exit`
  flag, the no-probe rule and Loki's out-of-order window. Adopted in §9 and §7.5; reconciled in §14.
- **T7 — prior art**: desired-state reconciliation (`mac-screentime-enforcer`), heartbeat as tamper
  signal, the `shutdown` recovery constraint, and activity-gated time accounting. Adopted in §4.6,
  §8.5 and §9.7; reconciled in §14.6.

Protocol and HTTP semantics
- [RFC 9110 — HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110.html) (conditional requests, `ETag`/`If-None-Match`, `304`, `Retry-After`, `Date`)
- [RFC 9111 — HTTP Caching](https://www.rfc-editor.org/rfc/rfc9111.html)
- [RFC 9457 — Problem Details for HTTP APIs](https://www.rfc-editor.org/rfc/rfc9457.html)
- [draft-ietf-httpapi-idempotency-key-header-07](https://www.ietf.org/archive/id/draft-ietf-httpapi-idempotency-key-header-07.html) (Oct 2025) and its [working-group repo](https://github.com/ietf-wg-httpapi/idempotency)
- [RFC 9562 — UUID (v7, time-ordered)](https://www.rfc-editor.org/rfc/rfc9562.html)
- [RFC 7515 — JSON Web Signature](https://www.rfc-editor.org/rfc/rfc7515.html) · [RFC 8037 — CFRG EdDSA in JOSE](https://www.rfc-editor.org/rfc/rfc8037.html) · [RFC 8785 — JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785.html) (considered, not used)

Prior art — agent check-in and conditional config
- [osquery PR #9033 — "Etag config TLS"](https://github.com/osquery/osquery/pull/9033) and [issue #9056 — conditional TLS config requests](https://github.com/osquery/osquery/issues/9056) — ETag in the POST body, `{"etag":"ok"}` unchanged response, >99 % traffic reduction
- [fleetdm/fleet issue #50157 — reduce `/api/v1/osquery/config` traffic with ETag / 304-style conditional requests](https://github.com/fleetdm/fleet/issues/50157)
- [Fleet — Apple Push Notification Service: How APNs works in MDM](https://fleetdm.com/articles/apple-push-notification-service-apns-mdm) — the push carries only `PushMagic`; the device then polls
- [Omnissa — A primer on Declarative Device Management for Apple devices](https://techzone.omnissa.com/resource/primer-declarative-device-management-apple-devices) — declarative full-state, device reconciles locally, reports on change

Resilience, queuing and retries
- [OpenTelemetry — Collector resiliency](https://opentelemetry.io/docs/collector/resiliency/) and [persistent disk-backed queues](https://oneuptime.com/blog/post/2026-02-06-persistent-disk-queues-otel-crash-recovery/view) — WAL on disk, delete only after confirmed delivery
- [AWS — Retry behavior (SDKs and Tools)](https://docs.aws.amazon.com/sdkref/latest/guide/feature-retry-behavior.html) and Marc Brooker, *Exponential Backoff and Jitter* — full jitter
- [Schema evolution / tolerant reader](https://medium.com/@lasse.work/between-app-and-api-making-apps-more-resilient-with-the-tolerant-reader-pattern-d376f9ff3041) · [Schema evolution without breaking consumers](https://dev.to/alexmercedcoder/schema-evolution-without-breaking-consumers-50a9)

Authentication
- [Better Auth — API Key plugin](https://better-auth.com/docs/plugins/api-key) (hashed storage, expiry, metadata, `permissions`, rate limiting) · [Bearer plugin](https://better-auth.com/docs/plugins/bearer) · [Device Authorization plugin](https://better-auth.com/docs/plugins/device-authorization) (RFC 8628 — considered and rejected: binds a *user*, not a *device*)
- [RFC 6750 — Bearer Token Usage](https://www.rfc-editor.org/rfc/rfc6750.html) · [RFC 8628 — OAuth 2.0 Device Authorization Grant](https://www.rfc-editor.org/rfc/rfc8628.html)
- [Foundries.io — Secure IoT device identity and lifecycle management](https://www.foundries.io/insights/blog/iot-device-identity-lifecycle-management/) · [IoT device identity and certificates](https://nhimg.org/community/nhi-best-practices/iot-device-identity-and-certificates-what-iam-teams-need-to-know/) (EST for renewal, SCEP for provisioning — the mTLS upgrade path)
- [Apple Developer Forums — "Secure secret storage in launch daemons via Keychain?"](https://developer.apple.com/forums/thread/725855) and ["System keychain not available from a daemon"](https://developer.apple.com/forums/thread/759976)

Failure semantics
- Saltzer & Schroeder, *The Protection of Information in Computer Systems* (1975) — fail-safe defaults; the failure-behaviour argument for default-deny
- [AuthZed — Understanding "failed open" and "fail closed" in software engineering](https://authzed.com/blog/fail-open)
- [ITU Online — Fail-safe defaults: implementing resilient security strategies](https://www.ituonline.com/comptia-securityx/comptia-securityx-4/mitigations-implementing-fail-secure-and-fail-safe-strategies-for-robust-security/) — fail-closed without a recovery path produces permanent bypasses

Time
- [Apple — `mach_continuous_time`](https://developer.apple.com/documentation/kernel/1646199-mach_continuous_time) (advances during sleep) vs [`mach_absolute_time`](https://developer.apple.com/documentation/kernel/1462446-mach_absolute_time) (does not)
- [Cron and timezones: UTC, local time and DST pitfalls](https://cronbase.dev/guides/cron-timezone-guide) · [Your nightly job ran twice on the DST switch](https://dev.to/libme/your-nightly-job-ran-twice-on-the-dst-switch-making-scheduled-jobs-timezone-safe-32hn) — store the IANA zone name, never an offset; never precompute trigger instants
- [Jamf community — allowing standard users to change date and time (`authorizationdb`, `system.preferences.datetime` → `system.settings.datetime`)](https://community.jamf.com/general-discussions-2/allow-standard-users-to-change-date-and-time-on-sequoia-34929)

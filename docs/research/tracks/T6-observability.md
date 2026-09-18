# T6 — Observability

**Track:** T6 of POC 2 · **Date:** 2026-09-18 · **Method:** 🌐 web research + ✏️ design
**Status:** research and design complete. ⚠️ **No cluster access during this round** — every
claim about the *owner's existing* Loki/Grafana/Alloy install is an assumption, listed in §9.

---

## 0. Verdict first

> **Ship nothing new to the child's Mac.** The agent writes structured JSON lines, POSTs
> them in batches to its own control plane on the connection it already has, and the
> **control plane** — a k3s pod, already observable, already holding the Loki credentials —
> forwards them to Loki. No Alloy, no Promtail, no Vector, no syslog on the mini.
>
> **Health is not "did we hear from it" — it is "did it tell us it was going quiet."** The
> agent declares its own lifecycle (`started` / `heartbeat` / `stopping{reason}`) and
> persists a `clean_exit` flag across restarts. The control plane turns that into a
> four-state `agent_status` and emits it continuously. Silence after a clean stop is
> **expected**; silence after an unclean one is an **alert**. That single distinction is
> the whole answer to T6.2.
>
> **No Prometheus for the agent.** One agent. Everything worth measuring is already in the
> heartbeat line. Adding a metrics pipeline here is enterprise cargo cult.
>
> **Alloy does run on macOS** — officially, with a Homebrew formula and a launchd service
> (verified below). It is still the wrong choice here, and the reason is specific: *Alloy
> has no macOS log source*. There is no darwin equivalent of `loki.source.journal`. Alloy
> on the mini would tail a file the agent already wrote and forward it over a network path
> the agent already has. It adds a hop, not a capability.

---

## 1. T6.1 — Getting agent logs into the existing Loki

### 1.1 Does Grafana Alloy run on macOS? — **Yes. Verified.**

| Question | Answer | Evidence |
|---|---|---|
| Official darwin/arm64 support? | **Yes** — macOS 10.13+, AMD64 (Intel) *and* ARM64 (Apple Silicon) | [Supported platforms](https://grafana.com/docs/alloy/latest/introduction/supported-platforms/) |
| Official release binary? | **Yes** — `alloy-darwin-arm64.zip` ships in every release. Checked v1.19.2 (2026-08-26) | [releases/latest](https://github.com/grafana/alloy/releases/latest) |
| Homebrew formula? | **Yes** — `brew tap grafana/grafana && brew install grafana/grafana/alloy`. Also in homebrew-core as `grafana-alloy` | [Install on macOS](https://grafana.com/docs/alloy/latest/set-up/install/macos/) · [formulae.brew.sh](https://formulae.brew.sh/formula/grafana-alloy) |
| Supported service mode? | **Yes** — installed as a **launchd** service, managed via `brew services start/stop/restart grafana/grafana/alloy` | [Run on macOS](https://grafana.com/docs/alloy/latest/set-up/run/macos/) |
| `.pkg` / `.dmg` installer? | **No.** Zip of a bare binary, or Homebrew. (Windows gets an `.exe` installer; macOS does not.) | release asset list, above |
| First-class or best-effort? | **Ambiguous — see below** | — |

**Support tier is genuinely unstated.** The supported-platforms page lists macOS in the same
table as Linux and Windows with no tier language in either direction — it neither promises
first-class support nor warns that macOS is best-effort. Linux and FreeBSD rows carry a
lifecycle qualifier; macOS carries only "10.13+". Read that as *supported but not
exercised much*, and note the corroborating signals:

- **No `loki.source` component can read the macOS unified log.** Alloy ships
  `loki.source.journal` for systemd and `loki.source.windowsevent` for Windows. There is no
  darwin equivalent. On macOS, Alloy's only realistic log input is
  [`loki.source.file`](https://grafana.com/docs/alloy/latest/reference/components/loki/loki.source.file/)
  tailing a file someone else wrote. **This is the decisive fact for this track.**
- **[Issue #4008](https://github.com/grafana/alloy/issues/4008)** — `brew services start alloy`
  emits `Formula 'alloy-analyzer' has not implemented #plist, #service...`. Alloy starts
  anyway, so it is cosmetic, but it has been **open since 2025-07-17 and is still open**.
  Fourteen months on a one-line formula bug in the macOS install path is a reasonable proxy
  for how much traffic darwin gets.
- **Service customisation requires editing the Homebrew formula.** Per the
  [macOS configure page](https://grafana.com/docs/alloy/latest/configure/macos/): *"Due to
  limitations in Homebrew, customizing the service used by Alloy on macOS requires changing
  the Homebrew formula and reinstalling Alloy."* For a machine the owner cannot easily
  reach, "to change a flag, fork the formula and reinstall" is a bad operability story —
  and it collides directly with T3 (lifecycle and update path).
- **Ownership mismatch.** The agent is a **root LaunchDaemon**; `brew services` on Apple
  Silicon runs out of `/opt/homebrew` under the *invoking user*. Alloy-as-user reading a
  `root:root` log file is the exact permission trap reported in
  [alloy#2540](https://github.com/grafana/alloy/issues/2540). Solvable (mode 0644, or
  `sudo brew services`), but it is one more thing to get right remotely.

> **Documentation staleness flag.** The macOS run/configure pages never state which user the
> service runs as, and never mention Full Disk Access / TCC — which on macOS 26 is a live
> concern for anything reading system locations. That is a gap in Grafana's docs, not
> evidence that it works.

### 1.2 Is Promtail still an option? — **No. It is dead.**

Promtail reached **end-of-life on 2026-03-02** (it entered LTS in February 2025; commercial
support and updates have ended). Grafana's own guidance: *"If you are currently using
Promtail, you must migrate to Alloy or another supported client."*

- [Promtail EOL announcement — Grafana Community](https://community.grafana.com/t/promtail-end-of-life-eol-march-2026-how-to-migrate-to-grafana-alloy-for-existing-loki-server-deployments/159636)
- [Migrate to Alloy — Loki docs](https://grafana.com/docs/loki/latest/setup/migrate/migrate-to-alloy/)

Six months past EOL, on a machine that is hard to reach, running an unpatched log shipper as
a privileged daemon. Not a candidate. **Do not put Promtail on the mini.**

### 1.3 The alternatives, honestly

**Direct agent → Loki push API.** Technically fine. Loki's
[`POST /loki/api/v1/push`](https://grafana.com/docs/loki/latest/reference/loki-http-api/)
takes plain JSON — one HTTP call, no library needed:

```
{"streams":[{"stream":{"app":"homeparentcontrol","component":"agent","device":"mini-01"},
             "values":[["1758153600000000000","{\"event\":\"heartbeat\",...}",
                        {"boot_id":"...","agent_version":"1.4.2"}]]}]}
```

(The third array element is **structured metadata** — string→string, no nesting, must sit
immediately after the line. Timestamps must be **strings**, not numbers, or you get a 400.)

Four reasons not to:

1. **Loki credentials end up on the child's Mac.** The tenant ID / basic-auth pair for the
   whole observability stack, sitting on the least-controlled machine in the house. T3.3
   already flags that the Mac has no Sealed Secrets equivalent — this makes that problem
   worse for no benefit.
2. **Two dependencies instead of one.** The agent now needs the control plane *and* Loki
   reachable, with two URLs, two auth schemes, two retry policies, two failure modes.
3. **It couples the agent to the observability backend.** If Loki is ever replaced, or the
   ingress moves, or `auth_enabled` flips, **you must ship a new agent version to a machine
   you cannot reach** (T3.1/T3.2 — the hardest problem in this project). Via the control
   plane, the same change is a `kubectl rollout`. This is the decisive argument, and it is
   an *operability* argument, which is precisely the owner's "PRO" standard.
4. **Loki's ingestion constraints leak into the agent.** Out-of-order windows and
   `reject_old_samples` (see §1.6) become the agent's problem instead of the control
   plane's.

**Vector.** Runs on macOS/arm64, Homebrew-installable, genuinely good software. But it is a
*second* independent binary, config file, service, and update channel on the mini — every
objection to Alloy applies, plus it is not what the owner already runs. Consistency with the
existing stack is an explicit requirement (P3.1). No.

**syslog forwarding.** Apple deprecated ASL/`syslogd` in favour of unified logging years
ago; legacy `/etc/syslog.conf` remote forwarding is vestigial on modern macOS. The agent
*could* emit RFC5424 itself to an `loki.source.syslog` receiver in the cluster — but that
means a new listener in k3s, a bespoke wire format, structure squeezed into RFC5424
structured-data fields, and silent loss if UDP. It is strictly worse than POSTing JSON over
the HTTPS connection that already exists. No.

**Do nothing (status quo).** Local file, SSH to read. This is the thing the track exists to
kill. Named here only so the table is complete.

### 1.4 Comparison table

| Approach | Runs on the child's Mac? | Complexity | Failure mode | Fit |
|---|---|---|---|---|
| **Agent → control plane → Loki** ⭐ | **No** — reuses the agent's existing HTTP client | **Lowest.** One endpoint, one auth, one retry path. ~100 lines of control-plane forwarding code | CP unreachable → agent spools locally, replays on recovery. CP down is *already* alerted by the cluster's own observability. Agent hard-crash → dying breath lost, but the local file has it and absence-alerting catches it | **Best.** Zero new surface on the mini; backend swappable without touching the agent |
| Agent → Loki push API direct | No new process, but Loki creds + Loki-specific code live on the mini | Low-ish. Push format is trivial; auth/tenancy/out-of-order handling is not | Loki or its ingress down → agent must spool anyway. Auth change requires an **agent release to an unreachable machine** | Workable, worse. Couples agent to backend for no gain |
| **Grafana Alloy** on the mini | **Yes** — launchd service via Homebrew | Medium. Formula tap, `config.alloy`, brew-services lifecycle, a second update channel, formula edits to change flags | Alloy dies silently → logs stop, and *nothing watches Alloy*. Homebrew upgrade breaks it. User/root file permission mismatch | **Poor.** No darwin log source exists — it can only tail a file the agent already wrote. Adds a hop, not a capability |
| Vector on the mini | Yes — launchd service | Medium. Same shape as Alloy, plus VRL | Same as Alloy, and nobody in this house runs Vector | Poor. Capable, but inconsistent with the existing stack (P3.1) |
| Promtail on the mini | Yes | Medium | **EOL 2026-03-02.** Unpatched, unsupported | **Disqualified** |
| syslog → cluster receiver | Agent only, no extra process | Medium. New listener in k3s, RFC5424 encoding, UDP loss or TCP framing | Silent loss (UDP); structure degraded | Poor. Strictly worse than HTTP JSON |
| Status quo: local file + SSH | Yes (a file) | Zero | Parent never looks. Disk fills | The problem being solved |

### 1.5 How should the agent emit logs? — **structured JSON to stdout, captured by launchd**

**Recommendation:** one JSON object per line, written to **stdout**, captured by launchd's
`StandardOutPath` into `/var/log/homeparentcontrol/agent.log`. Separately and independently,
the same records go into a small **delivery spool** for shipping. Two concerns, two
mechanisms — the file is for a human on the box, the spool is for delivery.

**Do not build on `os_log` / unified logging.** Three reasons, one of them new:

1. **macOS 26 redacts dynamic strings by default.** Anything constructed at runtime — which
   is every log message worth having — renders as `<private>` unless each interpolation is
   annotated `%{public}s`. This is a *change in macOS 26*, confirmed in the wild:
   [CPython #150644](https://github.com/python/cpython/issues/150644) — *"All 'dynamic'
   strings ... appear in the system log as `<private>` ... this change renders Python system
   logging useless on macOS 26."* The system-wide workaround is a
   `private-logging.mobileconfig` profile, which is a blunt instrument that unredacts
   *everything on the machine*. **The target runs macOS 26.** This alone settles it.
2. **Getting data back out is awkward.** Either shell out to a long-lived
   `/usr/bin/log stream --style ndjson` subprocess and parse Apple's envelope (and supervise
   its restarts), or use `OSLogStore`, which is Swift/ObjC-only. Both are more machinery than
   "write a line to stdout".
3. **You cannot use it as a buffer.** Unified logging's retention for `.info`/`.debug` is
   aggressive and not under your control.

**Use `os_log` for exactly one thing:** a single `%{public}s`-annotated breadcrumb on
`agent.started` and `agent.stopping`. That costs ~2 lines and buys the one thing unified
logging is genuinely good at — being correlatable with `pmset -g log`, `log show`, and
system shutdown records **when the agent itself is gone**. Everything else goes to stdout.

**Why launchd `StandardOutPath` rather than the agent opening its own file:** less code in
the agent, launchd owns the fd. Two caveats:

- **launchd does not rotate.** Add an `/etc/newsyslog.d/homeparentcontrol.conf` entry. Note
  the classic trap: newsyslog creates rotated files `root:root` by default (harmless here —
  the daemon *is* root — but it bites anything running as a user), and a rename-based
  rotation leaves the daemon writing to the orphaned inode unless it is signalled to reopen.
  Use newsyslog's pidfile/signal fields, or have the agent handle `SIGHUP`. **⚠️ Verify
  empirically on the mini** (§9.B).
- Keep the file modest — `100 KB × 7`, compressed. It is a forensic tail for the one time
  someone SSHes in, not the system of record. Loki is the system of record.

**Suggested line shape** (fields, not a schema — T4.1 owns the contract):

```json
{"ts":"2026-09-18T20:59:31.412Z","level":"info","event":"enforcement.warning_shown",
 "device":"mini-01","boot_id":"A1B2…","agent_version":"1.4.2","policy_version":17,
 "seq":88134,"msg":"10-minute warning displayed","detail":{"window":"bedtime","minutes_left":10}}
```

`seq` is a monotonic per-boot counter — it makes **gap detection** trivial on the control
plane ("we have 88130..88134, we are missing 88131") without any clever infrastructure.
Cheap, and it turns "did we lose logs?" from a guess into a fact.

### 1.6 ⚠️ The out-of-order trap (the thing a naive implementation gets wrong)

Store-and-forward (T4.3) plus Loki's ingestion rules interact badly, and this is easy to miss:

- `reject_old_samples: true` is the default; `reject_old_samples_max_age` is commonly `168h`
  (7d) — that governs **new** streams.
- For a stream that already has data, out-of-order writes are accepted only within
  **`max_chunk_age / 2`**, which with the default `max_chunk_age: 2h` is **one hour**.

So: the Mac is off the network for three hours, comes back, and replays its spool. The
control plane is meanwhile still writing fresh lines to the *same stream*. The replayed
entries are >1h behind the stream head and are **rejected with `entry too far behind`** —
silently, from the agent's point of view.

**Rule for the control plane forwarder:** never drop a line to satisfy Loki.

1. Replay the spool **in timestamp order**, oldest first, and flush aggressively on
   reconnect so the window is as small as possible.
2. If an entry's true timestamp falls outside the acceptable window, **ingest it anyway**
   using `received_at` as the Loki timestamp, and carry the true time in the JSON body
   (`ts`) and in structured metadata (`event_time`, `delayed: "true"`). The line is
   preserved; the truth is preserved; the ordering is a lie you can see and query.
3. Emit a `log.backfill` event recording the gap, so the backfill is itself visible.

Sources: [request validation & rate limits](https://grafana.com/docs/loki/latest/operations/request-validation-rate-limits/) ·
[working with out-of-order and older logs](https://grafana.com/blog/the-concise-guide-to-loki-how-to-work-with-out-of-order-and-older-logs/)

### 1.7 Labels and cardinality

Loki's guidance is unambiguous: few labels, all static and low-cardinality; everything
high-cardinality goes in **structured metadata** or the line body. The default index-label
limit is 15; this deployment should use about four.
([Label best practices](https://grafana.com/docs/loki/latest/get-started/labels/bp-labels/) ·
[Cardinality](https://grafana.com/docs/loki/latest/get-started/labels/cardinality/))

**Stream labels — exactly these:**

| Label | Values | Why |
|---|---|---|
| `app` | `homeparentcontrol` | Matches the `home*` convention. ⚠️ Confirm the exact key the owner's other apps use (§9.A) |
| `component` | `agent`, `control-plane` | The one split that matters operationally |
| `device` | `mini-01` | Stable, bounded by number of Macs. Satisfies P2.4 — identity is a label, not a hardcode |
| `env` | `home` | Only if the owner's other apps carry it. Otherwise omit |

Cardinality: 2 components × 1 device = **2 streams**. That is the entire footprint. Correct
for this system.

**Structured metadata** (attached, filterable, *not* indexed): `boot_id`, `agent_version`,
`policy_version`, `seq`, `request_id`. This is exactly the "too high-cardinality to be a
label, too useful to bury" bucket the feature was built for.

**Explicitly NOT labels:**

- `level` / `severity` — tempting, and wrong. It doubles or triples the stream count for a
  filter that `| json | level="error"` does perfectly well at this volume.
- `event` — dozens of values and growing. Body field.
- `child`, `session_id`, `policy_version`, `boot_id`, any timestamp, anything parsed out of
  the log line.

The control plane's *own* pod logs should need **no new labels at all** — if the existing
Alloy DaemonSet scrapes pod stdout cluster-wide, writing JSON to stdout is the whole
integration. ⚠️ Verify (§9.A).

**Retention:** Loki only enforces retention if the **compactor** runs with
`retention_enabled: true` and a `delete_request_store`; without it the store grows forever.
For this data, 30–90 days is generous.
([Log retention](https://grafana.com/docs/loki/latest/operations/storage/retention/)) ⚠️ §9.A.

> **Note the scope boundary.** Loki is for *operational* logs — did the agent run, did
> enforcement fire, did a policy fetch fail. The *product* data — how long the child used
> the machine, which apps — belongs in the control plane's own database and the parent UI
> (P0.4, T5.3), **not** in Loki. Loki is not a reporting database, and conflating the two
> would push exactly the high-cardinality, long-retention data into it that §1.7 is trying
> to keep out.


---

## 2. T6.2 — Health, not just logs

### 2.1 The central problem, stated precisely

From the server's perspective, these four are **identical**: no traffic.

1. The child shut the Mac down at bedtime. *(Normal. Possibly **we** did it — if D.3 lands on
   `shutdown`, the agent's own enforcement action is a leading cause of silence.)*
2. The Mac went to sleep on an idle timer. *(Normal.)*
3. The agent crashed, or is crash-looping, or its config is unparseable. *(Broken.)*
4. Someone unplugged the Ethernet / the mini / the router. *(Ambiguous — could be either.)*

**No amount of server-side cleverness can separate these from silence alone.** Silence is a
single bit; the question needs more than a bit. Two families of answer:

- **Probe the Mac from the cluster** (ICMP / TCP / ARP). Rejected — see §2.2.
- **Make the agent declare its intent before it goes quiet, and make its *next* start report
  whether the last exit was clean.** ✅ This is the recommendation.

### 2.2 Why not probe the Mac from the cluster

Superficially attractive: the k3s node and the mini share a trusted LAN (AR.2), so a
blackbox-exporter ICMP probe would seem to disambiguate "host up, agent silent" (= broken)
from "host down" (= asleep). Three problems:

- **A sleeping Mac's ARP is answered by someone else.** With Wake on Demand, a Bonjour Sleep
  Proxy *"answers [ARP/ND requests] on behalf of the sleeping device, without waking it up,
  giving its own MAC address"*
  ([Cheshire, Understanding Sleep Proxy Service](https://stuartcheshire.org/sleepproxy/) ·
  [Bonjour Sleep Proxy](https://en.wikipedia.org/wiki/Bonjour_Sleep_Proxy)). L2 presence is
  therefore **not** evidence the host is awake.
- **Probing may wake the machine.** "Wake for network access" exists to wake Macs on directed
  network traffic. Waking the child's Mac at 03:00 because a monitoring probe knocked is a
  real, user-visible regression, and it happens on the machine the owner cannot easily reach.
  *(Whether ICMP specifically wakes a given Mac is configuration-dependent and the public
  documentation is inconsistent — that ambiguity is itself a reason not to build on it.)*
- **ICMP is weak evidence generally** — trivially filtered, and it tells you nothing about
  the agent.

**Verdict: no active probing.** It answers the wrong question, risks a side effect on the
target, and its negative result is not trustworthy. If a cheap corroborating signal is ever
wanted, it belongs as a *dashboard hint*, never as an alert input. (§9.A item 9 keeps the
door open.)

### 2.3 The design: the agent declares its own state

Four events. All three of the non-heartbeat ones are rare, which is what makes them
informative.

| Event | When | Key fields |
|---|---|---|
| `agent.started` | Daemon start | `boot_id`, `agent_version`, `previous_exit_clean: bool`, `previous_stop_reason` |
| `agent.heartbeat` | **Every tick — it *is* the tick** | `uptime_s`, `policy_version`, `last_enforcement`, `clock_skew_s` |
| `agent.stopping` | Graceful shutdown path | `reason: shutdown \| sleep \| sigterm \| enforcement_shutdown \| operator \| config_reload` |
| `agent.waking` | Resume from sleep | `slept_for_s` |

**Mechanics on macOS, for a root LaunchDaemon:**

- **SIGTERM.** launchd sends `SIGTERM` on system shutdown and on `launchctl unload`. Trap it,
  emit `agent.stopping{reason:sigterm|shutdown}`, flush, exit. Straightforward.
- **Sleep.** ⚠️ **Do not use `NSWorkspace.willSleepNotification`.** NSWorkspace is AppKit, and
  *"Daemons are NOT allowed to use it. Your daemon should not even be LINKING against
  AppKit."* The daemon-safe API is IOKit's **`IORegisterForSystemPower`**, handling
  `kIOMessageSystemWillSleep` and `kIOMessageSystemHasPoweredOn` (and you must call
  `IOAllowPowerChange` to let the sleep proceed).
  ([Apple forums: shutdown/restart via launch agent](https://developer.apple.com/forums/thread/761467) ·
  [willSleepNotification](https://developer.apple.com/documentation/appkit/nsworkspace/willsleepnotification))
- **⚠️ The pre-sleep/pre-shutdown flush is best-effort.** The window before sleep is short and
  not guaranteed to survive a network round-trip. **Do not build the design on the dying
  breath arriving.**

**Which is why the load-bearing mechanism is the `clean_exit` file, not the network:**

```
/var/db/homeparentcontrol/state.json
  on start:          read previous {clean_exit, stop_reason, stopped_at}  → report it
                     then immediately write {clean_exit:false, boot_id:…, started_at:…}
  on graceful stop:  write {clean_exit:true, stop_reason:"shutdown", stopped_at:…}, fsync, exit
```

This is local, synchronous, and independent of the network entirely. Even if every
`agent.stopping` POST is lost, the **next** `agent.started` carries
`previous_exit_clean: false` — so a crash is always reported, just one boot late. Combined
with absence-alerting (which catches it *now*), coverage is complete.

**On launchd `KeepAlive`:** with `KeepAlive` set, a crashing agent is restarted in seconds,
so a crash-loop shows up as a rapid burst of `agent.started` with
`previous_exit_clean: false` — a *loud* signature, not silence. Alert on that directly: more
than 3 `agent.started` events in 10 minutes is a crash loop. ⚠️ Check `KeepAlive` /
`ThrottleInterval` in POC 1's plist (§9.B).

### 2.4 The state machine (lives in the control plane)

The control plane — a k3s pod, reliably running, unlike the Mac — evaluates once a minute and
**emits its verdict as a log line**. This is the key structural move: it converts an
*absence* on the agent's stream into a *presence* on the control plane's stream, which makes
alerting trivial and sidesteps Grafana's No-Data trap entirely (§2.6).

```
                       last heartbeat within 3 ticks (180s)?
                                  │
                   ┌── yes ───────┴──────── no ──┐
                   │                             │
        errors in last 3 ticks?        last event a clean agent.stopping?
           │            │                   │              │
          yes          no                  yes             no
           │            │                   │              │
        DEGRADED     HEALTHY        silence > 36h?     UNEXPECTED_SILENCE
                                     │         │         (→ ALERT)
                                    yes        no
                                     │         │
                              SILENT_TOO_LONG  EXPECTED_OFFLINE
                                 (→ ALERT)      (→ no alert, this is bedtime)
```

| State | Meaning | Alert? |
|---|---|---|
| `HEALTHY` | Heartbeat within 180s, no errors | No |
| `DEGRADED` | Heartbeating, but reporting errors: policy fetch failing, enforcement failed, `clock_skew_s > 60`, spool near capacity | **Yes**, low urgency — this is the agent *telling you* it is unwell, which is the most valuable alert in the system |
| `EXPECTED_OFFLINE` | Silent, and the last thing we heard was a clean stop | **No.** This is "the child is asleep" / "we shut it down at bedtime" |
| `UNEXPECTED_SILENCE` | Silent, and the last exit was *not* clean (or we never got one) | **Yes** |
| `SILENT_TOO_LONG` | Silent > 36h **regardless of how cleanly it stopped** | **Yes** |

`SILENT_TOO_LONG` is the honest backstop. "Cleanly shut down" stops being reassuring after a
day and a half — at that point it means someone unplugged it, or it never came back, or the
whole thing has quietly stopped working and nobody noticed. Without this state a graceful
`agent.stopping` would suppress alerting **forever**, which is the classic dead-man's-switch
failure: a switch that goes quiet and stays quiet is worse than no switch at all.

### 2.5 Thresholds — and why these numbers

Assuming POC 1's **60-second tick**:

| Threshold | Value | Reasoning |
|---|---|---|
| Heartbeat interval | **60s** | Already exists. Do not invent a second heartbeat — **the tick *is* the heartbeat**. It rides the control path, so it is alive exactly when the thing that matters is alive |
| `HEALTHY` window | **180s** (3 ticks) | Tolerates one lost tick plus jitter |
| `UNEXPECTED_SILENCE` → alert | **10 minutes** | Long enough to ride out a DHCP renewal, a Wi-Fi flap, a router reboot, a brief Loki hiccup. Short enough that a crash on a school evening is caught while it still matters. **Do not set this to 3 minutes** — a home system that cries wolf gets muted, and a muted alert is worth less than none |
| `SILENT_TOO_LONG` → alert | **36 hours** | Spans a normal overnight-plus-a-full-school-day gap without firing every Saturday. A school holiday will produce a false positive; that is the correct trade for catching a genuinely dead agent |
| Crash-loop | **>3 `agent.started` in 10m** | Distinct signature, distinct alert |
| `DEGRADED` → alert | **3 consecutive degraded evaluations** | Debounces a single transient error |

**One deliberately *non*-alerting signal — the enforcement-window guard.** If the agent is
silent at T-5min before an enforcement window (e.g. 20:55 for a 21:00 bedtime), that is the
moment where silence has consequences: no enforcement will happen. But "silent at bedtime"
is *also* exactly what "she went to bed early" looks like. So emit it as an **informational
notification**, not an alert: *"Agent unreachable at 20:55; no bedtime enforcement occurred
tonight."* The parent gets the fact without being trained to ignore a red badge. This also
feeds open question **O.1** (fail-open vs fail-closed) — whichever way that lands, the parent
should be *told* which way it went.

### 2.6 ⚠️ The Grafana No-Data trap

The naive heartbeat alert — "query the agent's log stream, set No Data → Alerting" — is a
trap, for two documented reasons:

1. *"A LogQL metric query returns **no series** when no log lines match, rather than returning
   a value of `0`. Grafana evaluates a rule that receives no series as **No Data**, not
   **Normal**."*
   ([Loki alerting](https://grafana.com/docs/grafana/latest/datasources/loki/alerting/))
2. When a rule enters No Data, Grafana fires a **synthetic** alert with
   `alertname=DatasourceNoData`, `datasource_uid=…`, `rulename=…`. These *"are independent
   from the original alert instance"* and **may not inherit existing silences or notification
   policies**.
   ([No Data and Error states](https://grafana.com/docs/grafana/latest/alerting/fundamentals/alert-rule-evaluation/nodata-and-error-states/))

So the alert you carefully routed to your phone fires as a *differently-labelled* alert that
your notification policy may drop on the floor. You would discover this the first time it
mattered.

**Two mitigations, use both:**

- **Alert on the control plane's stream, not the agent's.** The control plane emits
  `agent_status` every minute and is always running, so the stream is never empty and No Data
  never occurs. This is why §2.4 puts the state machine in the control plane.
- **Belt and braces: `or vector(0)`.** Force a numeric result. Must be applied to an
  *aggregated* expression — `sum(count_over_time(...)) or vector(0)` fills; an unaggregated
  range vector does not.

**Concrete rules** (Grafana-managed — confirmed these do **not** require the Loki ruler;
*"Grafana-managed rules ... work with any Loki data source"*, while the ruler is needed only
for data-source-managed rules):

```logql
# A1 — agent unexpectedly silent                    for: 5m   severity: critical
sum(count_over_time(
  {app="homeparentcontrol", component="control-plane"}
  | json | event="agent_status" | status="UNEXPECTED_SILENCE" [5m]
)) or vector(0)
# condition: > 0

# A2 — silent too long (fires even after a clean stop)   for: 10m  severity: warning
#   same shape, status="SILENT_TOO_LONG"

# A3 — agent degraded                                for: 3m   severity: warning
#   same shape, status="DEGRADED"

# A4 — crash loop                                    for: 0m   severity: critical
sum(count_over_time(
  {app="homeparentcontrol", component="agent"} | json | event="agent.started" [10m]
)) or vector(0)
# condition: > 3

# A5 — meta: the control plane itself went quiet     for: 10m  severity: critical
#   This is the watcher-of-the-watcher. Everything above depends on the control
#   plane emitting agent_status; if IT stops, all four rules go quiet and you learn
#   nothing. This one is the only rule that must tolerate No Data → set No Data = Alerting.
sum(count_over_time(
  {app="homeparentcontrol", component="control-plane"} | json | event="agent_status" [10m]
)) or vector(0)
# condition: < 5
```

Set **No Data handling = Alerting** on A5 specifically, and confirm the notification policy
routes `alertname=DatasourceNoData` somewhere the parent sees (§9.A item 10).

**Provision these as code.** Grafana alert rules clicked into the UI are invisible to Argo CD
and vanish on a Grafana reinstall — directly at odds with P3.2/P3.4. ⚠️ §9.A item 7.

### 2.7 Should there be metrics at all? — **No. Opinion, stated plainly.**

**For the agent: no Prometheus. Structured logs plus the heartbeat are sufficient, and the
metrics stack would be pure ceremony.** Four reasons:

1. **n = 1.** Everything that makes Prometheus worth its weight — aggregation across
   instances, `rate()` over a fleet, quantiles over a population, capacity planning, SLO
   burn — presumes many things being measured. With one agent, every "metric" is a single
   number you could read off the last heartbeat line.
2. **Pull is the wrong shape for this topology.** Scraping the agent needs an inbound
   listener on the child's Mac — the one machine least suited to hosting one, and a direct
   contradiction of H2 and the P2.1 agent-initiated design.
3. **Pushgateway is actively harmful for liveness.** It serves the last pushed value
   indefinitely until explicitly deleted, so a dead agent's metrics look perfectly healthy
   forever. It is the precise opposite of what a heartbeat needs.
4. **LogQL already does the job.** `count_over_time({component="agent"} | json |
   event="agent.heartbeat" [10m])` is a real metric query with real alerting, computed from
   data you are sending anyway. Zero new infrastructure.

**One exception, conditional.** The *control plane* is an ordinary k3s workload and should
expose `/metrics` like every other `home*` app. If the owner already runs Prometheus or
Mimir, add exactly one gauge:

```
homeparentcontrol_agent_last_seen_timestamp_seconds{device="mini-01"}
homeparentcontrol_agent_status{device="mini-01", status="HEALTHY|DEGRADED|…"}   # 0/1
```

and alert `time() - homeparentcontrol_agent_last_seen_timestamp_seconds > 600`. That is the
cleanest dead-man's switch obtainable: a real number, monotonically aging, no No-Data
ambiguity, no `or vector(0)` gymnastics. **But it is a bonus, not the plan** — the LogQL rules
in §2.6 are complete on their own. ⚠️ Whether a Prometheus/Mimir exists at all is unverified
(§9.A item 5); the design must not assume it.

### 2.8 Minimum useful Grafana dashboard

One dashboard. **Six panels.** The parent already lives in Grafana for the cluster, so this
is the right surface for *operator* questions.

| # | Panel | Viz | Query / content |
|---|---|---|---|
| 1 | **Agent status** | Stat, large, value-mapped | `HEALTHY` green · `EXPECTED_OFFLINE` grey ("asleep") · `DEGRADED` amber · `UNEXPECTED_SILENCE` / `SILENT_TOO_LONG` red. Latest `agent_status` from the control plane |
| 2 | **Last seen** | Stat, "time ago" | The single most informative number on the page. "4 minutes ago" vs "2 days ago" answers the question before you read anything else |
| 3 | **Version** | Stat | `agent_version` from the latest heartbeat. Tells you a rollout landed — feeds T3.1/T3.2 |
| 4 | **Online / offline, last 7 days** | **State timeline** | ⭐ The panel that earns the dashboard. It renders the *shape* of normal — "on 16:00–21:00, off overnight" — so an anomaly is visible at a glance without anyone defining what anomalous means. Answers "is this normal?" better than any threshold |
| 5 | **Warnings & errors** | Logs | `{app="homeparentcontrol"} \| json \| level=~"warn\|error"`, last 100 |
| 6 | **Enforcement events** | Logs / Table | `{component="agent"} \| json \| event=~"enforcement.*"` — "what did it actually do last night" |

**Deliberately excluded:** anything about the child's usage. That is *product* data and it
belongs in the parent UI (P0.4) — the app answers "what did my kid do", Grafana answers "is
my system working". Keeping that line clean is an architecture decision, not a cosmetic one:
it keeps long-retention, high-cardinality, per-child data out of Loki (§1.7) and keeps the
parent's daily surface out of an operator tool.

Also excluded: CPU/memory/disk of the mini, request-latency histograms, anything with a
p99. One agent, one tick a minute. There is nothing to tune.

---

## 3. Recommended design

### 3.1 Log flow

```
  CHILD'S MAC MINI (root LaunchDaemon)            k3s — owner's cluster
  ┌──────────────────────────────────┐            ┌──────────────────────────────┐
  │  agent                           │            │  control-plane (pod)         │
  │   │                              │            │   │                          │
  │   ├─ JSON line ─► stdout         │            │   ├─ /v1/agents/{id}/tick    │
  │   │               │              │            │   │    · policy out          │
  │   │        launchd StandardOutPath│           │   │    · heartbeat in  ◄─────┼── control path
  │   │               ▼              │            │   │    · last_seen := now    │    (sacred)
  │   │   /var/log/homeparentcontrol │            │   │                          │
  │   │     /agent.log  (newsyslog)  │            │   ├─ /v1/agents/{id}/logs    │
  │   │     forensic tail only       │            │   │    batched NDJSON  ◄─────┼── log path
  │   │                              │            │   │    │                     │    (may fail
  │   └─ spool (capped, seq'd) ──────┼─ HTTPS ────┤   │    ├─ ts sanity/backfill │     alone)
  │        ack-based truncation      │  mTLS or   │   │    ├─ label stamping     │
  │                                  │  token     │   │    └─► POST /loki/api/v1/push
  │   os_log breadcrumb (start/stop) │            │   │                          │
  │        %{public}s only           │            │   └─ state machine (1/min)   │
  │                                  │            │        └─► agent_status ───┐ │
  │   /var/db/…/state.json           │            │            (to stdout)     │ │
  │        clean_exit flag           │            └────────────────────────────┼─┘
  └──────────────────────────────────┘                                        │
                                          existing Alloy DaemonSet ◄──────────┘
                                                    │  (scrapes pod stdout — free)
                                                    ▼
                                                  LOKI  ──►  GRAFANA
                                                              ├─ dashboard (§2.8)
                                                              └─ alert rules A1–A5
```

**Two endpoints, deliberately.** The **tick** is the control path: small, fast, carries
policy and the heartbeat, and must never fail because of a log payload. The **log batch** is
a separate request on the same client, same auth, same connection pool — and it is *allowed
to fail independently*. A malformed or oversized log batch must not be able to break policy
delivery or enforcement. This is T3.5 (blast radius) applied to observability, and it is the
reason not to piggyback logs onto the tick.

**Conversely, do not invent a separate heartbeat.** The tick already proves the agent is
alive *and* that the path that matters is working. A dedicated heartbeat endpoint could
succeed while the control path was broken — a heartbeat that can lie is worse than none.

### 3.2 What health is, in one paragraph

The agent persists a `clean_exit` flag locally and declares `started` / `heartbeat` /
`stopping{reason}` over the wire. The control plane records `last_seen` on every tick and
evaluates a five-state machine once a minute, emitting `agent_status` to its own stdout —
turning the agent's *absence* into the control plane's *presence*, which the existing Alloy
DaemonSet ships to Loki for free. Grafana alerts on that `agent_status` stream, so
"the Mac is off" (`EXPECTED_OFFLINE`) and "the agent is broken" (`UNEXPECTED_SILENCE`) are
different strings in a log line rather than two indistinguishable silences.

### 3.3 Alerts — the complete list

| ID | Fires when | For | Severity | Parent-facing text |
|---|---|---|---|---|
| A1 | `UNEXPECTED_SILENCE` | 5m | critical | "Agent stopped responding without shutting down cleanly." |
| A2 | `SILENT_TOO_LONG` (>36h) | 10m | warning | "No contact from the Mac in over a day." |
| A3 | `DEGRADED` ×3 | 3m | warning | "Agent is running but reporting errors." |
| A4 | >3 restarts in 10m | 0m | critical | "Agent is crash-looping." |
| A5 | Control plane stopped emitting status | 10m | critical | "The monitor itself has stopped." *(No Data → Alerting)* |
| — | Enforcement window missed | — | **info, not an alert** | "No bedtime enforcement ran last night — the Mac was unreachable." |

Five alerts. For a one-agent home system that is already at the upper limit; resist adding
more. Every alert that fires and does not need action trains the parent to ignore the next
one.

### 3.4 Build order

1. Agent writes JSON lines to stdout; `newsyslog` config; `state.json` clean-exit flag.
   *(No network involved — testable entirely on the mini today.)*
2. `agent.started` / `stopping` via SIGTERM + `IORegisterForSystemPower`.
3. Control plane: `/logs` endpoint → in-memory → stdout. **No Loki yet** — the existing Alloy
   DaemonSet picks it up, so agent logs reach Loki with *zero* Loki-specific code. If the
   DaemonSet does scrape cluster-wide (§9.A item 2), **step 4 may be unnecessary entirely**.
4. Only if needed: direct `POST /loki/api/v1/push` from the control plane, with the
   out-of-order handling in §1.6.
5. State machine + `agent_status` emission.
6. Grafana dashboard, then alert rules, both provisioned as code.

Steps 1–2 need no cluster. Step 3 is where the cluster gate lands.

---

## 4. Answers, condensed

| Question | Answer |
|---|---|
| Alloy on darwin/arm64? | **Yes.** Official `alloy-darwin-arm64.zip`, Homebrew formula, launchd service via `brew services`. Support tier **unstated** in the docs |
| Alloy first-class on macOS? | **Neither promised nor denied.** Evidence points to "supported, lightly exercised": no darwin log source, an open cosmetic brew-services bug since Jul 2025, formula edits required to change service flags |
| Promtail? | **EOL 2026-03-02.** Disqualified |
| Best shipper? | **None on the Mac.** Agent → control plane → Loki |
| Direct-to-Loki from the agent? | Workable, rejected. Puts Loki credentials and Loki-specific code on the machine you cannot reach, and couples the agent's release cycle to the observability backend |
| How should the agent emit? | **Structured JSON to stdout**, captured by launchd `StandardOutPath`. **Not `os_log`** — macOS 26 redacts dynamic strings as `<private>`. One `%{public}s` breadcrumb on start/stop only |
| Labels? | `app`, `component`, `device` (+ `env` if conventional). **2 streams total.** `boot_id` / `agent_version` / `seq` as structured metadata. Never `level` |
| Off vs broken? | The agent **declares** it: `stopping{reason}` over the wire, plus a local `clean_exit` flag read on the next start. Clean stop → `EXPECTED_OFFLINE`, no alert. Unclean → `UNEXPECTED_SILENCE`, alert |
| Heartbeat? | **The existing 60s tick is the heartbeat.** Do not build a second one |
| How long is too long? | **10 minutes** for unexplained silence · **36 hours** regardless of explanation |
| Metrics? | **No.** n=1. LogQL over the heartbeat covers it. One optional gauge on the control plane *if* Prometheus already exists |
| Dashboard? | Six panels; the **7-day state timeline** is the one that earns its place |

---

## 5. Honest limits

- **Nothing here is verified against the owner's actual cluster.** §9.A could change specific
  choices (label keys, whether step 4 of §3.4 is needed at all, whether alerts can reach the
  parent's phone).
- **Pre-sleep flush is best-effort.** Sleep and shutdown windows are short and may not survive
  an HTTP round-trip. Mitigated — not eliminated — by the `clean_exit` file, which reports a
  crash one boot late rather than never.
- **`SILENT_TOO_LONG` will false-positive on holidays.** A school break with the mini switched
  off produces a 36h+ gap and a warning. Accepted: the alternative is a graceful stop
  silencing the alarm indefinitely. A "planned absence" mute in the parent UI would fix it
  cheaply later.
- **Loki is not a reporting database.** The parent's actual reports (P1.4) live in the control
  plane's store, not here. If that line blurs, §1.7's cardinality budget collapses.
- **Alert delivery is unverified and is the weakest link.** An alert that reaches a Grafana UI
  the parent opens twice a month is not an alert. §9.A item 6 is the highest-priority
  deferred check in this document.
- **Agent hard-crash loses the dying breath.** Accepted. Local file retains it; A1 catches the
  silence; A4 catches the loop; the next `agent.started` reports the unclean exit.
- **`or vector(0)` behaviour was confirmed from documentation and community sources, not run
  against a live Loki.** It requires an aggregated expression. Verify when the cluster is
  reachable.

---

## 6. Interaction with other tracks

| Track | Interaction |
|---|---|
| **T4.5** (heartbeat) | T6 **answers** T4.5. The tick is the heartbeat; §2.4's state machine is the design. T4 should adopt it rather than specify a parallel one |
| **T4.1** (contract) | Adds `POST /v1/agents/{id}/logs`, separate from the tick, allowed to fail independently |
| **T4.3** (store-and-forward) | The log spool and the telemetry spool are the same mechanism. Build once. §1.6's out-of-order handling is a shared requirement |
| **T4.4** (fail-open/closed, **O.1**) | Whichever way O.1 lands, §2.5's enforcement-window notification is how the parent learns which way it went on any given night |
| **T3.1/T3.2** (update/rollback) | `agent_version` in every heartbeat is how you confirm a rollout landed and detect a partial one. Also the core argument against on-Mac shippers: each is a second update channel |
| **T3.5** (blast radius) | Separating the log path from the control path is the same principle applied to telemetry |
| **T2.1** (language) | Any candidate must do: JSON to stdout, an HTTP client with retry, SIGTERM trapping, and `IORegisterForSystemPower`. The last is easy in Swift/Go/C, awkward in bash — **a real input to T2.1** |
| **T5.3** (telemetry storage) | Draws the Loki/product-data line: operational logs → Loki; usage data → control-plane DB |

---

## 7. Sources

**Grafana Alloy**
- [Supported platforms](https://grafana.com/docs/alloy/latest/introduction/supported-platforms/)
- [Install on macOS](https://grafana.com/docs/alloy/latest/set-up/install/macos/)
- [Run on macOS](https://grafana.com/docs/alloy/latest/set-up/run/macos/)
- [Configure on macOS](https://grafana.com/docs/alloy/latest/configure/macos/)
- [Install as standalone binary](https://grafana.com/docs/alloy/latest/set-up/install/binary/)
- [Releases — v1.19.2, 2026-08-26](https://github.com/grafana/alloy/releases/latest)
- [`loki.source.file`](https://grafana.com/docs/alloy/latest/reference/components/loki/loki.source.file/) · [`loki.source.api`](https://grafana.com/docs/alloy/latest/reference/components/loki/loki.source.api/) · [`loki.source.journal`](https://grafana.com/docs/alloy/latest/reference/components/loki/loki.source.journal/) (Linux only)
- [Issue #4008 — brew services plist error on macOS](https://github.com/grafana/alloy/issues/4008) *(open since 2025-07-17)*
- [Issue #2540 — file permissions reading root-owned logs](https://github.com/grafana/alloy/issues/2540)
- [Homebrew formula `grafana-alloy`](https://formulae.brew.sh/formula/grafana-alloy)

**Promtail EOL**
- [Promtail EOL announcement (March 2026)](https://community.grafana.com/t/promtail-end-of-life-eol-march-2026-how-to-migrate-to-grafana-alloy-for-existing-loki-server-deployments/159636)
- [Migrate to Alloy — Loki docs](https://grafana.com/docs/loki/latest/setup/migrate/migrate-to-alloy/)
- [Migrate from Promtail — Alloy docs](https://grafana.com/docs/alloy/latest/set-up/migrate/from-promtail/)

**Loki**
- [HTTP API — `/loki/api/v1/push`](https://grafana.com/docs/loki/latest/reference/loki-http-api/)
- [Label best practices](https://grafana.com/docs/loki/latest/get-started/labels/bp-labels/) · [Cardinality](https://grafana.com/docs/loki/latest/get-started/labels/cardinality/)
- [Request validation and rate limits](https://grafana.com/docs/loki/latest/operations/request-validation-rate-limits/)
- [Out-of-order and older logs](https://grafana.com/blog/the-concise-guide-to-loki-how-to-work-with-out-of-order-and-older-logs/)
- [Log retention / compactor](https://grafana.com/docs/loki/latest/operations/storage/retention/)
- [Multi-tenancy / `X-Scope-OrgID`](https://grafana.com/docs/loki/latest/operations/multi-tenancy/) · [Authentication](https://grafana.com/docs/loki/latest/operations/authentication/)
- [LogQL reference](https://grafana.com/docs/loki/latest/query/query_reference/) · [`vector()` implementation — loki#6946](https://github.com/grafana/loki/issues/6946)

**Grafana alerting**
- [Loki alerting — Grafana-managed vs data-source-managed](https://grafana.com/docs/grafana/latest/datasources/loki/alerting/)
- [No Data and Error states](https://grafana.com/docs/grafana/latest/alerting/fundamentals/alert-rule-evaluation/nodata-and-error-states/)
- [Configure Grafana-managed alert rules](https://grafana.com/docs/grafana/latest/alerting/alerting-rules/create-grafana-managed-rule/)

**macOS**
- [CPython #150644 — macOS 26 reports all dynamic log content as `<private>`](https://github.com/python/cpython/issues/150644)
- [Making os_log Public on macOS Catalina](https://saagarjha.com/blog/2019/09/29/making-os-log-public-on-macos-catalina/)
- [`NSWorkspace.willSleepNotification`](https://developer.apple.com/documentation/appkit/nsworkspace/willsleepnotification)
- [Apple forums — tracking shutdown/restart from a daemon (daemons must not link AppKit; use `IORegisterForSystemPower`)](https://developer.apple.com/forums/thread/761467)
- [Creating Launch Daemons and Agents](https://developer.apple.com/library/mac/documentation/macosx/conceptual/bpsystemstartup/Chapters/CreatingLaunchdJobs.html)
- [Using macOS newsyslog to rotate service logs](https://patelhiren.com/blog/macos-newsyslog-openclaw-logs/)
- [Understanding Sleep Proxy Service — Stuart Cheshire](https://stuartcheshire.org/sleepproxy/) · [Bonjour Sleep Proxy](https://en.wikipedia.org/wiki/Bonjour_Sleep_Proxy)

**Other**
- [Vector — macOS install](https://vector.dev/docs/setup/installation/operating-systems/macos/)
- [Prometheus blackbox_exporter](https://github.com/prometheus/blackbox_exporter)

### Where documentation looked stale or ambiguous

| Where | Problem |
|---|---|
| [Alloy supported platforms](https://grafana.com/docs/alloy/latest/introduction/supported-platforms/) | Lists macOS with **no support-tier language at all**, while Linux/FreeBSD rows carry lifecycle qualifiers. Cannot tell first-class from best-effort from the docs |
| [Alloy run on macOS](https://grafana.com/docs/alloy/latest/set-up/run/macos/) | Never states **which user** the launchd service runs as — which is exactly what determines whether it can read a root-owned log file |
| Alloy macOS docs generally | **No mention of TCC / Full Disk Access.** On macOS 26 that is a live concern for anything reading system locations. Silence here is a gap, not an assurance |
| [alloy#4008](https://github.com/grafana/alloy/issues/4008) | Open 14 months on a one-line formula bug in the macOS install path |
| Alloy macOS install page | References Homebrew prefix as `/opt/Homebrew` (capital H); the actual path is `/opt/homebrew`. Cosmetic, but a tell |
| Loki out-of-order limits | The effective window (`max_chunk_age/2`) is documented in a blog post and community threads far more clearly than in the reference config. Easy to miss, and it silently breaks store-and-forward |
| macOS sleep/shutdown hooks | Apple's canonical guidance for daemons is in **forum replies**, not the framework docs. The `NSWorkspace` docs do not warn that daemons must not use them |
| Wake-for-network-access behaviour | Whether ICMP wakes a sleeping Mac is inconsistently described across Apple docs, forums and third-party write-ups. Treated as unreliable rather than resolved |

---

## 8. Open questions this track did not settle

| # | Question | Who decides |
|---|---|---|
| T6-O.1 | Which **notification channel** does the parent actually see on their phone? The whole health design is inert without one | Owner |
| T6-O.2 | Should `EXPECTED_OFFLINE` be **schedule-aware** — "the mini should be on weekdays 15:00–21:00, alert if it is not"? More precise, but encodes the child's routine into config and will be wrong the first time the routine changes. **Leaning no** for v1 |
| T6-O.3 | Log retention for agent logs — 30d or 90d? Depends on whether the parent ever wants "what happened last term" |
| T6-O.4 | Does the parent want a **weekly digest** ("the agent was healthy 6.8 of 7 days")? Deliberately not designed here — it is D.2 (reporting delivery) territory |

---

## 9. Deferred verifications ⚠️

### A. Requires cluster access

| # | Check | Exact thing to run / look at | Why it matters |
|---|---|---|---|
| 1 | **Loki push endpoint and auth** | Is `auth_enabled: true` (→ `X-Scope-OrgID` required)? Is there a gateway with basic auth? `curl` the push URL from inside a pod in the target namespace | Determines the forwarder's auth code and whether the control plane needs a tenant ID |
| 2 | **Does the existing Alloy DaemonSet scrape pod stdout cluster-wide?** | Read the Alloy ConfigMap/CR: `discovery.kubernetes` + `loki.source.kubernetes`/`loki.source.file` relabel rules; which namespaces; which labels it stamps | **If yes, §3.4 step 4 is unnecessary** — the control plane just writes to stdout and agent logs reach Loki with zero Loki-specific code. This is the single highest-leverage check |
| 3 | **Loki `limits_config`** | `reject_old_samples_max_age`, `max_chunk_age` (→ out-of-order window = half), `ingestion_rate_mb`, `ingestion_burst_size_mb`, `max_streams_per_user`, `max_label_names_per_series` | Sizes the agent spool and decides whether §1.6's backfill rewrite is needed |
| 4 | **Is the compactor running with `retention_enabled: true`?** | Compactor config: `retention_enabled`, `retention_period`, `delete_request_store` | Without it, nothing ages out and the store grows forever |
| 5 | **Is there a Prometheus or Mimir at all?** | List workloads in the observability namespace; check whether Alloy does `prometheus.remote_write` and to where | Decides whether §2.7's optional gauge is worth exposing. **Design must not depend on it** |
| 6 | **⚠️ Highest priority — what contact point exists, and does it reach the parent's phone?** | Grafana → Alerting → Contact points. Is it email, ntfy, Telegram, Alertmanager→something? **Send a test notification and confirm it arrives on the phone** | An alert nobody receives is decoration. Everything in §2 depends on this |
| 7 | **How are Grafana alert rules and dashboards provisioned?** | Argo CD app for Grafana: sidecar-scanned ConfigMaps? `GrafanaDashboard`/`GrafanaAlertRuleGroup` CRs (grafana-operator)? Provisioning files? | Rules must be GitOps'd (P3.2/P3.4), not clicked in. Determines the file format to author |
| 8 | **Existing `home*` Loki label conventions** | In Grafana Explore: `label_values(app)` / `label_values(service_name)` / `label_values(namespace)` — see what the other `home*` apps actually carry | Match them exactly. Consistency is an explicit requirement (P3.1) |
| 9 | **Can the k3s node reach the mini at L3?** | `ping` / `nc` from a pod to the mini's LAN address | Only needed if the optional dashboard-hint probe in §2.2 is ever wanted. **Not required by the recommended design** |
| 10 | **Notification policy routing for `alertname=DatasourceNoData`** | Grafana → Alerting → Notification policies; check whether a catch-all route exists | A5 depends on No Data → Alerting actually being delivered (§2.6) |
| 11 | **Grafana version** | Grafana → Help → About | Confirms Unified Alerting, `or vector(0)` handling, and that State timeline is available |

### B. Requires the Mac (empirical, no cluster needed — can be done now)

| # | Check | Exact thing to run |
|---|---|---|
| 12 | Does `newsyslog` correctly rotate a launchd `StandardOutPath` file for a running root daemon? | Add `/etc/newsyslog.d/homeparentcontrol.conf`, force with `sudo newsyslog -F -v`, then confirm the daemon writes to the **new** inode (`lsof -p <pid>`) and not the renamed one |
| 13 | Does the mini sleep at all, and how? | `pmset -g` and `pmset -g custom` — inspect `sleep`, `displaysleep`, `standby`, `womp`, `powernap`. Determines how often `EXPECTED_OFFLINE` legitimately occurs |
| 14 | Is there enough time before sleep to flush an HTTP POST? | Prototype `IORegisterForSystemPower`; measure the window between `kIOMessageSystemWillSleep` and `IOAllowPowerChange`. **Expect: not reliably.** Confirms the `clean_exit` file must be the load-bearing mechanism |
| 15 | Does `%{public}s` still surface in `log show` for a root daemon on macOS 26? | Emit a test `os_log` line with and without `%{public}s`; `log show --predicate 'process == "…"' --last 5m` | 
| 16 | What does POC 1's plist set for `KeepAlive` / `ThrottleInterval`? | Read the existing plist | Determines the crash-loop signature that A4 alerts on |
| 17 | Does launchd reliably deliver `SIGTERM` on system shutdown (not just `launchctl unload`)? | Trap SIGTERM, write to `state.json`, reboot, inspect | The clean-shutdown path depends on it. If unreliable, `EXPECTED_OFFLINE` will under-trigger and A1 will false-positive nightly — **material to the whole design** |

> Items 12–17 need neither cluster nor network and could be settled on the mini this week.
> **Item 17 is the one that could most change the design** — if shutdown does not reliably
> produce a clean exit, the `EXPECTED_OFFLINE` state becomes unreachable in practice and the
> off-vs-broken distinction has to fall back on something else.

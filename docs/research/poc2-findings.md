# POC 2 — Findings

**Date:** started 2026-09-18
**Goal:** settle how `homeparentcontrol` is built and operated — the agent↔control-plane
contract, the agent's runtime and lifecycle, and the ceiling on what can be observed.
**Inputs:** [`requirements.md`](../requirements.md) · [`poc2-plan.md`](./poc2-plan.md) · POC 1 findings at
`~/Deloitte/SSO_SLO_TEST/POC_091726_2/findings.md`

**Research host:** macOS 26.6.2 (build 25G83), arm64 — *identical to POC 1's test host and
to the target machine spec, so probe results transfer directly.*

**Status:** ✅ all six research tracks complete and consolidated. Remaining work is empirical
(needs the owner's hands or cluster access) and design, not research — see §8.

---

## 1. Verdict

**The architecture is settled and the contract is designed. The delivery vehicle is not — and
that is this round's dominant finding.**

⚠️ **This verdict was rewritten on 2026-09-18 after direct testing refuted its original central
claim.** The original read: *"POC 1's pure-bash daemon does not survive contact with macOS 26"*,
on the agreement of three tracks. **A reboot test refuted it** (§2 #14, §5).

**POC 1's design survives, and so does its implementation language.** A bash-entry-point
LaunchDaemon comes back from reboot `[enabled, allowed]` and runs; so does an ad-hoc Mach-O. BTM
attributes both to "Unknown Developer" and notifies the user, but disallows neither. The
`osascript` banner path also works (§2 #13), contrary to a second track's inference.

**Swift remains the recommendation — but as an engineering preference, not a constraint.** It buys
maintainability, structured logging, direct `CFUserNotification` access and a cleaner notification
bundle. It is no longer required to make the thing work. **A bash agent is a legitimate choice, and
POC 1 is a legitimate starting point.**

**Shape:** agent plus inner-network control plane, agent-initiated polling, no inbound port. Two
LaunchDaemons, where the enforcer **never opens a socket** — making "works with the server down" a
structural property rather than a promise. **Fail-open on ignorance, fail-closed on knowledge**
(T3 and T4, converging independently under controlled conditions).

**Monitoring:** the free permission tier is generous enough to ship the product. Foreground app,
CPU-gated active time, idle, and power/session events all require **zero TCC grants** — verified
live. Everything richer (window titles, URLs, Apple's own aggregated data) requires a signed
notarized binary with a stable Team ID, and Apple is vaulting its own data year over year.
**Do not build core telemetry on Apple's data.**

**Money: NO-GO on the $99/yr.** It buys exactly one capability — Time Sensitive notifications —
which the child can revoke in **two clicks**, which no configuration profile can force back on,
and whose cost is **recurring with a silent failure mode**: the provisioning profile is evaluated
at every launch, so a missed renewal in year three makes the warnings quietly stop. Apple's free
`CFUserNotification` is the better mechanism regardless: a dialog rather than a notification,
unsuppressable by Focus, with no toggle for the child to find. **POC 1's modal-dialog instinct was
right; this is that instinct done properly.**

**What is left is not research.** Four tests needing the owner's hands, one needing a test daemon,
eleven needing cluster access, and one design task. See §8.

---

## 2. What was verified, and how

Direct tests and primary-source confirmations only. Inferences live in the track sections.

| # | Claim | Result | Track |
|---|---|---|---|
| 1 | Root bypasses TCC | **NO — verified.** `knowledgeC.db` is mode-644 user-owned, yet `ls` on its directory returns *Operation not permitted* | T1 |
| 2 | Foreground app, CPU, idle, power/session obtainable with no grant | **YES — verified live**, even from bash | T1 |
| 3 | Window-title capture fails silently without Screen Recording | **YES — verified.** Success plus empty `kCGWindowName`, no prompt, no error | T1 |
| 4 | BTM disallows unsigned / script LaunchDaemons | **Confirmed** via Apple DTS (*"switch to using a Mach-O executable"*); live disposition inspection needs sudo | T2, T3, T1 |
| 5 | Screen Time can power off a Mac | **NO — verified.** Apple put `ShutDownDevice` in the *MDM* protocol, not Screen Time | T7 |
| 6 | FamilyControls / ManagedSettings / DeviceActivity exist on macOS | **NO** — iOS/iPadOS only; Catalyst fails at runtime | T7 |
| 7 | Grafana Alloy runs on macOS | **YES** (v1.19.2, darwin-arm64) — **but there is no darwin log source**, so it adds a hop, not a capability | T6 |
| 8 | `unzip` / `ditto -x -k` propagate quarantine | **YES — verified**, contradicting widespread folklore. `tar` and `rsync` do not | T2 |
| 9 | A quarantined non-notarized Mach-O is blocked at `exec` | **YES — verified.** SIGKILLed silently (rc=137). Quarantined *scripts* are exempt | T2 |
| 10 | macOS 27 "Golden Gate" shipped 2026-09-14 | **Confirmed.** Full release notes reviewed: zero changes to Time Sensitive, notarization, codesign or BTM. New: **launchd will not load a quarantined `.plist`** | T7, T2 |
| 14 | ⚠️ **BTM leaves an ad-hoc / script-entry LaunchDaemon `disallowed` after reboot** | ❌ **REFUTED — tested directly 2026-09-18.** Two daemons installed in `/Library/LaunchDaemons`, one ad-hoc-signed Mach-O and one with `ProgramArguments = /bin/bash …`. **After reboot BOTH read `Disposition: [enabled, allowed, notified] (0xb)`, `Generation: 1`, and both auto-loaded and ran.** The *attribution* half is confirmed (`Developer Name: (null)`, `Parent Identifier: Unknown Developer`) — the *consequence* is not | session |
| 18 | **A `.pkg` cannot downgrade** | ❌ **REFUTED — tested 2026-09-18.** Two pkgs, same identifier, v2.0 then v1.0. `installer` reported *"Upgrading at base path"*, exited 0, the payload reverted to `VERSION_ONE` and the receipt to `1.0`. **The limitation is Munki's policy, not `installer`'s.** ⚠️ *Caveat: user domain (`-target CurrentUserHomeDirectory`); system domain needs sudo and was not tested — but `installer` treated it as an upgrade without consulting version direction* | session |
| 19 | **TCC grants detach on agent update under ad-hoc signing** | ✅ **CONFIRMED — and worse than stated.** An ad-hoc binary's designated requirement is `cdhash H"…"`, pinned to the exact hash, where a Developer-ID binary's is `identifier "…" and anchor apple`. **Identical source rebuilt twice gave different cdhashes** (`d10bff36…` vs `0a7592b6…`) — *even a no-op rebuild breaks identity*. **T7 and T1 right; T2 wrong to dispute it** | session |
| 17 | **`os_log` output from the agent is retrievable via `log show`** | ❌ **NO — tested 2026-09-18.** Three attempts from an ad-hoc-signed binary at `.default`, `.error` and `.fault`, queried by subsystem, by process, and by free-text across the whole store: **zero lines returned every time.** ⚠️ **Supports T6's conclusion by a different mechanism than T6 gave** — T6 blamed `<private>` redaction; we never saw `<private>` at all, because nothing came back. **Use stdout JSON. The reason T6 stated is not the operative one.** | session |
| 15 | **launchd delivers SIGTERM on full system shutdown** | ✅ **YES — verified.** Boot at epoch `1789749113`; both probes logged SIGTERM at `1789749091`, **22 s before boot**, then restarted at `16:32:01Z`. Works for **both** Swift and bash. `EXPECTED_OFFLINE` is assertable | session |
| 16 | **A naive bash daemon can trap SIGTERM in time** | ❌ **No — and the fix is known.** `sleep 30` in a loop defers the trap until sleep returns; launchd SIGKILLed it. **`sleep 30 & wait $!` fires the trap in <2 s** — verified both by manual `kill -TERM` and at real shutdown. An implementation detail, not a language limit | session |
| 12 | **`CFUserNotification` + masked text field works in-session** | **YES — verified 2026-09-18 with live human interaction.** Dialog rendered, `CFUserNotificationSecureTextField(0)` accepted input, `GetResponseValue` returned `"1234"`, `button=0 (default)`. ⚠️ **Root-daemon-via-`asuser` half still unverified** | session |
| 13 | **`osascript display notification` produces a banner** | ✅ **YES — verified 2026-09-18, observed directly by the owner.** The banner displayed. **POC 1 §2 was right; T2's inference was wrong.** ⚠️ **And the disproof matters more than the result:** `com.apple.ScriptEditor2` has **0** entries in `com.apple.ncprefs` while 79 other apps do — **yet the banner works anyway.** ncprefs registration is *not* a valid proxy for whether notifications fire | session |
| 11 | Developer ID provisioning profiles are evaluated at every launch | **Confirmed** from Apple's own documentation — *"if your Developer ID provisioning profile expires, the app will no longer launch"* | T2 |

---

## 3. Track results

Full detail per track lives in [`tracks/`](./tracks/); this section carries the distilled
result and the decisions that follow from it.

### T1 — Target capability ceiling ⚠️ gate
*Detail: [`tracks/T1-telemetry-ceiling.md`](./tracks/T1-telemetry-ceiling.md)*

**Status:** ✅ complete — probed live on macOS 26.6.2 / arm64.

**H3 CONFIRMED, with one refinement:** window and page *titles* sit behind **Screen Recording**
(not Accessibility, as commonly claimed); browser **URLs are a separate tier** again, behind
**per-browser Automation/AppleEvents**; and Apple's own aggregated usage sits behind **Full Disk
Access**. Three tiers, not two.

**The permission ceiling, in one line:** foreground app + per-process CPU + idle + power/session
are **permission-free**; `+Screen Recording` buys titles; `+per-browser Automation` buys URLs;
`+Full Disk Access` buys Apple's `knowledgeC` — and for a *headless daemon* every gated grant
must be pre-provisioned (MDM/PPPC, or a one-time manual add) **and keyed to a stable
Developer-ID/Team-ID signature, or it silently dies on the next update.**

| # | Finding | Consequence |
|---|---|---|
| 1 | **The free tier is real and generous.** `lsappinfo` + `NSWorkspace` (bundle ID), `ps %cpu` (CPU-gated accounting, PlayCap-style), `ioreg` `HIDIdleTime`, `pmset`/`log`/`last` — all ran here with **no TCC, no grant, even from bash** | App-level usage — which is what "screen time" actually means — needs **no permissions at all**. This is the product's viable floor |
| 2 | **Everything richer converges on one requirement:** a signed + notarized single binary with a fixed bundle ID and Team ID. TCC binds grants to *code identity* and revokes on update if unsigned (**verified** via the Homebrew/Claude-Code FDA case); subprocesses do not inherit; and BTM disallows unsigned/script LaunchDaemons | POC 1's pure-bash daemon satisfies **neither**. It likely works in-session but **will not reliably auto-load after reboot**. A real invalidation risk for the bash design |
| 3 | **Root does NOT bypass TCC — verified.** `knowledgeC.db` is mode-644 and user-owned, yet `ls` on its directory returns *Operation not permitted*. TCC overrides POSIX and root alike | The single most commonly misunderstood fact in this problem space, now settled empirically. Biome and Daemon Containers are likewise EPERM without FDA — Apple is actively vaulting its own data |

**Also verified:** window-title capture **fails silently** — success plus an empty `kCGWindowName`,
no prompt, no error. Any daemon must self-check via `CGPreflightScreenCaptureAccess()`.

**History depth available:** `last`/wtmp ≈ 11 months · `pmset` ≈ 7 days · unified log ≈ 30 days
queryable but only ≈1.5 days dense. *Anything needing longer retention must be collected and
stored by us, not read back from the OS.*

⚠️ **Scope:** all results are macOS 26.6.2. macOS 27 untested. The version-fragile items to
re-verify are **TCC reach, `CGWindowList` redaction, and BTM disposition**.

### T2 — Agent runtime, notifications, signing
*Detail: [`tracks/T2-runtime-notifications-signing.md`](./tracks/T2-runtime-notifications-signing.md)*

**Status:** ✅ complete — 729 lines, 42 sources (32 from Apple), 30 explicit evidence-grade flags.

**Two decisions, not one — the brief conflated them.**

| Decision | Verdict |
|---|---|
| Build the Swift `.app` notifier | ✅ **GO — $0**, ad-hoc signed. Fixes "Script Editor" attribution, gains actions/icon/Settings entry, and satisfies BTM + TCC — which are hard constraints *independent of notifications*. Crucially it makes the $99 a **later, reversible** decision: drop in a profile and re-sign, no rearchitecting |
| Pay the $99/yr Apple Developer Program | ⛔ **NO-GO for now.** It buys **exactly one thing: Time Sensitive** — and the child can revoke it in **two clicks** (Notifications → "Allow time sensitive alerts", or Focus → "Time Sensitive Notifications"). Apple documents this outright, and **no config profile can force it back on** — there is no time-sensitive key in the MDM payload |

**Language: Swift.** Runner-up Go — which wins if the $99 is declined *and* `CFUserNotification`
becomes the only notification path, since that collapses the macOS surface to two plain C APIs
where cgo is clean and Go's cross-compilation wins.

| # | Finding | Consequence |
|---|---|---|
| 1 | **Apple's free API beats the paid one here.** `CFUserNotification` is documented for *"use in processes that do not otherwise have user interfaces"* — it is a **dialog, not a notification**: Focus cannot suppress it, the child has no toggle, it costs nothing, needs no bundle, and supports three buttons plus a timeout | **POC 1's modal-dialog instinct was right — this is that instinct done properly.** It also removes the main reason to pay |
| 2 | **`osascript display notification` may already be dead on macOS 26/27.** It returns exit 0 while `com.apple.ScriptEditor2` has **zero** notification registration — 79 other apps do. Matches an unanswered Apple forum report | ⚠️ **Contradicts POC 1 §2**, which reported banners "confirmed visually" on this same build one day earlier. Registration-based inference vs. direct observation — **resolve empirically before trusting either** |
| 3 | **Nothing this project installs is ever quarantined**, so Gatekeeper never assesses it and **notarization is irrelevant.** Measured: scp, rsync, local build and tar all yield only `com.apple.provenance`. `spctl -a` reports "rejected" for a local ad-hoc binary that runs fine | ⚠️ **Disagrees with T3**, which recommended a signed *and notarized* `.pkg` — see §5 |

**macOS 27 — confirmed shipped 2026-09-14.** Full release notes reviewed: **zero** hits for Time
Sensitive, notarization, codesign or BTM, so no conclusion changes. One new item: **launchd will
not load a quarantined `.plist`**.

**BTM — confirmed**, via Apple DTS guidance to *"switch to using a Mach-O executable"*. bash and
Python are eliminated; T2 agrees this is a hard constraint.

**But T2 disagrees with T3 that BTM settles the $99:** BTM requires a *Mach-O*, not a Developer
ID. Un-toggleable login items need MDM plus `com.apple.servicemanagement`, whose `RuleType`
accepts a `Label` — no Team ID. **So notifications require the money; persistence does not.**

**On T6:** agrees the conclusion but qualifies the reasoning — Apple documents SIGTERM at
shutdown, so bash *could* trap a clean exit. **BTM is the load-bearing case against bash, not
power events.**

⚠️ **Highest-value open test (15 min, on the Mac mini):** install a trivial **ad-hoc** Mach-O
LaunchDaemon, reboot, then `sudo sfltool dumpbtm | grep -A10 <label>`. If it reports
`disallowed`, the $99 buys persistence too and **the go/no-go flips to GO**.

**Incident note.** The Gatekeeper dialogs the owner saw came from a Gatekeeper-research subagent
spawned *by* this track, which never reported back and was still live. T2 issued a hard stop,
removed all 24 synthetic quarantine attributes scratchpad-wide (independently re-verified clean),
left the `qtest*` directories as evidence, and added a provenance note so the forged
`com.apple.Safari` strings cannot alarm a later reader. The subagent's own report confirms it — not
T2 — ran the experiments; it has since terminated.

#### Addendum — 763 lines, 51 sources (39 Apple)

> ⚠️ **MATERIAL: the $99 is recurring, and stopping breaks the app.** Time Sensitive needs a
> restricted entitlement, which needs an embedded provisioning profile — and Apple evaluates a
> Developer ID provisioning profile **at every app launch**: *"if your Developer ID provisioning
> profile expires, the app will no longer launch."*

The two paths are therefore **asymmetric**. An ad-hoc or self-signed notifier runs forever, with
nothing to expire (TN3125: *"macOS doesn't require a provisioning profile to run third-party
code"*). A Developer-ID-with-Time-Sensitive notifier **stops launching when the membership
lapses**. That converts "$99 once, to try it" into "$99/yr forever, or the child's screen-time
warnings silently go dark" — on a system whose entire value proposition is running unattended
for years. **A missed renewal in year three is a realistic and silent failure mode.** If the $99
is ever bought it needs a calendar alarm, and the free `CFUserNotification` path should be
retained as the lapse fallback.

| # | Correction | Deployment consequence |
|---|---|---|
| 1 | **`unzip` and `ditto -x -k` DO propagate quarantine on macOS 26** (verified) — contradicting widespread folklore. `tar` and `rsync` do not | **Ship a tarball or rsync the tree — never a `.zip`** |
| 2 | **Quarantine blocking is enforced at `exec`, not only via LaunchServices.** A quarantined non-notarized Mach-O is **SIGKILLed silently** (rc=137); a quarantined *notarized* one runs fine; quarantined *scripts* are exempt | A LaunchDaemon binary that ever acquired quarantine would be killed by launchd. With macOS 27 also refusing to load a quarantined `.plist`, the rule is absolute: **verify `xattr -r` on the install tree post-deploy** |
| 3 | The free personal-team **7-day clock exists only if `Contents/embedded.provisionprofile` exists** | Check for that file rather than aging an app |

**Upgraded from inference to cited:** Developer ID *Application* vs *Installer* certificates — with
Apple's own warning that the wrong one *"may appear to work"* but *"will fail on the destination
Mac"*; a free Apple ID definitively **cannot** notarize; `scp`/`curl` definitively do **not**
quarantine (Apple DTS).

**Still NOT VERIFIED:** `sudo installer -pkg` on an unsigned pkg — the subagent hit
no-passwordless-sudo and correctly declined to prompt the owner.

**Unchanged:** GO on the free Swift bundle; NO-GO on the $99, now better supported; Swift with Go
as runner-up; BTM verdict, including the disagreement with T3.

### T3 — Agent lifecycle and operability
*Detail: [`tracks/T3-lifecycle-operability.md`](./tracks/T3-lifecycle-operability.md)*

**Status:** ✅ complete — 1111 lines, 57 cited sources.

**Recommended update mechanism.** A signed + notarized `.pkg` published to GitHub Releases
by a `macos-26` GitHub Actions runner, pulled by a small Developer-ID-signed **supervisor**
daemon that polls the control plane for a version pinned in the existing GitOps repo — so
**Argo CD reconciles the agent version exactly as it reconciles a container tag, and
`git revert` is the rollback.** Runner-up: Munki.

**Recommended secret storage.** A one-time enrolment token at install, exchanged for a
rotating agent credential at `/usr/local/etc/homeparentcontrol/credential.json`,
`0600 root:wheel`, rotated at T-7 days with a 24 h server-side overlap, atomic `rename(2)`
writes. Explicitly **not** the System keychain — it does work for a root daemon without a
GUI unlock, but any admin can read it anyway, so the security delta is ~zero for real
operability cost.

| # | Finding | Consequence |
|---|---|---|
| 1 | **macOS 26 Background Task Management gates LaunchDaemons by their *entry point*.** A plist invoking `/bin/sh` or a bare script is attributed to an "unidentified developer" and can be left disallowed after reboot | ⚠️ **Eliminates shell and Python as the agent language** — it must compile to a Developer-ID-signable binary (Swift or Go). Effectively settles **O.3**: buy the $99/yr account. **May contradict POC 1** — see §7 |
| 2 | **`.pkg` installers cannot downgrade** — Munki documents this as unsupported; every pkg rollback story in the wild is really "republish the old version under a higher number" | Rollback must be a versioned directory plus an atomic symlink flip, not an install. This is what knocks Munki out of first place despite it being the proven non-MDM answer |
| 3 | **If enforcement is `shutdown`, every remote recovery path evaporates** — you cannot SSH into a machine that is off | A new and independent argument for `lock`, feeding **D.3** on *operability* grounds rather than POC 1's data-loss grounds. Related: the agent must never be able to disable Remote Login or lock out the parent's admin account, **by construction** |
| 4 | `installer -pkg` run as root **bypasses Gatekeeper** | The supervisor must verify `pkgutil --check-signature` plus a pinned SHA-256 itself; it cannot rely on the OS to do it |
| 5 | Population-based staged rollout is meaningless at n=1 | The n=1 form is **shadow mode**: a new version runs the full tick loop non-enforcing for ≥24 h and ≥1 bedtime window, diffing its decisions against the outgoing version, auto-promoted only on zero unexplained divergence. Directly answers POC 1 §5.3 — *"both bugs were in the enforcement path, and the dry-run suite caught neither"* |

**Biggest operability risk.** The supervisor is the one component that cannot be rolled back
in place. If a bad supervisor ships, remote manageability is lost entirely and recovery is
physical. Mitigated by keeping it ~300 lines, enforcement-logic-free, and **never
self-updating** — supervisor bumps are attended, a couple of times a year.

**On O.1.** T3 recommends failing **open** on infrastructure failure and **closed** only on a
deliberate, validated, fresh policy. *Deliberately withheld from T4 rather than forwarded —
independent convergence would be evidence; agreement-by-suggestion would not be.*

⚠️ **Handed to T1 as T1.8:** confirm the BTM disposition of a pkg-installed signed daemon
survives both a reboot **and** a version update, via `sudo sfltool dumpbtm`. Requires sudo —
**owner must run this.**

### T4 — Agent ↔ control plane contract
*Detail: [`tracks/T4-contract.md`](./tracks/T4-contract.md)*

**Status:** ✅ complete — 1,765 lines: endpoints with working JSON, a 32-row failure matrix,
an ASCII traffic diagram, and a 28-entry decisions register.

**Auth.** A one-time enrolment code exchanged for one durable **device-scoped bearer
credential**, stored as a better-auth API-key record; rotatable as desired state, one-click
revocable. mTLS is right at 100 devices, not at 1. The real control is **scope** — stolen,
the credential can only read its own bedtime and post its own telemetry. *Made boring to
steal rather than hard to steal*, which is the correct posture under **AR.1**, since nothing
resists an admin child anyway.

**O.1 — fail-open vs fail-closed: SETTLED by independent convergence** (see §5).

> **Fail-open on ignorance, fail-closed on knowledge.** Cannot determine the rules → do not
> lock, and alert within one tick. Knows the rules but cannot reach the server → enforce as
> written, indefinitely.

Reasoning: harm is asymmetric *and so is recovery*. A wrongful 19:00 lockout has no in-band
fix and gets the system uninstalled; an unearned hour is a conversation. Saltzer & Schroeder's
default-deny rests on open-failures being **silent** — T6's dead-man's switch removes that
premise. Child-reachable failures (network down) are already fail-closed, so the
learnable-bypass surface is nearly empty.

**H2 — polling survives; build no push.** Nothing needs unconditional sub-minute latency.
Adaptive cadence — 60 s, tightening to 15 s near a boundary and 5 s while a parent is in the
UI, server-driven via `next_poll_after_ms` — puts worst-case grant latency at **~5 s with zero
new components and no inbound port**. Apple's own MDM pushes only a content-free wake-up and
then polls; our agent is already awake.

| # | Most consequential decision | Why it matters |
|---|---|---|
| 1 | **Two LaunchDaemons — the enforcer opens no socket, ever** | "Works with the server down" becomes **structural**, not a code-quality promise |
| 2 | **Every relaxation carries a mandatory `expires_at`** | This is what makes "cached policy never expires" safe — staleness can only converge *stricter* |
| 3 | **The protocol has no "stop enforcing" verb** | Sole exception: an authenticated, parent-initiated `410` decommission |

**Cross-track adoption.** Adopted T6's heartbeat verbatim rather than specifying a parallel
one — and improved on it, moving telemetry off the tick to `POST /events`, since a
413/429/poisoned batch could otherwise make a live agent look silent. Dropped its own nine
states and thresholds for T6's five and 10 min/36 h. **No disagreement**, but two items
returned to T6: (a) the per-tick *status* block must stay on the tick, since `DEGRADED` is
computed from it and would become uncomputable exactly when telemetry is backed up;
(b) `SILENT_TOO_LONG` has no "parent already knows" exemption, so it would fire benignly
every school holiday and get muted — proposed a `devices.away_until` field.

Adopted T7's desired-state reconciliation **in full and deleted the command channel**: two of
five verbs were RPC dressing, and three were re-expressed as desired state with convergence
*observed* rather than acked — taking the retry/ack/expiry machinery with them.

**Safety by construction.** `shutdown` is now lock-then-shutdown after a 300 s grace. The
schema **cannot express** disabling Remote Login or changing admin accounts.
`device.system_boot_time` separates "the Mac was off" from "the Mac was up and the agent
wasn't", with no probe. `active_s` and `cpu_pct_avg` join `foreground_s`, with **`active_s`
named as the meter for D.4**.

⚠️ **Needs empirical work (V1–V9):** the 9-case **enforcement-isolation matrix** on the M4 is
the central unproven claim; plus whether launchd delivers SIGTERM on full shutdown, which
determines whether `EXPECTED_OFFLINE` can ever be asserted at shutdown.

### T5 — Control plane design
**Status:** ✅ complete — 2,347 lines. Copy-pasteable Drizzle TS for ~25 tables, a 28-row deltas
table, real storage arithmetic, 8 flagged conflicts. **Studied `homecal`, `homework`, `homenews`
and `arch-infra` source directly**, which changed several decisions.

**Core schema:** `household → child → policy_set → device`. Policy is authored **per child** and
compiled **per device** — that one indirection is what makes adding Mac #2 a five-second job
(**P2.4**). Authoring state is normalised (`schedule_windows`/`warnings`/`budgets`,
`calendar_exceptions`, `overrides`); the wire artefact is an immutable, content-addressed, signed
`policy_versions` row. Telemetry: raw `events` JSONB → scheduled projection → `usage_hourly` /
`usage_daily` / `session_spans` / `enforcement_log`. House conventions throughout (uuid PKs,
`postgres-js`, no `pgEnum`, `casing: snake_case`).

**Retention ladder:** raw `sample` 90 d → raw `audit` 400 d → `usage_hourly` 400 d →
`usage_daily` / `session_spans` / `enforcement_log` / `policy_versions` forever.
**Hard invariant: raw retention must exceed the agent's ~29-day queue**, or a long outage delivers
data that is pruned before it can be projected.

**Storage** (1 child, 1 Mac, 60 s tick): ~2,000 events/day × ~360 B = **720 KB/day · ~22 MB/month
raw**; rolled up **~0.35 MB/month** (62× compression); **~79 MB steady state after year 1, ~100 MB
after 5 years**; +68 MB per additional Mac. **The house chart's existing `5Gi` PVC is already
right** — no change needed.

| # | Most consequential decision | Why |
|---|---|---|
| 1 | **Calendar exceptions compile into `policy.overrides[]`** — a holiday *is* a bounded relaxation | Zero new agent capability, mandatory `expires_at` for free, visible in the audit trail. Combined with `overrides.expiresAt NOT NULL`, **a permanent relaxation becomes unrepresentable** — T4-D7 enforced as a database constraint rather than a convention |
| 2 | **Authoring/artefact split with content-addressed publish** | Signing re-serialised JSON signs nothing, and a JSONB blob has no invariants. The compiler is a pure function that emits nothing when the hash is unchanged — which is what stops a daily recompile churning the ETag |
| 3 | **`agent_status` is a Loki log line plus Postgres intervals**, not a row per device per minute — correcting T4 §9.3 | T6's LogQL alerts read a *stream*, so nothing changes there. The table drops 1,440 → ~8 rows/day and stops being the largest object in the database: **63 MB/yr → 0.5 MB** |

**Other findings worth carrying:**
- `apikeys.userId` is `NOT NULL ON DELETE CASCADE`, so **device keys must hang off a per-household
  `isService` user** (already a `homecal` field) — otherwise **deleting a parent silently revokes
  every Mac**.
- The house already solved the scheduler question: in-process `setInterval` + `replicaCount: 1` +
  `strategy: Recreate`.
- The **agent version pin folds into T4's `desired[]`** as `kind: "agent_version"`, from a third
  `helm.parameters` entry in `arch-infra` — zero new endpoints, zero template changes, and
  `git revert` is the rollback.
- ⚠️ **`bump-arch-infra` soft-skips with `exit 0`** when the PAT or Application CR is missing — so
  **an unwired GitOps chain looks like a green build**.

**Four cheap day-one verifications** in its §9 (casing × better-auth, the rate-limit carve-out, real
Loki stream labels, arch-infra wiring). **Nothing blocks starting the build.**

#### ⚙️ Conflicts T5 raises against earlier tracks

| # | Conflict | Resolution |
|---|---|---|
| **X1** | **T3's `enforcementEnabled: false` GitOps kill switch directly contradicts T4-D18's "no stop-enforcing verb".** Nobody had noticed | **T4 wins.** The legal form is a `suspend` override *with an expiry* |
| **X1b** | **T3 §3.3 says a 401/revocation *disables* enforcement; T4 §4.7 says it *continues*.** Opposite answers on a safety-critical path | **T4 wins** — T3's version makes credential revocation a bypass |
| **X1c** | ⚠️ **This document overstated the O.1 convergence.** See §5 | Corrected |
| **X2** | ⚠️ **Most dangerous.** T4 §6.4 recommends better-auth per-key rate limiting as a feature; **`homecal` disables it with a scar comment** — the 10 req/24 h default bricked their Kindle, and **it surfaces as 401, not 429**. Composed with T4's `401 → halt_sync_keep_enforcing`, **the agent would halt syncing ~10 min after enrolment, forever, reporting "credential revoked"** | Carve-out required. The same trap exists in the stock `/api/*` `hono-rate-limiter` |
| **X3** | **T8's `override.unmatched` mitigation cannot work with T8's own delivery** — it needs an issuance record, and the offline static card (and printed fallback) produce none *by construction* | Added `override_code_reveals` and a third verdict `no_reveal_record`; wording changed, since **a false accusation from a missing localStorage entry is worse than the forgery it guards** |
| **X4** | T4 says the credential travels "over TLS"; **the house ships plain HTTP** on Traefik `.arch.internal` — no `tls:` block anywhere | Acceptable under **AR.2**, but the sentence should not stand unexamined |
| **X5** | **T4 is internally inconsistent about `event_id`** — R8 says UUIDv7, the examples show Crockford ULIDs | Two spellings of the same 128 bits **silently defeat** the `UNIQUE(device_id, event_id)` idempotency key. Pick one |
| X6/X7 | `devices.away_until` (handed to T6, never answered — T6 finished first) **adopted**; T4 §10.5 **withdrawn** per C1 — no child-facing surface anywhere | Closed |

### T6 — Observability
*Detail: [`tracks/T6-observability.md`](./tracks/T6-observability.md)*

**Status:** ✅ complete.

**Recommended log path.** The agent writes structured JSON to stdout (launchd
`StandardOutPath` gives a local forensic tail) and POSTs batches to the control plane on
an endpoint *separate* from the policy tick; the control plane forwards to Loki.
**Nothing new runs on the child's Mac.**

**Recommended health design.** The tick *is* the heartbeat. The agent declares
`started` / `stopping{reason}` and persists a local `clean_exit` flag; the control plane
runs a five-state machine (HEALTHY / DEGRADED / EXPECTED_OFFLINE / UNEXPECTED_SILENCE /
SILENT_TOO_LONG) once a minute and emits `agent_status` — so Grafana alerts on a
**presence**, never an absence. Thresholds: 10 min unexplained silence, 36 h regardless.

| # | Finding | Consequence |
|---|---|---|
| 1 | Alloy **does** run on macOS — official `alloy-darwin-arm64.zip` (v1.19.2, 2026-08-26), Homebrew formula, launchd via `brew services`. But there is **no darwin log source** — no equivalent of `loki.source.journal` | Alloy would add a hop, not a capability: it could only tail a file the agent already wrote and forward it over a path the agent already has. **Rejected.** Promtail separately disqualified — **EOL 2026-03-02** |
| 2 | **macOS 26 redacts all dynamic log strings as `<private>` by default** (confirmed in the wild, CPython #150644) | Rules out `os_log` / unified logging as the agent's emission path; the only workaround is a machine-wide unredaction profile. Use stdout JSON, keeping one `%{public}s` breadcrumb at start/stop for system correlation |
| 3 | LogQL returns **no series** (not `0`) when nothing matches, so Grafana evaluates it as **No Data** and fires a synthetic `DatasourceNoData` alert that does **not** inherit notification policies or silences | The naive "alert when the heartbeat stops" rule fails silently — and you would discover it the first time it mattered. Fixed by alerting on the control plane's always-alive stream plus `or vector(0)` |
| 4 | Loki's out-of-order window (`max_chunk_age/2`, default 1 h) | After any outage longer than an hour, store-and-forward silently loses lines unless the forwarder **rewrites timestamps rather than dropping them** |
| 5 | A Bonjour Sleep Proxy answers ARP for sleeping Macs *without waking them*, and "Wake for network access" means a probe may wake the machine | **Do not** ICMP-probe the Mac to disambiguate offline states — it both lies and may wake her Mac at 3am |

**No Prometheus for the agent.** n=1; everything worth measuring already rides in the
heartbeat line; pull-based scraping is the wrong shape for an agent-initiated topology;
and Pushgateway is actively harmful for liveness, since it serves stale values forever.
Dashboard is six panels, of which the 7-day **state timeline** is the one that earns its
place.

**Cross-track.** Answers **T4.5** — T4 should adopt this heartbeat rather than specify a
parallel one. Feeds **T2.1** — the agent language must support `IORegisterForSystemPower`,
which is straightforward in Swift/Go/C and awkward in bash.

⚠️ **Deferred — needs cluster access.** 11 items. Highest priority: confirm a Grafana
contact point exists and a test notification *actually reaches the parent's phone*
(**the entire design is inert otherwise**), and whether the existing Alloy DaemonSet
already scrapes pod stdout cluster-wide — if it does, the control plane needs zero
Loki-specific code. Plus 6 Mac-side items runnable now without the cluster; the
consequential one is **whether launchd reliably delivers SIGTERM on system shutdown**
rather than only on `launchctl unload`, since `EXPECTED_OFFLINE` depends on it.

### T7 — Prior art and the native layer
*Detail: [`tracks/T7-prior-art-screentime.md`](./tracks/T7-prior-art-screentime.md)*

**Status:** ✅ complete — 572 lines, sourced and confidence-tagged.

> ⚠️ **macOS 27 "Golden Gate" shipped 2026-09-14 — four days before this research, with a
> rewritten Screen Time.** This round's macOS 26 assumption is already stale. Corroborated by
> a Hammerspoon issue filed *on the release date* reporting the CGSession path gone.
> **Action: pin the target Mac to 26.x and re-test every enforcement primitive before
> accepting the upgrade.**

**Can Screen Time power off a Mac? NO — POC 1's claim VERIFIED (high confidence).** Apple's
own Downtime documentation describes only a message plus an optional app-level block;
macOS 27's strongest new remote control is "pause access to a device", and Apple explicitly
leaves Always Allowed apps running during a pause. The decisive tell: Apple put
`ShutDownDevice` in the **MDM** protocol, not in Screen Time. Screen Time also cannot lock,
log out, sleep, export data, fire webhooks, or run custom actions on limit-hit.

**Prior art — borrow from:**

| Project | Borrow |
|---|---|
| **Fleet / Orbit** (fleetdm) | The agent-ops blueprint: supervisor + worker split, enrolment secret wiped off disk into the Keychain post-enrolment, pinned update channels (never `:latest`), first-class self-signed-CA support |
| **mac-screentime-enforcer** (hselomein) | Architecturally the nearest neighbour: a **retained desired-state flag reconciled continuously rather than RPC**, heartbeat as a tamper signal, lock→logout→shutdown escalation ladder |
| **PlayCap** (paddler) | Root LaunchDaemon that gates time accounting on **CPU activity**, so an idle background process doesn't burn budget. Rated the best single idea in the survey |
| *SelfControl* (hon. mention) | Root-owned state with the GUI as a pure view — tamper resistance by construction |

**Run Screen Time in parallel? YES — POC 1's instinct is sound**, under four conditions:
(1) the daemon owns the clock — set Screen Time's Downtime deliberately *wider* so the layers
never double-warn; (2) a clean domain split — Screen Time takes web filtering, communication
limits and Ask-to-Buy, none of which you can build; the daemon takes budget, lock/logout/
shutdown and telemetry; (3) exactly one Parent/Guardian controller, since two causes
documented conflicts; (4) the daemon must never read or write Screen Time state. They do not
contend, because Screen Time has no power surface at all.

**Contradicts or qualifies POC 1:**

| # | Finding | Consequence |
|---|---|---|
| 1 | **`ScreenSaverEngine.app` is the next `CGSession`, not a safe replacement** — the same class of undocumented internal artefact | Ship **two independent lock paths** plus a boot-time self-test. POC 1 replaced one undocumented dependency with another and treated the problem as closed |
| 2 | **A bash LaunchDaemon cannot hold a durable TCC grant.** TCC binds to *code identity*; subprocesses do not inherit it; grants silently detach on update | For any telemetry beyond bundle-ID + CPU, a signed notarized bundle with a fixed bundle ID and Team ID is mandatory. **Converges independently with T3's BTM finding** — see §5 |
| 3 | Window titles need **Screen Recording**, not Accessibility — and it **fails silently**, returning degraded data with no prompt and no error | A whole class of telemetry can appear to work while quietly returning nothing useful |
| 4 | **macOS 26.3 vaulted `RMAdminStore-*` and DeviceActivity captures beyond Full Disk Access** — EPERM even *with* FDA. `knowledgeC.db` and Biome still readable on 26.x, unverified on 27 | **Do not build telemetry on Apple's data.** The trend is one-directional |
| 5 | **FamilyControls / ManagedSettings / DeviceActivity do not exist on macOS** — iOS/iPadOS/Mac Catalyst only; an Apple engineer states flatly they "only work on iOS and iPadOS", and Catalyst fails at runtime | There is no supported API on macOS. The custom daemon is not a workaround — it is **the only mechanism** |
| 6 | Power-off is **not** uniquely a custom-daemon capability — MDM `ShutDownDevice` works on macOS 10.13+, and `pmset repeat shutdown` exists | The daemon is still right, but for a *different reason* than POC 1 gave: the APNs-cert barrier blocks self-hosted MDM for an individual (~$300/yr Enterprise Program; mdmcert.download legally dubious per MicroMDM's own docs). Worth 30 min to confirm before committing |
| 7 | Screen Time is genuinely unreliable — a documented 30–60 s post-restart bypass window, silent sync failures, 5–10 min remote-change latency with a "never" tail, plus live bypasses (Spotlight preview, `LSUIElement`/`setActivationPolicy`, Chrome, system-clock change) | A good backstop, **not a trustworthy one.** Reinforces condition (1) above |


### T8 — Parent override
*Detail: [`tracks/T8-parent-override.md`](./tracks/T8-parent-override.md)*

**Status:** ✅ complete — 1,168 lines, 19 sources. *Verified by reading SDK headers and
`swiftc -typecheck` (emits no binary, executes nothing) — **no dialog displayed, no consent
prompt triggered**.*

**T8.1 — `CFUserNotification` text input: ✅ VERIFIED YES.** Up to **8 text fields**, each
independently maskable via `CFUserNotificationSecureTextField(i)` (bits 16–23; bit 24 begins popup
selection). Read from **both the macOS 26.5 and 27.0 SDK headers on this machine — byte-identical**,
so macOS 27 changes nothing here.

> ⚠️ **Critical catch:** `CFUserNotificationDisplayAlert` **cannot** do it — it takes no dictionary
> parameter. The working path is `CFUserNotificationCreate` + `ReceiveResponse` + `GetResponseValue`.
> Type-checks against `arm64-apple-macosx26.0`; the only wrinkle is that `SInt32` does not exist in
> Swift — use `Int32`.

**Recommended mechanism:** a two-stage prompt on the **existing** warning dialog — a "Parent
override" button in the alternate slot, opening a separate code dialog — plus one grace prompt per
window on first unlock after the lock fires. **Zero new surface**, which was the hoped-for answer.

**Recommended code scheme:** RFC 4226 **HOTP with a structured counter** —
`HMAC-SHA256(K_ovr, device‖day‖minutes‖seq)` truncated to **6 digits**, accepting day ±1.
**The duration is encoded *inside* the code**: the agent infers grant size from which of 27
candidates matched, so nothing extra is typed **and a 15-minute code cannot be replayed as a
60-minute one**. TOTP rejected — no duration binding, a 30-second step is unusable read aloud, and
the worst clock story.

| # | Most consequential decision | Why |
|---|---|---|
| 1 | **Union, never replace** — effective overrides = `policy.overrides[] ∪ local grants` | Without it a policy refresh silently cancels a just-redeemed offline grant — **and only when the network recovers**, making it maximally confusing to diagnose |
| 2 | **The offline card is static HTML saved to the parent's phone** (WebCrypto HMAC) | The parent UI runs on the cluster that is down. A server-rendered code does not solve the problem it exists for |
| 3 | **A late grant does not unlock the Mac** | Apple DTS is explicit that no third-party code can draw over the lock screen. The enforcer simply stops re-locking; she logs in herself in ~5 s |

**Honest security limit.** She can `sudo cat /var/db/homeparentcontrol/override.key` and mint codes
forever. **Unfixable** — offline verification requires a local secret. But it is **not the weakest
link**: `sudo touch …/DISABLE` is a total bypass in one command. **AR.1 covers it**, because it
fails at `launchctl bootout` first. Mitigation is server-side reconciliation raising
`override.unmatched` — *"she used a code you never issued"* — making misuse **visible rather than
prevented**, consistent with this project's stated posture.

**Ship both; (b) first** — ~1 day, **zero new contract primitives** (`policy.overrides[]` already
exists; the only new field is `granted_via`). The offline code path is ~3–4 days and depends on
V-T8.1.

⚠️ **NEW TOP BLOCKING TEST — V-T8.1 (15 min on the Mac mini).** The entire override surface rests on
`CFUserNotification` **never once having been observed working from a daemon in this project** — and
there is an unanswered Apple forum report of it failing on Big Sur, *the same evidence pattern T2
used to doubt `osascript`*. Unlike the warning path, **the override path has no fallback surface.**

### ⚙️ Corrections T8 raises against earlier tracks

| # | Conflict | Action |
|---|---|---|
| **C1** | **T4 §10.5 must be withdrawn.** It designs an "Ask for more time" child→parent request button — which **P1.5 explicitly forbids**. A timing artefact: P1.5 was added the same day T4 reported | **Withdraw T4 §10.5.** T4's H2/polling verdict is unaffected |
| **C2** | **T3 §5.6 Tier-1 rationale contradicts AR.1.** It justifies the kill-switch file as parent-only *because the child is non-admin* — **she has admin** | Correct the rationale; harden the control: alert on the file's appearance, default it time-boxed |
| **C3** | **T4-D17 as written fires its confirmation guard on every grant**, training the parent to click through it | Guard **tightenings** only; revocations stay guarded |
| **C4** | **New argument for D.3 → `lock`:** a late override is *meaningless* under `shutdown` — the Mac is off, there is no screen to prompt on | Product-function argument, distinct from T7's and T3's. **Four independent arguments now favour `lock`** |
| **C5** | The override surface depends entirely on an unverified `CFUserNotification` daemon path | Promoted to **V-T8.1**, the top blocking test |

---

## 4. Workflow and traffic

Full endpoint definitions, JSON shapes and the 32-row failure matrix are in
[`tracks/T4-contract.md`](./tracks/T4-contract.md). The shape:

```
  Parent's device                      k3s  (aaron-desktop-arch)
  ┌──────────┐                         ┌─────────────────────────┐
  │  browser   │──── HTTPS (LAN) ─────▶│  Next.js  web           │
  └──────────┘                         │  Hono     API ───┐       │
                                     │  Postgres  ◀────┘       │
    Grafana ◀── Loki ◀── forwarded ──┤  (events are Postgres-  │
                                     │   authoritative)        │
                                     └───────────▲────────────┘
                                                 │  agent-initiated ONLY
                                                 │  no inbound port, ever
   Kid's Mac mini (M4)                           │
  ┌──────────────────────────────────────┴──────────────────┐
  │  syncd     (LaunchDaemon)                                    │
  │    │  GET /policy   → desired state + next_poll_after_ms      │
  │    │  POST /events  → telemetry, off the tick, queued if down │
  │    ▼  writes cached policy  (root:wheel, expires_at required) │
  │  enforcerd (LaunchDaemon)   ── NEVER opens a socket ──        │
  │    ├─ warn:  CFUserNotification   (Focus-proof, free, free)  │
  │    └─ act:   lock → [300 s grace] → shutdown                 │
  └───────────────────────────────────────────────────────┘
```

**The load-bearing property:** `enforcerd` has no network code at all. Server down, LAN down,
credential revoked — bedtime still happens, because nothing in the enforcement path *can* block on
the network. `syncd` failing degrades reporting and rule updates, never enforcement.

---

## 5. Hypotheses — confirmed or refuted

| | Hypothesis | Verdict |
|---|---|---|
| **H1** | The agent should not care whether its control plane is on `localhost` or in the cluster | → **supported by construction.** T4's enforcer never touches the network at all, so the control plane's location is a config value for the sync daemon alone. Not separately stress-tested |
| **H2** | Polling beats pushing here | ✅ **CONFIRMED.** T4: build no push. Adaptive cadence reaches ~5 s worst-case grant latency with no new components and no inbound port |
| **H3** | Telemetry splits at the TCC line — app-level free, titles/URLs gated | ✅ **CONFIRMED with refinement** (T1, live). *Three* tiers, not two: free (app/CPU/idle/power) → Screen Recording (titles) → per-browser Automation (URLs) → FDA (Apple's own data) |
| **H4** | 80/20 risk — the control plane is a standard `home*` app; the novelty is the agent | ✅ **CONFIRMED by T5.** The deltas fit one 28-row table; the house `5Gi` PVC, scheduler pattern and GitOps chain all carry over unchanged, and the agent version pin needed **zero new endpoints** |

### ⚠️ Convergent finding — two independent tracks, one conclusion

**T3** (via macOS 26 Background Task Management, which gates daemons by their *entry point*)
and **T7** (via TCC, which binds grants to *code identity* and silently detaches them on
update) reached the same conclusion by completely different routes:

> **The agent cannot be a bash script. It must be a signed, notarized binary with a stable
> bundle ID and Team ID.**

> ❌ **REFUTED BY DIRECT TEST, 2026-09-18.** See §2 #14. A bash-entry-point LaunchDaemon and an
> ad-hoc Mach-O one were installed side by side and rebooted. **Both came back
> `[enabled, allowed, notified]` and both ran.** BTM *attributes* them to "Unknown Developer" and
> *notifies* the user — it does not disallow them.
>
> **This is the round's most important correction.** Three tracks agreed, two of them citing Apple
> documentation and DTS guidance, and they were **collectively wrong about the consequence**. The
> lesson is the same one the `ncprefs` episode taught (§7.7): *agreement between tracks reading
> documentation is not evidence; only the reboot was.*
>
> **What survives:** BTM attribution is real, and the user **is** notified that a background item
> was added — acceptable here under **AR.3** (secrecy was never a requirement), but it is visible.
> TCC binding to code identity (§2 #1, T1) also stands — but the **free telemetry tier needs no
> TCC grants at all**, so it forces nothing either.
>
> **Net effect: Swift drops from a hard constraint to an engineering preference.** Bash is viable
> end to end for the free-tier product — banners (§2 #13), modal dialogs (POC 1), text entry via
> `osascript display dialog … default answer`, enforcement (POC 1), and clean shutdown (§2 #15/#16)
> are all available to it. **POC 1's deliverable is not invalidated.**

### ⚠️ Partial convergence — fail-open vs. fail-closed (O.1)

T3 and T4 reached the same answer on the **core** of O.1 under controlled conditions: T3 reported
first, and its recommendation was **deliberately withheld from T4** so T4 would reason from scratch.

| Track | Formulation |
|---|---|
| **T3** | Fail **open** on infrastructure failure; fail **closed** only on a deliberate, validated, fresh policy |
| **T4** | Fail-open on **ignorance**, fail-closed on **knowledge** |

> ⚠️ **Correction (X1c, raised by T5).** An earlier version of this document called this a clean
> convergence. **That overstated it.** The two tracks agree on the principle but answer the
> **policy-staleness** sub-question **oppositely**: T3 would stop enforcing once a cached policy
> passes its TTL; T4 says that is a **remotely-triggerable bypass** — anyone who can keep the agent
> offline long enough wins — and answers *"Never."*
>
> **T4 wins**, for the same reason it wins X1 and X1b: any rule that stops enforcement on a
> *failure condition* hands the child a lever. The core of O.1 is settled; **the staleness
> sub-question was adjudicated, not converged.**

### 🔬 Audit of documentation-derived claims (2026-09-18)

After three confident findings fell to direct testing, the remaining load-bearing
documentation-only claims were audited. **The hit rate is itself the finding.**

| Claim | Source | Result |
|---|---|---|
| `ncprefs` shows no registration ⇒ banners dead | T2 inference | ❌ **Refuted** (§2 #13) |
| BTM leaves script/ad-hoc daemons disallowed | T3 + T2 (Apple DTS) + T1 | ❌ **Refuted** (§2 #14) |
| `os_log` redacts dynamic strings as `<private>` | T6, cited CPython issue | ⚠️ **Conclusion right, reason wrong** (§2 #17) |
| `.pkg` cannot downgrade | T3, Munki docs | ❌ **Refuted** (§2 #18) |
| TCC grants detach on update (ad-hoc) | T7, disputed by T2 | ✅ **Confirmed, and worse** (§2 #19) |
| Developer ID profile evaluated at every launch | T2, Apple docs | ⏸️ **Untestable here** — needs a paid cert. Remains documentation-only, **and it is the load-bearing argument for the $99 NO-GO** |

**Five of six were wrong, partly wrong, or unverifiable.** Every one was stated with confidence;
two had multi-track agreement; one cited Apple DTS directly.

> **Standing rule for this project:** a claim about *observable macOS behaviour* is not settled
> until it has been observed. Documentation and cross-agent agreement are hypotheses, not evidence.

### ⚠️ Unresolved inter-track disagreements

Recorded rather than smoothed over. Both need adjudication before the build starts.

| # | Disagreement | Status |
|---|---|---|
| 1 | **Is notarization needed?** T3 recommends a signed **and notarized** `.pkg`. T2 measured that nothing this project installs is ever quarantined, so Gatekeeper never assesses it and notarization is moot | → **largely reconciled by T2's addendum.** Notarization is unnecessary *conditional on deployment hygiene*: ship via tarball or rsync (never `.zip`, which **does** propagate quarantine), and verify `xattr -r` post-deploy. Absent that hygiene a quarantined non-notarized Mach-O is **SIGKILLed silently**. So notarization is insurance against an ops mistake, not a requirement — T3's instinct was defensible, T2's measurement is right |
| 2 | **Do TCC grants survive an agent update under ad-hoc signing?** T7 said grants detach on update; T2 said durable TCC identity does not require the paid program | ✅ **RESOLVED by T1 — in T7's favour, but it does not matter.** T1 verified that TCC binds to code identity and revokes on update when unsigned. **However**, the free telemetry tier requires *no TCC grants at all* — so if monitoring stays at the free tier the question is moot, and the $99 stays unnecessary. It only bites if the owner wants titles or URLs, in which case the $99 is required for TCC reasons independent of notifications |

---

## 6. Decisions unblocked

| # | Decision | Resolution |
|---|---|---|
| D.1 | Monitoring depth | ✅ **DECIDED 2026-09-18 — FREE TIER.** App identity + CPU-gated `active_s` + idle + power/session. No TCC grants, no $99, nothing breaks on agent update. Schema stays additive (P2.5) so richer tiers remain reachable later. *Evidence:* **a hard fork, per §2 #19.** *Free tier* needs **no TCC grants** — ad-hoc signing fine, **$0**. *Anything richer* needs a grant, and an ad-hoc grant **dies on every rebuild**, requiring a human to re-grant FDA on her Mac after each update — unworkable. **Richer monitoring therefore makes the $99 mandatory, for TCC reasons independent of notifications.** Originally:  *Free tier* (app + CPU-gated active time + idle + power) needs **zero grants and zero dollars**. *Anything richer* needs a signed notarized binary, a stable Team ID, pre-provisioned grants, **and** the $99/yr — for data Apple is progressively vaulting. **Owner's call** |
| D.2 | Reporting delivery | ⏸️ **Owner — still open.** Includes pull-vs-push for agent-death alerts (see needs P2.6). No mobile app either way |
| — | **Agent language** | ✅ **DECIDED 2026-09-18 — SWIFT** (Go runner-up). Not forced by the OS — §2 #14 refuted that — but chosen for direct `CFUserNotification` access, structured logging, typed policy handling, and a signed-binary path if D.1 is ever revisited. **Ad-hoc signed, $0.** Bash remains genuinely viable and POC 1 is not discarded |
| — | **Parent override delivery** | ✅ **DECIDED 2026-09-18 — ONLINE GRANT ONLY**, for now. One click in the parent UI, ~5 s via adaptive polling, zero new contract primitives (`policy.overrides[]` exists). **Offline HOTP card deferred**, not cancelled — T8's design stands if a real outage ever makes it bite. Saves ~3–4 days, the HOTP machinery, a shared secret on her Mac, and X3's reveal-record reconciliation |
| D.3 | Shutdown vs. lock | ✅ **DECIDED 2026-09-18 — LOCK → 300 s GRACE → SHUTDOWN.** Delivers the owner's original "machine is off" requirement while keeping a save-work window and a remote-recovery window. *Evidence:* **four independent arguments**: POC 1 (unsaved work), T3 (no SSH into a machine that is off), T4 (lock→300 s grace→shutdown captures both), T8/C4 (a late override is meaningless — no screen to prompt on). **Formally the owner's call** |
| D.4 | Bedtime window vs. daily budget | Unblocked mechanically — T4 adds `active_s` (CPU-gated active time, per T7/PlayCap) as the meter a budget would be measured in. Owner's call remains |
| O.1 | Fail-open vs. fail-closed | ✅ **SETTLED** — fail-open on ignorance, fail-closed on knowledge. T3+T4 converged on the principle; the **staleness sub-question was adjudicated, not converged** (T4 wins — a TTL is a remotely-triggerable bypass). See X1c |
| O.2 | Access from away from home | _owner_ |
| O.3 | Paid Apple Developer account | ✅ **SETTLED — NO-GO**, now on two grounds: the original notification argument, **and** D.1's free-tier decision removing the TCC requirement (§2 #19). Ad-hoc signing throughout. ⚠️ *Note the profile-expiry argument below remains untested — see the §5 audit.* Originally: ⛔ **NO-GO for now** (T2). Buys only Time Sensitive, which the child can revoke in two clicks and no profile can force back. T3's BTM argument does **not** carry it — BTM needs a Mach-O, not a Developer ID. **Hardened by the addendum: the cost is recurring and lapsing breaks the app** — a Developer ID provisioning profile is evaluated at every launch, so a missed renewal silently kills the warnings. Reversible later. **Flips to GO only if the ad-hoc-daemon reboot test shows `disallowed`**, and even then needs a calendar alarm plus `CFUserNotification` retained as the lapse fallback |
| O.4 | Timeline | _owner_ |

---

## 7. Honest limits

1. **Everything empirical is macOS 26.6.2.** macOS 27 shipped four days before this research and is
   untested. The version-fragile items are **TCC reach, `CGWindowList` redaction, and BTM
   disposition** — precisely the three that carry the round's main conclusions.
2. **No cluster access throughout.** Eleven of T6's verifications are deferred, including whether
   alerting actually reaches a phone — without which the entire health design is inert.
3. **The BTM disposition was never observed directly.** It is confirmed from Apple DTS guidance and
   consistent across three tracks, but the `sfltool` store needs sudo and was correctly not run.
4. **T4's contract is unbuilt.** The 9-case enforcement-isolation matrix is its central unproven
   claim.
5. **T2's launch-dependent Gatekeeper claims were downgraded** to researched-not-verified after its
   subagent's tests put malware dialogs on the owner's screen and were stopped.
6. **`sudo installer -pkg` on an unsigned pkg: not verified** — blocked on passwordless sudo.
7. ✅ **RESOLVED 2026-09-18 — in POC 1's favour.** The owner observed the `osascript` banner
   **and** the `CFUserNotification` dialog display, in the same test. **T2's inference was wrong.**

   ⚠️ **The methodological lesson outlives the result.** T2 reasoned that zero `ScriptEditor2`
   entries in `com.apple.ncprefs` (against 79 registered apps) meant the path was dead. **It fires
   anyway.** An absent registration record is not evidence of an absent capability — and that same
   inference pattern is cited elsewhere in this round. Treat any conclusion in these documents that
   rests on *"the registry doesn't list it"* as unproven until observed.

   **Consequence:** POC 1's warning design survives intact — banners for the gentle T-30/15/5
   nudges, `CFUserNotification` for the final warning and the override prompt. The Swift `.app`
   with `UNUserNotificationCenter` drops from *necessary* to *optional polish* (nicer attribution
   than "Script Editor", custom icon, notification actions). BTM and TCC still require the
   **daemon** to be a signed Mach-O — that is unchanged and independent of the notifier.
8. **T5 was never run**, by design. See §3.

---

## 8. What remains

**No further research round is warranted.** The remaining work is empirical, design, or the
owner's to decide. Manufacturing another fan-out would produce restatement, not evidence.

### A — Owner's hands · ~1 hour · unblocks the most

| # | Test | Unblocks |
|---|---|---|
| ~~A0~~ | ~~`CFUserNotification` from a root daemon~~ | ✅ **DONE 2026-09-18.** `rc=0 button=0 text="1234"` via the `asuser` bridge. The override path works |
| ~~A1~~ | ~~`sfltool dumpbtm`~~ | ✅ **DONE — and it REFUTED the claim.** See §2 #14 |
| ~~A2~~ | ~~`osascript` banner~~ | ✅ **DONE 2026-09-18 — the banner WORKS.** POC 1 vindicated, T2's inference refuted. See §2 #13 |
| A3 | Check the Mac mini's auto-update setting; **pin to 26.x** | Prevents macOS 27 silently breaking enforcement |
| A4 | *Only if URL-tier monitoring is wanted:* `osascript -e 'tell application "Google Chrome" to get URL of active tab of front window'` — pops per-browser Automation consent | D.1's upper tier |

### B — Needs a throwaway test daemon

- **B1** Install a trivial **ad-hoc Mach-O** LaunchDaemon, reboot, re-run A1. **If `disallowed`,
  the $99 go/no-go flips to GO** — the single highest-value open test in the round.
- **B2** T4's 9-case **enforcement-isolation matrix** (V1–V9).
- **B3** Does launchd deliver SIGTERM on *full shutdown*, not just `launchctl unload`? Apple
  documents yes (T2); `EXPECTED_OFFLINE` depends on it.

### C — Needs cluster access

T6's 11 items. Priority: **confirm a Grafana contact point exists and a test notification actually
reaches the parent's phone** (the design is inert otherwise), and whether the existing Alloy
DaemonSet already scrapes pod stdout cluster-wide — if it does, the control plane needs **zero**
Loki-specific code.

### D — Design ✅ complete

**T5 delivered** — schema, retention ladder, storage arithmetic, enrolment flow, deltas table.
**Nothing blocks starting the build.** Four cheap day-one verifications sit in T5 §9, and eight
cross-track conflicts (X1–X7, above) must be applied to the design before coding.

### E — Owner's decisions, no research needed

| # | Decision | State of the evidence |
|---|---|---|
| D.1 | Monitoring depth | Clean either/or: free tier (zero grants, zero dollars) vs. richer (signed binary + Team ID + $99, for data Apple is vaulting) |
| D.2 | Reporting delivery | Transport exists; payload is yours |
| D.3 | Shutdown vs. lock | **Four independent arguments now favour `lock`**: POC 1 (unsaved work), T3 (no SSH into a machine that is off), T4 (lock→300 s grace→shutdown captures both), **T8/C4 (a late override is meaningless under `shutdown` — no screen to prompt on)** |
| D.4 | Bedtime vs. budget | Mechanically unblocked — `active_s` is the meter |
| O.2 | Access from away from home | Never answered; both shapes are LAN-scoped |
| O.4 | Timeline | Never answered |

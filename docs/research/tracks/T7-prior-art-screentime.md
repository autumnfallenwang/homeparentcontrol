# T7 — Prior Art and the Native Apple Layer

**Research track:** T7 (`homeparentcontrol`)
**Date of research:** 2026-09-18
**Researcher:** automated research agent, all claims web-verified on the date above
**Target platform assumed by the brief:** Mac mini, Apple Silicon, macOS 26 (Tahoe)

## Confidence legend

Every material claim below is tagged.

- **[VERIFIED-PRIMARY]** — confirmed against Apple's own documentation, Apple Newsroom, or an Apple engineer post.
- **[VERIFIED-SECONDARY]** — confirmed against a dated, credible third-party source published 2025-08 or later.
- **[INFERRED]** — my reasoning from verified facts; not directly stated by a source.
- **[STALE-RISK]** — the best available source predates macOS 26, or the claim is the kind of thing that the `CGSession` precedent says goes rotten. Re-test on the actual machine before depending on it.
- **[NEGATIVE-EVIDENCE]** — claim of absence. Supported by exhaustive search of Apple's docs turning up nothing, not by a positive Apple statement. Weaker, but stated explicitly so you can weigh it.

---

## 0. READ THIS FIRST — the brief's platform assumption is already out of date

**macOS 27 "Golden Gate" was released on 2026-09-14 — four days ago.** [VERIFIED-SECONDARY]

- Announced 2026-06-08 at WWDC 2026; released 2026-09-14.
  <https://www.macrumors.com/2026/09/10/macos-27-golden-gate-release-date/>, <https://www.macrumors.com/roundup/macos-27/>
- **Golden Gate drops all Intel support** — Apple Silicon only. The Mac mini in question is fine hardware-wise, which means *it will be offered the upgrade*.
- **Screen Time was rebuilt in macOS 27**, with what Apple describes as "a new architecture that... makes parental controls sync more quickly across devices in a Family Sharing group."
  <https://9to5mac.com/2026/09/14/heres-whats-new-with-parental-control-features-in-ios-27-ipados-27-and-macos-27/> (2026-09-14)
- Apple Newsroom shipped the child-safety feature set the same day.
  <https://www.apple.com/newsroom/2026/09/apples-new-child-safety-features-now-available/> (2026-09-14)

**Why this matters more than anything else in this document:** the whole enforcement surface the POC validated (`osascript`, `ScreenSaverEngine.app`, `shutdown`) was validated on macOS 26. A major-version bump is exactly the event that killed `CGSession`. And there is already a dated data point: a Hammerspoon issue filed **2026-09-14 — the macOS 27 release date** — reports `hs.power.lockScreen` failing because the bundled `CGSession` path "does not exist on this system." [VERIFIED-SECONDARY] <https://github.com/cmsj/Hammerspoon2/issues/224>

**Recommendations arising:**
1. Pin the child's Mac to macOS 26.x and **defer the 27 upgrade deliberately** until the enforcement primitives are re-tested. (An MDM enrollment gives you a supported way to defer — see §2.6.)
2. Treat "re-test all enforcement primitives on every major macOS release" as a permanent, scheduled operational task in the design, not a one-off.
3. If you *do* go to macOS 27, note the Screen Time story materially improves there (Time Allowances, pause-device, faster sync) — which changes the coexistence calculus in §2.7.

Note also: the Apple support page for "Manage downtime in Screen Time on Mac" now carries a **macOS 27** version selector, while the macOS 26 (Tahoe) variant is still served at the regional URLs. When reading Apple support docs, always check the version selector — Apple silently re-versions these pages and it is a prime source of the confident-but-outdated answer this track is supposed to guard against.

---

# T7.1 — Prior art: what to borrow, what to avoid

## 1.1 Prior-art table

| Project | What it does | Approach | Maintained in 2026? | Borrow what? |
|---|---|---|---|---|
| **[PlayCap](https://github.com/paddler/playcap)** | Enforces per-app daily time limits on macOS (built for Roblox, generalises by process name) | Root **LaunchDaemon**, 30s tick, Swift + shell. `pgrep` by process name, **CPU-activity gating** so an idle tray process doesn't burn budget. Warns at 10/5/1 min, then kills the process. Parent changes gated by admin password. World-readable config, root-owned. macOS 14+. MIT. | **Yes — new, 2026.** Tiny (9 commits, ~0 stars), so treat as a design reference, not a dependency | **The CPU-activity gate** (idle process ≠ usage) — this is the single best idea in the whole survey and directly fixes a real accounting bug. Also the 10/5/1 warning ladder, the root-daemon + admin-password-for-changes split, and killing the *app* rather than the session as a gentler first escalation. |
| **[mac-screentime-enforcer](https://github.com/hselomein/mac-screentime-enforcer)** | Mac screen-time enforcement driven by Home Assistant | Python 3 + PyObjC **LaunchAgent** in the child's GUI session. Publishes minutes / active flag / heartbeat / active-app to **MQTT** with HA discovery; enforces a retained `allowed` flag from HA. Escalation ladder: **lock → logout (`osascript` / kill loginwindow) → shutdown** after repeated blocked relogin attempts in a rolling window. Needs Accessibility for `python3`. Child stays non-admin. Resets minutes at midnight. | **Yes — announced 2025-12, active 2026.** ~0 stars; personal project | **This is the closest existing thing to your architecture.** Borrow: the retained-flag control model (server publishes desired state, agent reconciles — no request/response, survives network partition); the **heartbeat sensor** as tamper/liveness signal; the **escalation ladder including shutdown**; and the "reset at midnight locally, but let the server wrap it in a daily utility meter" pattern for offline correctness. |
| **[screen-quota](https://github.com/mcevoypeter/screen-quota)** | Shuts the Mac down when a daily screen quota elapses | Swift menu-bar app. Stops counting while the machine is asleep, so it counts *active* time. 10-min and 1-min warnings, then shutdown. Bazel + `just`. | **Yes — updated 2026-04**, but 1 commit / 0 stars. Effectively a sketch | Confirms the shutdown-as-terminal-action design is a thing other people independently arrive at. Borrow the sleep-aware accounting. Do **not** borrow the menu-bar-app form factor — a user-session GUI app is trivially quit by the child. |
| **[SelfControl](https://github.com/SelfControlApp/selfcontrol)** | Blocks the user's own access to sites for a fixed period; **cannot be undone** by quitting, deleting the app, or rebooting | Root helper + firewall/hosts manipulation, with the block owned by a privileged component that outlives the GUI | **Long-lived, widely used.** The canonical "uninstall-resistant" open-source Mac tool | **The tamper-resistance model**: put the enforcement state and the timer in a root-owned component; make the GUI a *view*, not the authority; survive app deletion and reboot. This is the exact property your LaunchDaemon needs and SelfControl has ~15 years of field-testing on it. |
| **[Gate](https://github.com/Turnonac/screentime-app)** | iOS/macOS app-limiting via Apple's Screen Time API | Uses **FamilyControls / ManagedSettings / DeviceActivity** + a monitor extension. Explicitly ships with **no accounts, no server, no analytics** to keep App Privacy at "Data Not Collected" and stay under the 6 MB extension memory ceiling | Active 2026 | **Read it for the honest limitations write-up.** Its own README concedes a user can revoke its access in ~4 taps via Settings → Screen Time → Apps with Screen Time Access, "and every restriction lifts instantly." That is the ceiling of the sanctioned API on iOS — and a direct argument for why you are building a root daemon instead. Also note the **6 MB memory ceiling** on DeviceActivity extensions. |
| **[ActivityWatch](https://activitywatch.net/)** (`aw-server`, `aw-watcher-window`, `aw-watcher-afk`) | Self-hosted, local-first automatic time tracker: active app, window title, AFK, browser | Local HTTP server + pluggable "watcher" processes posting **buckets of events**. Data never leaves the device by default | **Yes — the reference project in this space** | **The bucket/event data model and the watcher plug-in split.** Separate "who observes" from "who stores" from "who decides." Your telemetry pipeline should look like this. Also borrow `aw-watcher-afk` — idle detection is a solved, separable problem. **See §1.3 for its permission bill, which is the load-bearing finding for the TCC track.** |
| **[nichtlegacy/screentime](https://github.com/nichtlegacy/screentime)** | Exports Apple Screen Time data from Mac + iOS to Home Assistant / InfluxDB / Grafana | Python 3.10+ reading `knowledgeC.db` directly; **requires Full Disk Access granted to Terminal.app**; dedupes on re-run. Documents Ventura / Sonoma / Sequoia. ~23 stars, 4 commits | Recent (2026 timestamps in examples) but thin, and **its stated macOS support stops before Tahoe 26** | The **dedupe-on-reimport** design (idempotent ingestion — run as often as you like). Borrow the concept, not the code: its FDA-to-Terminal instruction is the wrong shape for a daemon (see §1.4). |
| **[alexjmiller5/screentime-backup](https://github.com/alexjmiller5/screentime-backup)** | Weekly LaunchAgent backups of every macOS Screen Time database | Backs up `knowledgeC.db`, `RMAdminStore-{Local,Cloud}.sqlite`, a DeviceActivity capture tarball, and a subset of `~/Library/Biome/streams`. FDA granted to a **signed `.app` bundle** | New, 0 stars | **The single most valuable fact in this whole survey** (see §1.4) plus the correct FDA technique: grant FDA to a **signed app bundle**, because macOS grants FDA to *code identity*, not to a loose script. |
| **[osquery](https://github.com/osquery/osquery)** | SQL interface over OS state | Apache 2.0, under the **osquery Foundation inside the Linux Foundation**. Stable 5.23.1 shipped **2026-06-24** | **Yes — the most maintained thing in this document** | The **SQL-over-system-state** abstraction, and the scheduled-query + differential-results model (report only what changed). Even if you don't ship osquery, `SELECT * FROM <thing>` is the right mental model for "what does the agent report." |
| **[Fleet](https://fleetdm.com/) + `fleetd`/Orbit** | Self-hosted control plane for osquery + open-source MDM | Agent is **Orbit**, a supervising wrapper around osqueryd. **Enroll secret** at install; after enrollment the secret is **deleted from disk and moved into the macOS Keychain**. **Update channels** (`--orbit-channel`, `--osqueryd-channel`) drive self-update via TUF. `--fleet-url`, `--fleet-certificate` for self-signed TLS. MIT-licensed free tier, self-hostable, feature parity with cloud | **Yes, very** | **The operational blueprint for your agent.** Specifically: (1) bootstrap-secret → long-lived node key, then **wipe the bootstrap secret off disk into the Keychain**; (2) **update channels** instead of "latest", so you can pin the child's Mac to a known-good agent and promote deliberately; (3) first-class support for a **self-signed CA** so you don't need public TLS for a home lab; (4) a supervising wrapper process that owns restart/update of the worker. |
| **[Zentral](https://github.com/zentralopensource/zentral)** | Control plane for Apple endpoints: MDM + DDM, osquery remote, Santa allowlisting, event pipeline to Grafana | Every action — check-in, blocked binary — is an **Event** flowing through preprocessors → enrichers → workers → store. Desired state as code via GitOps/Terraform | **Yes — active 2026** | **The event-pipeline architecture**, and the "desired state as code" framing. Your control plane wants exactly this: rules are declarative config in git; everything the daemon does emits an event; dashboards are built on the event store, not on bespoke tables. Also the user-facing **approval portal** pattern (child requests, parent votes/approves, decision is persistent and audited) — that is your "can I have 20 more minutes" flow, already designed. |
| **[NanoMDM](https://github.com/micromdm/nanomdm)** / [MicroMDM](https://micromdm.io/) | Minimalist self-hosted Apple MDM server | NanoMDM: MIT, ~590 stars, stateless, pluggable storage, multi-APNs-topic. **MicroMDM v1 entered maintenance mode late 2025; NanoMDM is the successor.** Needs Linux/macOS server + MySQL/Postgres + an **APNs certificate from Apple** | **NanoMDM yes; MicroMDM maintenance-only** | **This is the sleeper option.** MDM gives you a *supported, Apple-blessed* `ShutDownDevice` command on macOS (§2.6) — the exact capability the POC built a custom daemon for. See §2.6 for the APNs-certificate catch, which is the reason this isn't a slam dunk. |
| **[Munki](https://github.com/munki/munki)** | Managed software installation for macOS | Root LaunchDaemon + periodic run, manifest/catalog pulled over **plain HTTPS from a static web server**. Client-driven, server is dumb | **Yes — the macadmins bedrock, 10+ years** | **"The server is a static file host."** Munki's longevity comes from the server being almost nothing — the client pulls a manifest and reconciles. If your k3s control plane goes down, the child's Mac should keep enforcing yesterday's cached rules. Design for that. |
| **[Nudge](https://github.com/macadmins/nudge)** | Nags users to install OS updates by a deadline | Swift 5.10, macOS 12+, escalating UI pressure, deadline-driven | **Yes — macadmins org** | The **escalating-nag ladder** (gentle → persistent → modal → blocking) as a humane alternative to going straight to a hard action. Directly applicable to your warn-then-lock flow. |
| **[Sal](https://github.com/salopensource/sal)** / MunkiReport | Reporting dashboards for Munki fleets | Client submits a report blob on each run; server renders; plugin system for extra facts | Sal: community forks active; MunkiReport: active | The **"agent posts a fat status blob each cycle, server does all presentation"** model. Much simpler than streaming telemetry and perfectly adequate at n=1 machine. |
| **[outset](https://github.com/macadmins/outset)** | Runs scripts at boot / login / once | Tiny, single-purpose LaunchDaemon+LaunchAgent pair | Yes — macadmins org | The **once/every-boot/every-login script directory convention.** Free structure for your agent's lifecycle hooks. |
| **[swiftDialog](https://github.com/swiftDialog/swiftDialog)** | Renders native macOS dialogs from a CLI/JSON | A signed, notarized GUI binary you invoke from a root script | Yes — macadmins org | **Replace `osascript display dialog` with this.** `osascript` from a root daemon into a user session is fragile and TCC-entangled (see §1.5). swiftDialog is the macadmins-standard answer to "root daemon needs to show the user something." |
| **[Santa](https://northpole.security/santa)** | Binary allowlisting/blocklisting for macOS | **Endpoint Security system extension** (post-kext), with a sync server protocol and MONITOR/LOCKDOWN modes | Yes — North Pole Security | The **MONITOR-then-LOCKDOWN rollout pattern**: run in observe-only, collect what actually happens, *then* enforce. Do this before you ever let your daemon shut the machine down. Also: it's the reference implementation of "a supported, non-kext way to see every process exec" if you ever need real app-launch telemetry. |
| **[Allow2](https://allow2.github.io/) / [Allow2iOS](https://github.com/Allow2/Allow2iOS)** | "Parental freedom" platform + device SDKs (iOS/macOS/tvOS/watchOS) | App-integrated SDK — apps voluntarily ask the service "may I?" | **Nominally — SDK updated 2026-03 — but ~13 stars and the macOS demo last touched 2018.** Effectively dormant | **Borrow the cautionary tale, not the code.** Consent-based enforcement (apps opt in to being limited) does not work when the subject is motivated. This is a decade-old project with no ecosystem. |
| **[K9 Web Protection (khaleel-git)](https://github.com/khaleel-git/K9-Web-Protection)** | OS-level adult-content blocking for Mac/Windows | Two independent layers: **hosts-file filter + local HTTPS proxy**. Works in all browsers incl. incognito | Recent revival of a dead commercial name | The **defence-in-depth layering** (two independent mechanisms, so one failing isn't total failure). Relevant if you add network filtering. Do not adopt the local-HTTPS-proxy approach casually — it means installing a root CA on the child's machine, which is its own security liability. |
| **[Timekpr-nExT](https://github.com/skaasjager/timekpr-next)** (Linux) | Mature Linux parental time-limit tool | Three-part split: **daemon** (enforce) / **client indicator** (inform user) / **admin GUI** (configure). Uses **logind**, deliberately *not* PAM | Yes, mature | **Design lessons paid for in blood by its predecessor.** Timekpr-Revived failed because of: daemon↔client desynchronisation; the user getting kicked at midnight while mid-task; no sleep support; no weekly/monthly allowance; and PAM integration that invasively rewrote the display-manager config. **Every one of those is a trap your design can hit.** See §1.6. |

---

## 1.2 Adjacent macOS device agents — the operational blueprint

Your daemon's *operational* problems (headless, phones home, self-updates, ships telemetry) are completely solved problems in the macadmins world. Do not reinvent them.

**The canonical shape, synthesised from Fleet/Orbit + Munki + Zentral:**

1. **Two processes, not one.** A supervisor (Orbit-style) that owns lifecycle, updates and restart; a worker that does the actual enforcement/telemetry. The supervisor is boring and rarely changes; the worker is where your logic lives and where you'll iterate. Only the supervisor needs to be bulletproof.
2. **Bootstrap secret → durable credential, then destroy the bootstrap.** Fleet installs with an enroll secret, exchanges it for a node key, and then **removes the enroll secret from the filesystem and stores it in the macOS Keychain**. At n=1 this is still worth doing: a world-readable `/Library/Application Support/.../config.json` containing your control-plane token is the obvious attack surface for a curious kid with admin-adjacent curiosity. [VERIFIED-SECONDARY] <https://fleetdm.com/guides/fleetd-authentication>
3. **Update channels, not `:latest`.** `--orbit-channel stable` / `--osqueryd-channel 5.23.1`. You want to be able to pin the child's machine to a known-good agent build and promote deliberately after testing, because a bad auto-update to an enforcement daemon is a self-inflicted outage on a machine you can't easily walk over to. [VERIFIED-SECONDARY] <https://fleetdm.com/docs/using-fleet/orbit>
4. **Plan for a self-signed CA.** Fleet ships `--fleet-certificate` specifically for servers with self-signed/otherwise-invalid TLS. Your k3s cluster is exactly this case. Pin your CA in the agent rather than disabling verification. [VERIFIED-SECONDARY]
5. **Cache the policy; reconcile against it offline.** Munki's durability comes from the server being a static file host and the client reconciling against a cached manifest. Your daemon must enforce *yesterday's* rules correctly when k3s is down, and it must **fail closed on time limits but fail open on hard shutdown** (an unreachable server should not spontaneously power the machine off).
6. **Retained desired-state flag, not commands.** `mac-screentime-enforcer`'s MQTT retained `allowed` flag is the right primitive: the server publishes *what should be true*; the agent reconciles continuously. A command-based design ("send a lock RPC") loses the command if the machine is asleep. A state-based design just converges when it wakes.
7. **Everything is an event.** Zentral's preprocessor→enricher→worker→store pipeline. One append-only event stream feeds dashboards, alerts and audit. Do not build bespoke tables per feature.
8. **Heartbeat as tamper signal.** `mac-screentime-enforcer` publishes a heartbeat. Missing heartbeat + machine reachable = someone unloaded your daemon. That's the alert you actually care about, and it's nearly free.

---

## 1.3 Self-hosted screen-time / activity tracking — and the exact permission bill

This is the section that feeds the parallel TCC-ceiling track. Be precise here, because "Accessibility" is commonly and wrongly cited as sufficient.

### What you can read without any TCC grant

- **Frontmost app bundle ID / process name / PID.** Available via `NSWorkspace.frontmostApplication` (in-session) or `lsappinfo` / `pgrep` from root. **No TCC prompt.** [VERIFIED-SECONDARY — this is what PlayCap does, root daemon, `pgrep` by process name, no Accessibility mentioned]
- **Process CPU time.** `ps`/`proc_pidinfo`. No TCC. This is what enables PlayCap's idle-gating trick.
- **Idle / AFK time.** `CGEventSourceSecondsSinceLastEventType(.hidSystemState, .anyInput)` — **no TCC grant required**, unlike most input observation. [STALE-RISK — verify on 26; ActivityWatch's `aw-watcher-afk` works on macOS without extra prompts, which is corroborating]

### What requires a TCC grant

| Data you want | Permission actually required | Notes |
|---|---|---|
| **Window titles of other apps** (`kCGWindowName` from `CGWindowListCopyWindowInfo`) | **Screen Recording**, *not* Accessibility | This is the most-misreported fact in the space. Since Catalina 10.15, "certain properties, most notably `kCGWindowName`, are only populated if your app has the Screen Recording privilege," and `CGWindowListCopyWindowInfo` **will not show a permission dialog** — it silently returns degraded data. **A missing Screen Recording grant looks exactly like "the app has no window title," not like an error.** [VERIFIED-SECONDARY] <https://gist.github.com/chockenberry/164ab2d3dd76736f81c9e9eed63d81bf>, <https://www.ryanthomson.net/articles/screen-recording-permissions-catalina-mess/> |
| Window titles via the AX API (`AXUIElementCopyAttributeValue`) | **Accessibility** | ActivityWatch's path. Note a known failure mode where `AXIsProcessTrusted()` returns true but `AXUIElementCopyAttributeValue` still fails with `.cannotComplete`. [VERIFIED-SECONDARY] <https://developer.apple.com/forums/thread/794253> |
| Browser tab URLs via AppleScript to Safari/Chrome | **Automation** (per-target-app, i.e. one prompt *per controlled app*) | ActivityWatch: "aw-watcher-window requires the Automation permission in order to work on macOS, but the app won't request it dynamically" — i.e. it can end up permanently broken with no prompt. [VERIFIED-SECONDARY] |
| Sending keystrokes / `key code` via System Events (the common "lock screen" osascript trick) | **Accessibility** for the *calling* process | And Automation for System Events. Two grants for one trick. |
| Reading `knowledgeC.db`, `~/Library/Biome/`, TCC.db | **Full Disk Access** | See §1.4 — and FDA is no longer sufficient for part of this. |

### The three TCC failure modes that will actually bite you

All three are documented in ActivityWatch's issue tracker and are structural, not bugs you can fix:

1. **Subprocesses don't inherit the prompt.** "The .App fails to ask permissions for `aw-watcher-window` since it is a subprocess." If your daemon shells out to a helper, the *helper's* code identity is what TCC evaluates — and a plain script has no stable identity. [VERIFIED-SECONDARY] <https://github.com/ActivityWatch/activitywatch/issues/376>
2. **Grants silently detach on update.** "The cause of suddenly missing permissions can be a system or app update, as macOS doesn't seem to always connect given accessibility permissions to a new ActivityWatch .app." **Your self-updater can silently revoke your own telemetry.** [VERIFIED-SECONDARY]
3. **TCC grants attach to code identity, not to files.** `screentime-backup` had to grant FDA to a **signed `.app` bundle** rather than a script, "since macOS grants FDA to code identity, not loose scripts." [VERIFIED-SECONDARY] <https://github.com/alexjmiller5/screentime-backup>

**Design implication, stated plainly:** ship the agent as a **signed, notarized, stably-identified bundle with a fixed Team ID and bundle ID that never changes across updates**, and grant TCC to *that*. A bash script in `/usr/local/bin` cannot hold a durable TCC grant. This is probably the biggest single delta between the bash POC and a production design.

**Escape hatch worth knowing:** if you ever enroll the Mac in your own MDM (§2.6), you can deliver TCC grants via a **PPPC (Privacy Preferences Policy Control) configuration profile** keyed on the code-signing identity — grants that the child cannot revoke from System Settings and that survive updates. [INFERRED from standard macadmins practice; verify the specific payload keys against current Apple deployment docs before relying on it]

---

## 1.4 Reading Apple's own Screen Time data — the ceiling, and it moved recently

**The most important finding in T7.1:**

> "In macOS ≥ 26.3, Apple **vaulted the ScreenTimeAgent store beyond Full Disk Access** — the `RMAdminStore-*` and DeviceActivity captures are warn-skipped (verified on 26.3: **even FDA processes get EPERM** on the store directory; 26.1 still allows it). The knowledgeC and the Biome streams remain readable."
> — <https://github.com/alexjmiller5/screentime-backup> [VERIFIED-SECONDARY]

Unpacked:

| Store | Path | Status as of macOS 26.3+ |
|---|---|---|
| `knowledgeC.db` | `~/Library/Application Support/Knowledge/knowledgeC.db` | **Readable with FDA.** SQLite. Key table `ZOBJECT`; fields `ZSTARTDATE`, `ZENDDATE`, `ZVALUESTRING` (bundle ID), `ZSTREAMNAME`. Timestamps are Apple epoch — add **978307200** for Unix. |
| Biome streams | `~/Library/Biome/streams` | **Readable with FDA.** Where iCloud-synced cross-device usage lands. |
| `RMAdminStore-Local.sqlite` / `RMAdminStore-Cloud.sqlite` | under `/var/folders/.../com.apple.ScreenTimeAgent/Store` | **EPERM even with FDA on 26.3+.** This is the authoritative Screen Time settings/enforcement store. Gone. |
| DeviceActivity captures | same vault | **EPERM even with FDA on 26.3+.** |

**This is a live, one-year-old tightening that every blog post older than 2026-01 gets wrong** — and several of the popular scrapers (`nichtlegacy/screentime`, the Medium and R-bloggers walkthroughs, the `0xdevalias` gist) document only `knowledgeC.db` and pre-Tahoe macOS. They are not *wrong* about `knowledgeC.db`; they are silently incomplete about what you can no longer reach. [STALE-RISK on all of them]

**Unknown and untested: macOS 27.** Apple explicitly rebuilt Screen Time's architecture in 27. Whether `knowledgeC.db` survives as a usable source there is **unverified — I could find no source either way.** [NEGATIVE-EVIDENCE] Given Apple's trajectory (26.3 vaulted the ScreenTimeAgent store; 27 rewrote the subsystem), the base rate strongly suggests further restriction.

**Conclusion for the design:** do **not** build the telemetry story on scraping Apple's Screen Time databases. Build it on your own first-party observation (frontmost app + CPU activity + AFK), which needs no TCC grant at all for the basic signal, and treat `knowledgeC.db` as an optional cross-check that you expect to lose.

---

## 1.5 What has failed, and why — the recurring failure modes

Ranked by how likely each is to bite this project.

**1. Undocumented / private CLI primitives get removed at major versions.**
`CGSession -suspend` is your own worst-case example. The binary lived at `/System/Library/CoreServices/Menu Extras/User.menu/Contents/Resources/CGSession` — inside the Menu Extras bundle, which Apple has been dismantling since Big Sur. A Hammerspoon issue dated **2026-09-14** confirms the path "does not exist on this system." [VERIFIED-SECONDARY]
The lesson generalises: **`ScreenSaverEngine.app` is exactly the same class of artifact** — an undocumented internal app being invoked as an API. It is not a supported interface, Apple owes you nothing, and it is a prime candidate to break in 27. The same goes for `SACLockScreenImmediate` in `/System/Library/PrivateFrameworks/login.framework`: it works, it's been the community answer since ~2016, and the most recent confirmation I can find is **macOS Monterey, November 2022**. [STALE-RISK — this is precisely the profile of a CGSession-in-waiting]

**2. TCC keeps tightening, and it tightens silently.**
See §1.3 and §1.4. macOS 26.3 removed FDA access to the ScreenTimeAgent store with no fanfare. macOS 26 also tightened `com.apple.macl` extended-attribute behaviour such that "if any app in the macl list has stamped a parent directory under `~/Documents/`, no other app gets in, regardless of the TCC grants the user has set," and those xattrs are SIP-protected and cannot be stripped from userspace. [VERIFIED-SECONDARY] <https://github.com/ernw/hardening/blob/master/operating_system/osx/26/Hardening_Guide-macOS_26_Tahoe_1.0.md> The failure mode is not an error — it's silently degraded or empty data.

**3. Kernel extensions died; anything built on them died with them.**
Apple deprecated KEXTs in Catalina 10.15.4 (2019) in favour of System Extensions (Network Extension for content filtering, Endpoint Security for process visibility). On Apple Silicon, kexts won't load without explicitly lowering security. **Every pre-2020 macOS parental-control product built on a kext is dead.** This is the single largest graveyard in this space. [VERIFIED-SECONDARY] <https://developer.apple.com/support/kernel-extensions>
**But note the trap on the other side:** the replacement — an Endpoint Security system extension — requires the **`com.apple.developer.endpoint-security.client` entitlement, which Apple grants by application only.** So the migration path is closed to a hobbyist. Don't design toward one.

**4. Notarization and signing requirements ratcheting.**
Gatekeeper requires Developer ID signature + notarization. macOS 26 hardening guidance now treats an unsigned binary referenced from a `/Library/LaunchDaemons` plist as an investigation trigger: "all executable binaries linked in LaunchDaemon .plist files MUST be signed." And the ecosystem is moving in lockstep — **Homebrew 5 deprecated unsigned casks and is disabling them around September 2026.** [VERIFIED-SECONDARY]
Interpretation: a root LaunchDaemon pointing at an unsigned shell script still *runs* today, but it is on the wrong side of the trend, it cannot hold a durable TCC grant (§1.3), and it will look exactly like malware to any future security tooling. **Get an Apple Developer account ($99/yr), sign and notarize the agent.** This is not gold-plating; it is the thing that makes TCC grants stick.

**5. Apple deprecated its own predecessor.**
macOS Parental Controls and Managed Accounts were removed in Catalina and replaced by Screen Time — **with no migration path**; there was "no way to transfer Managed Accounts or Parental Control settings to Screen Time." Apple has broken this exact feature area before, for its own users, without a bridge. [VERIFIED-SECONDARY]

**6. Consent-based enforcement doesn't hold.**
Allow2's model (apps voluntarily ask a service for permission) has ~13 stars after a decade. Gate's own README concedes the sanctioned iOS API can be revoked in four taps. Any design where the enforced party can decline to be enforced is not an enforcement design.

**7. Abandonment by attrition.**
Note the star counts in §1.1: PlayCap 0, mac-screentime-enforcer 0, screen-quota 0, screentime-backup 0. **There is no maintained, popular, open-source macOS parental-control daemon.** Everything in this niche is a parent's weekend project. That is simultaneously the reason to build your own and the warning about what happens to it — budget for the maintenance, or it joins them.

---

## 1.6 Design traps, courtesy of Timekpr-Revived's post-mortem

Timekpr-nExT exists because Timekpr-Revived failed. Its documented failure list maps almost one-to-one onto risks in your design: [VERIFIED-SECONDARY]

| Timekpr-Revived's failure | Your equivalent risk |
|---|---|
| Daemon↔client **desynchronisation** — the UI showed one thing, the daemon enforced another | Your k3s dashboard shows 40 minutes left; the daemon has already counted down to zero. **The daemon's local counter must be the single source of truth, and the dashboard must display the daemon-reported value, not a server-side recomputation.** |
| User **kicked out at midnight** mid-task | Your midnight reset / rollover. `mac-screentime-enforcer` handles this by resetting minutes locally at midnight; make sure rollover never *triggers* an enforcement action, only resets budget. |
| **No sleep support** — time accrued while the machine was asleep | Both PlayCap (CPU-activity gate) and screen-quota (stops counting while asleep) solved this. **Do not count wall-clock; count active time.** |
| **No weekly/monthly allowance** — only daily | Design the budget model with day/week/month tiers now; retrofitting it means migrating historical data. |
| PAM integration **invasively rewrote the display-manager config** | The macOS analogue is anything that modifies `/etc/pam.d`, an authorization plugin, or the login window. **Don't.** Use supported session-level actions; leave the auth stack alone. |

---

## 1.7 BORROW / AVOID

### BORROW

**Enforcement & accounting**
1. **CPU-activity gating for time accounting** (PlayCap). An idle Roblox process in the tray must not burn budget. This is the highest-value single idea in the survey.
2. **Sleep-aware accounting** (screen-quota). Stop the clock when the machine sleeps.
3. **Graduated escalation ladder**: warn 10 → 5 → 1 min → quit the *app* → lock session → log out → shut down (mac-screentime-enforcer, PlayCap, Nudge). Reach for the biggest hammer last; kill the offending app before you kill the session.
4. **Shutdown escalation triggered by repeated circumvention**, not by the clock alone (mac-screentime-enforcer: shutdown after N blocked relogin attempts in a rolling window). This is a much better trigger than "time's up, power off."
5. **Root-owned state, GUI-as-view** (SelfControl). The authority lives in a root component that survives app deletion, quit and reboot. The menu-bar UI, if any, is strictly a display.
6. **MONITOR before LOCKDOWN** (Santa). Run in observe-only for a couple of weeks. You will discover your accounting is wrong before it powers off the machine during homework.

**Agent operations**
7. **Supervisor + worker two-process split** (Orbit).
8. **Bootstrap secret → durable credential → wipe the bootstrap into the Keychain** (fleetd).
9. **Pinned update channels, not `:latest`** (Orbit).
10. **Self-signed CA pinned in the agent** (`--fleet-certificate`), not TLS verification disabled.
11. **Retained desired-state flag over MQTT (or equivalent), reconciled continuously** (mac-screentime-enforcer). Not RPC commands.
12. **Heartbeat as a tamper-detection signal** (mac-screentime-enforcer).
13. **Cached policy + offline reconciliation; fail closed on limits, fail open on shutdown** (Munki).
14. **Everything is an append-only event; dashboards read the event store** (Zentral).
15. **Parent-approval request portal with persistent, audited decisions** (Zentral's Santa voting portal) — this is your "20 more minutes please" flow, already designed by someone else.
16. **Idempotent/dedupe-on-reimport telemetry ingestion** (nichtlegacy/screentime).

**macOS-specific hygiene**
17. **Ship a signed, notarized bundle with an immutable bundle ID + Team ID**, and hang every TCC grant off that identity (screentime-backup's FDA-to-signed-app finding).
18. **Use `swiftDialog` for user-facing dialogs** instead of `osascript display dialog` from root.
19. **`aw-watcher-afk`-style idle detection** via `CGEventSourceSecondsSinceLastEventType` — no TCC grant needed.
20. **Deliver TCC grants by PPPC profile** if you enroll in your own MDM, so the child can't revoke them.

### AVOID

1. **Do not depend on `ScreenSaverEngine.app` as your lock primitive.** Same class of artifact as `CGSession`, and macOS 27 just shipped. Have two independent lock paths and a test that runs on boot to tell you which still work. [This directly qualifies a POC finding.]
2. **Do not depend on `SACLockScreenImmediate`** without re-testing. Best confirmation I can find is macOS Monterey / Nov 2022. It is a private framework symbol. [STALE-RISK]
3. **Do not build the telemetry story on scraping Apple's Screen Time databases.** `RMAdminStore-*` and DeviceActivity captures became FDA-proof in **macOS 26.3**; `knowledgeC.db` survives for now but macOS 27 rewrote the subsystem and its status is unverified.
4. **Do not ship the agent as a bare shell script in a LaunchDaemon.** It cannot hold a durable TCC grant, it's on the wrong side of the signing trend, and it looks like malware.
5. **Do not plan on a kernel extension.** Dead since Catalina, won't load on Apple Silicon without lowering security.
6. **Do not plan on an Endpoint Security system extension either.** Requires an Apple-granted entitlement you will not get as an individual.
7. **Do not plan on FamilyControls / ManagedSettings / DeviceActivity.** See §2.4 — they do not exist on macOS, full stop.
8. **Do not touch PAM, authorization plugins or the login window.** Timekpr-Revived's invasive display-manager edit is the archetype. Unsupported, breaks at OS updates, and can lock you out of the machine.
9. **Do not put the authoritative time counter on the server.** Timekpr-Revived's desync failure. The daemon counts; the server displays.
10. **Do not use a menu-bar / GUI app as the enforcement authority** (screen-quota's form factor). Trivially quit.
11. **Do not build consent-based enforcement** (Allow2). The subject will decline.
12. **Do not install a local HTTPS-intercepting proxy with a root CA** on the child's machine (K9's second layer) unless you have thought hard about it. You are creating a persistent MITM position on a machine you also want to be secure.
13. **Do not count wall-clock time.** Count active time. Everyone who counts wall-clock ships a bug.
14. **Do not trust any macOS blog post, StackOverflow answer or LLM answer on this topic dated before 2026-01** without re-testing on the actual machine. The `CGSession` precedent, the 26.3 TCC vaulting, and the macOS 27 Screen Time rewrite are three separate invalidation events inside eighteen months.

---

# T7.2 — Apple's native layer: capability ceiling and coexistence

## 2.1 Screen Time capability table

Assumes: child has a **Child Apple Account** in the parent's **Family Sharing** group, both devices signed in, both updated. Columns mean: *Supported?* = does the feature exist on macOS at all. *Remotely manageable?* = can the parent change it from their own iPhone/iPad/Mac. *Data accessible to us?* = can our daemon/control plane read it programmatically.

| Capability | Supported on macOS? | Remotely manageable? | Data accessible to us? |
|---|---|---|---|
| **Downtime** (scheduled window where apps are paused) | **Yes** | **Yes** — Settings → Screen Time → Family → [child] | **No.** Settings live in `RMAdminStore-*`, which is EPERM even with FDA on macOS ≥ 26.3 |
| **Block at Downtime** (hard block vs. dismissible notice) | **Yes**, but **only when a Screen Time passcode is set** | Yes | No |
| **App Limits** (per-app daily allowance) | **Yes** | **Yes** | No |
| **Per-category limits** (Games, Social, Entertainment) | **Yes** | **Yes** | No |
| **Zero-minute limits** (= full block) | **Yes** — newly possible; previously the floor was 1 minute | Yes | No |
| **Time Allowances** (age-tailored per-category budgets w/ day+time schedules) | **macOS 27 only** | Yes | No |
| **Daily Schedules** (different rules by time of day, quick switching) | **macOS 27 only** | Yes | No |
| **Pause Device Use / grant temporary access** | **macOS 27 only** | **Yes** — this is the headline remote-control feature of 27 | No |
| **Always Allowed** (apps/contacts exempt from Downtime and Pause) | **Yes** | Yes | No |
| **Communication Limits** (who the child can contact, Messages/FaceTime/Phone) | **Yes** | **Yes** | No |
| **Communication Safety** (blurs nudity; **macOS 27 adds gore/violence**) | **Yes**; on by default for 13–17 accounts | Yes | No |
| **Content & Privacy Restrictions** (adult web filter, allowlist/denylist, store/age ratings) | **Yes** | **Yes** | No |
| **Ask to Buy** (approve every app download) | **Yes** | Yes (approval flows to parent's device) | No |
| **Ask to Browse** (approve every new website in Safari) | **macOS 27 only** | **Yes** — approvals arrive via Messages | No |
| **Screen Time passcode** (prevents child disabling Screen Time) | **Yes** | Set on-device or via Family Sharing | No |
| **Usage reporting to parent** — weekly summaries, most-used apps, per-app/website time | **Yes**; macOS 27 adds an at-a-glance redesign | **Yes** — parent views on their own device | **Partially.** Not via a supported API. Via `knowledgeC.db` + Biome with FDA, which still works on 26.x but is unsupported and unverified on 27 |
| **Lock the Mac / end the session** | **NO** | n/a | n/a |
| **Log the user out** | **NO** | n/a | n/a |
| **Shut the Mac down / power off** | **NO** | n/a | n/a |
| **Sleep the Mac / scheduled power-off** | **NO** (Screen Time has no power-management surface at all) | n/a | n/a |
| **Any supported API for third-party apps to read Screen Time data on macOS** | **NO** — see §2.4 | n/a | n/a |
| **Any supported API for third-party apps to impose Screen-Time-like restrictions on macOS** | **NO** — see §2.4 | n/a | n/a |

Sources for the table: <https://support.apple.com/guide/mac-help/set-up-screen-time-on-mac-mchl8ea3ee0f/mac>, <https://support.apple.com/en-sg/guide/mac-help/mchl69510069/mac> (Downtime, macOS Tahoe 26), <https://www.apple.com/newsroom/2026/09/apples-new-child-safety-features-now-available/> (2026-09-14), <https://9to5mac.com/2026/09/14/heres-whats-new-with-parental-control-features-in-ios-27-ipados-27-and-macos-27/>, <https://www.macrumors.com/2026/06/08/ios-27-parental-controls/>, <https://support.apple.com/en-us/108806>.

---

## 2.2 THE KEY VERIFICATION: can Screen Time power off a Mac?

### Verdict: **NO. The POC's claim is correct.** Screen Time cannot power off, restart, sleep, log out of, or lock a Mac.

I could not find a single instance of Apple documenting any power or session action inside Screen Time on any platform. Evidence, strongest first:

1. **Apple's own Downtime documentation describes a notification, not an action.** macOS Tahoe 26 page: *"During downtime, if you try to use your Mac you get a message informing you that it's your scheduled downtime."* And for a child: *"If your child tries to access their device during downtime, they can request more time from you."* The strongest available escalation is *"If you want to block the device during downtime, turn on Block at Downtime"* — a **block**, i.e. a shield over apps, not a session or power action. [VERIFIED-PRIMARY] <https://support.apple.com/en-sg/guide/mac-help/mchl69510069/mac>

2. **macOS 27's brand-new "strongest" control is still a block.** Apple's own framing for the most aggressive new remote capability is *"temporarily pause access to a device"* — and crucially, *"Always Allowed apps and contacts will remain available even when access is paused."* An OS that leaves selected apps running by design is not powering the machine off. [VERIFIED-PRIMARY] <https://www.apple.com/newsroom/2026/09/apples-new-child-safety-features-now-available/> (2026-09-14)

3. **Apple put power control in a *different* product.** The MDM command list includes **Shut Down Device** and **Restart Device**, both supported on macOS. Apple deliberately located power actions in the device-management protocol, not in Screen Time. That is a strong architectural signal that Screen Time is a *content and attention* layer, not a *device state* layer. [VERIFIED-PRIMARY] <https://support.apple.com/guide/deployment/mdm-command-list-dep789n2k1qp/web>

4. **Third-party corroboration.** *"The Downtime feature of Screen Time cannot force a log out."* — Timing's Screen Time for Mac guide. If it can't force a logout, it certainly can't force a shutdown. [VERIFIED-SECONDARY] <https://timingapp.com/blog/screen-time-for-mac/>

5. **Exhaustive negative search.** Searches across Apple Support, Apple Newsroom, Apple Developer docs, MacRumors, 9to5Mac and Apple Community for Screen Time + shutdown / power off / log out returned nothing in the affirmative. The community answer to "how do I make my kid's Mac turn off at bedtime" is universally `pmset repeat shutdown` or a third-party tool, never Screen Time. [NEGATIVE-EVIDENCE]

**Confidence: high.** Caveat stated honestly: this rests partly on absence of evidence. But it is absence across Apple's primary documentation for a feature Apple has been actively marketing for eight years and just rewrote, combined with the positive fact that Apple ships power control in MDM instead.

### What else Screen Time cannot do

- **No programmatic export of usage data.** No CLI, no Shortcuts action, no supported API on macOS. The parent sees charts on their own device; that is the entire sanctioned interface. [NEGATIVE-EVIDENCE + §2.4]
- **No webhooks, no callbacks, no push to a third party.** Nothing to integrate with your k3s control plane.
- **No custom actions on limit-hit.** You cannot say "when the limit expires, run this." The only terminal state is a shield.
- **No control over the machine at the login window.** Every Screen Time control is scoped to a signed-in user session.
- **No enforcement across the Mac's *own* power state.** It cannot prevent the machine being used at 3am; it can only shield apps once someone is logged in.
- **No management once the account turns 18.** *"Once an account reaches age 18, you cannot manage their Screen Time from your iPhone, iPad, or Mac, even if they are a part of your Apple Family group."* A hard, dated cliff-edge you should put in the design's assumptions. [VERIFIED-SECONDARY] <https://support.apple.com/en-us/119854>
- **Reliability is genuinely poor, and has been for years.** Documented, recurring, still-live failure modes:
  - **A 30–60 second post-restart window where no protections apply** — "everything from communication limits to downtime to allowed websites can be completely bypassed." [VERIFIED-SECONDARY] <https://mjtsai.com/blog/2025/09/24/screen-time-brokenness/>
  - Settings silently reverting / limits disappearing; sync claiming success without syncing.
  - Apple publicly confirmed a settings-not-sticking bug in 2023; equivalent classes of bug were still being reported through iOS 26.x in 2026 (the "One More Minute locks every app" bug, confirmed across 26.0–26.2; App Limits firing on device pickup). [VERIFIED-SECONDARY] <https://fone.tips/ios-26-screen-time-not-working/>, <https://www.idownloadblog.com/2026/03/12/fix-app-limits-not-working/>
  - **Two parents both holding Parent/Guardian roles causes conflicts** — community fix is to keep only the Organiser.
  - **Screen Time depends on the system clock**, so a wrong clock quietly breaks daily limits.
- **Documented macOS bypasses** (all [VERIFIED-SECONDARY], none confirmed fixed in 27):
  - **Spotlight preview** renders restricted web content, bypassing the web filter.
  - **`NSApp.setActivationPolicy()` / LSUIElement**: Screen Time only enforces against apps that register as regular Dock apps *at launch*; an app that changes activation policy escapes limits while still appearing in the Dock. <https://1-day.medium.com/your-kid-might-be-bypassing-screen-time-app-limits-on-macos-using-this-trick-0fed8225bf79>
  - **Chrome**: content filtering that works in Safari does not apply.
  - **Changing the system date/time** defeats limits. <https://developer.apple.com/forums/thread/809318>

**This is the real argument for your project.** Screen Time's problem is not only its capability ceiling; it is that it is *unreliable at what it does claim to do*.

---

## 2.3 What the parent actually gets for reporting

- Weekly usage summaries and most-used apps at a glance on the parent's own device (redesigned in macOS 27).
- Per-app and per-website time, per device, aggregated across the Family Sharing group.
- Ask to Buy / Ask to Browse approval requests, delivered to the parent's device (Ask to Browse approvals arrive **via Messages** in 27).
- **No export. No API. No file you can read from your control plane on a supported path.** [NEGATIVE-EVIDENCE]

---

## 2.4 The Screen Time API (FamilyControls / ManagedSettings / DeviceActivity) — **not available on macOS**

### The platform facts, from Apple's own documentation JSON (fetched 2026-09-18)

| Framework | iOS | iPadOS | macOS (native) | Mac Catalyst | Purpose |
|---|---|---|---|---|---|
| **FamilyControls** | 15.0 | 15.0 | **— (absent)** | 15.0 | "Authorize your app to provide parental controls on a device." |
| **ManagedSettings** | 15.0 | 15.0 | **— (absent)** | 15.0 | "Access and change settings with your app while maintaining user privacy and control." Applies the actual shields/restrictions. |
| **DeviceActivity** | 15.0 | 15.0 | **— (absent)** | 15.0 | "Provides a **privacy-preserving** way for an application to monitor a person's application and website activity." |

[VERIFIED-PRIMARY] — <https://developer.apple.com/documentation/familycontrols>, <https://developer.apple.com/documentation/managedsettings>, <https://developer.apple.com/documentation/deviceactivity>

**There is no native macOS availability line on any of the three.** Mac Catalyst 15.0 is listed, which means "an iPad app recompiled to run on Mac" — not a macOS app, not a daemon, not a CLI.

### And Mac Catalyst doesn't actually work either

An **Apple Frameworks Engineer** stated flatly:

> *"The Screen Time API frameworks (i.e. FamilyControls, ManagedSettings, and DeviceActivity) **only work on iOS and iPadOS devices**."*

[VERIFIED-PRIMARY] <https://developer.apple.com/forums/thread/721295> (December 2022). No Apple follow-up in that thread has ever amended it.

Developers attempting it since confirm the practical result: a Catalyst build with all three capabilities enabled **fails at runtime** — `AuthorizationCenter.requestAuthorization` and `FamilyActivityPicker` fail with service-proxy-connection and sandbox errors, `authorizationStatus` stays `.notDetermined` forever, and without authorization the ManagedSettings shields and DeviceActivity monitoring are inert. An Apple suggestion to disable App Sandbox is a non-starter because **Catalyst apps are always sandboxed**. [VERIFIED-SECONDARY] — Apple Developer Forums, Family Controls / Managed Settings / Catalyst tags.

### Is this changing in macOS 27?

**No evidence of it.** WWDC 2026 and the macOS 27 release coverage describe *user-facing* parental-control features (Ask to Browse, Time Allowances, redesigned Screen Time, Pause Device Use). **No source mentions any new or expanded third-party API, and no source mentions macOS availability for the Screen Time frameworks.** Developer commentary tracking the API across releases concludes that "every WWDC since 2021 has shipped quiet revisions to FamilyControls, ManagedSettings, and DeviceActivity, but none have been keynote-worthy and none have fixed the actual problems." [VERIFIED-SECONDARY] <https://habitdoom.com/blog/wwdc-2026-screen-time-wishlist>
Mark this as [NEGATIVE-EVIDENCE] and worth a 15-minute re-check against the macOS 27 SDK release notes once they're indexed.

### The entitlement, for completeness

Even on iOS, using these requires **`com.apple.developer.family-controls`**, and *"before submitting to the App Store, you must request permission from Apple to use this entitlement."* Reports in 2026 describe a systemic backlog in FamilyControls entitlement review with extended waits. [VERIFIED-PRIMARY for the requirement] <https://developer.apple.com/documentation/familycontrols/requesting-the-family-controls-entitlement>; [VERIFIED-SECONDARY for the backlog]

### Two further ceilings, even if it did exist

1. **DeviceActivity is privacy-preserving by construction.** Its design goal is to let an extension *react* to thresholds without the developer ever seeing raw usage. **You cannot read usage data out of it** and ship it to your server. Even the fully-sanctioned path would not give you the telemetry you want.
2. **On iOS, the child can revoke it in four taps** (Settings → Screen Time → Apps with Screen Time Access) and "every restriction lifts instantly" (Gate's own README).

### Bottom line

**There is no supported API for a third-party developer to read Screen Time data or impose Screen-Time-like restrictions on macOS.** Not native, not Catalyst, not with an entitlement. The unsupported paths are: read `knowledgeC.db`/Biome with FDA (works on 26.x, blocked for `RMAdminStore-*` since 26.3, unverified on 27), or observe the system yourself. **Your custom daemon is not a workaround for a gap you could have avoided — it is the only mechanism that exists on this platform.**

---

## 2.5 Remote rule changes and how fast they take effect

**Mechanism:** parent's device → Settings/System Settings → Screen Time → Family → [child] → change Downtime / App Limits / Time Allowances / Communication Limits / Content & Privacy. Changes propagate through iCloud to every device signed in to the child's Apple Account. Only the **Family Organizer** and members explicitly designated **Parent/Guardian** can do this. [VERIFIED-PRIMARY] <https://support.apple.com/en-us/108806>

**Latency:**

| Situation | Observed latency | Source quality |
|---|---|---|
| macOS 26 and earlier | **Commonly 5–10 minutes**; sometimes longer; sometimes silently never (settings claim a fresh sync date but haven't actually synced) | [VERIFIED-SECONDARY] — widely and consistently reported; <https://www.macobserver.com/iphone/apple-screen-time-not-updating/>, <https://mjtsai.com/blog/2025/09/24/screen-time-brokenness/> |
| macOS 27 (all devices on 27) | Apple claims the rebuilt architecture "makes parental controls sync **more quickly**" — **no number given** | [VERIFIED-PRIMARY for the claim, unquantified]. **Untested in the field; four days old.** |
| Requirement | **All devices in the group must be on the 27 releases** (iOS 27 / iPadOS 27 / macOS 27 / watchOS 27 / visionOS 27) to get the new Screen Time experience at all | [VERIFIED-PRIMARY] |

**Use as a benchmark:** Screen Time's remote-change latency is **minutes, with a silent-failure tail**. A custom daemon polling your k3s control plane every 15–30 seconds — or holding a retained MQTT flag — will be **one to two orders of magnitude faster and, more importantly, observably faster**, because your daemon can acknowledge the change and you can alert on a missing ack. Screen Time's real weakness is not the 5 minutes; it is that you cannot tell the difference between "5 minutes" and "never."

**Design target:** ≤30s p95 for a rule change to be in force on the Mac, with an explicit ack event so "never" is detectable. That is a bar Screen Time cannot meet and a genuinely defensible reason for the project to exist.

---

## 2.6 The option nobody in the POC considered: your own MDM

This deserves its own section because it materially changes the design space.

**`ShutDownDevice` is a documented MDM command supported on macOS.** [VERIFIED-PRIMARY] <https://support.apple.com/guide/deployment/mdm-command-list-dep789n2k1qp/web> — Shut Down Device and Restart Device are both listed for macOS, alongside Lock Device and Erase Device. (Note: search results conflict on Restart-for-macOS; some vendor docs claim Apple never implemented Restart for macOS. Apple's own command list says macOS. **Flagging as contested — test it.**) Third-party confirmation of the capability: <https://fleetdm.com/mdm-commands/apple-shut-down-device>, which gives `ShutDownDevice` as supported on macOS 10.13+.

**Meaning: the single capability the POC built a root daemon for — powering the machine off — is available through a supported, documented, Apple-blessed protocol**, and there are two maintained self-hosted open-source servers for it (**NanoMDM**, active; MicroMDM, maintenance mode since late 2025). NanoMDM is MIT, stateless, pluggable storage — a natural fit next to k3s.

**The catch, and it's a real one:** you need an **APNs MDM push certificate**. Getting one legitimately requires an **MDM Vendor certificate**, available only through the **Apple Developer Enterprise Program at ~$300/year** — which as an individual you cannot join (it requires a legal entity with a D-U-N-S number). The community workaround, **mdmcert.download**, exists but MicroMDM's own documentation calls it *"an Apple-proprietary method... embedded inside Profile Manager"* of *"questionable legality to use with anything other than Profile Manager."* [VERIFIED-SECONDARY] <https://micromdm.io/blog/certificates/> I could not confirm mdmcert.download's operational status in 2026. **Treat the MDM route as blocked-by-default for an individual, pending your own investigation.**

**What MDM would buy you if the cert problem were solved:**
- Supported `ShutDownDevice` / `DeviceLock` — no private APIs, no CGSession-class fragility.
- **PPPC profiles** to grant TCC permissions that the child cannot revoke and that survive agent updates. This alone might be worth it.
- **Declarative Device Management software-update enforcement** — the supported way to *defer* macOS 27 on the child's Mac while you re-test. Note that **MDM software updates are deprecated in the OS 26 releases in favour of DDM**, so build against DDM if you go here. [VERIFIED-SECONDARY]
- A configuration-profile-enforced Screen Time payload that survives a user reset.

**Recommendation:** spend 30 minutes confirming whether you can obtain an APNs cert. If yes, a minimal NanoMDM alongside k3s is a *strictly better* backstop than a private-API lock, and it makes the custom daemon's job smaller (telemetry + fine-grained time accounting + warnings) rather than larger. If no — which is the likely answer — the custom daemon remains correct, and you should at least steal the PPPC idea's *goal* by making the agent a signed bundle with a stable identity (§1.3).

**Non-MDM power scheduling that definitely works today:** `sudo pmset repeat shutdown MTWRFSU 21:00:00`. Apple removed the GUI for this in Ventura but the `pmset` path persists on Apple Silicon. Caveat from the docs: **the Mac must be awake and logged in for a scheduled shutdown to fire** — so it is a useful belt-and-braces bedtime backstop, not a primary enforcement mechanism. [VERIFIED-SECONDARY] <https://ss64.com/mac/pmset.html>, <https://www.dssw.co.uk/blog/2024-05-02-scheduled-shut-down-macos/> [STALE-RISK: best sources are 2024; re-verify `pmset repeat` on 26/27]

---

## 2.7 Coexistence: should Screen Time run alongside the custom daemon?

### Recommendation: **YES — run both. The POC's instinct is sound.** With four specific conditions.

### Why it's sound

1. **They operate on different, non-overlapping layers.**
   - Screen Time acts on **apps and content within a logged-in session**: shields, web filtering, communication limits, store restrictions.
   - Your daemon acts on **session and device state**: lock, log out, power off.
   There is no shared resource to fight over. Screen Time has no power-management surface at all (§2.2), and your daemon has no interest in shielding individual apps. **A conflict is structurally very unlikely.** [INFERRED, but from well-established facts]

2. **Screen Time survives what your daemon cannot.** It is tied to the child's **Apple Account**, not to the disk. Reinstall macOS, restore, migrate to a new Mac — the Family Sharing restrictions follow the account. Your LaunchDaemon does not. That is a genuinely different and complementary durability property, and the POC identified it correctly.

3. **Screen Time covers content, which your daemon does not.** Adult-web filtering, communication limits, app-store age ratings, Ask to Buy, Ask to Browse. Building any of that yourself means a content-filter system extension you cannot get entitled for (§1.5). **Take the free capability.**

4. **Defence in depth against your own bugs.** Your daemon is a weekend project on a platform that breaks things. If it dies, silently loses its TCC grant, or gets unloaded, Screen Time is still shielding apps. Meanwhile your daemon's heartbeat tells you the daemon died. The two failure modes are independent.

5. **It is an honest, legible layer.** Screen Time shows the child a native Apple UI with a "ask for more time" button. Your daemon is invisible infrastructure. Having a visible, normal-looking layer is better for the human relationship than pure invisible enforcement — worth saying out loud in a project that will be operated on a real child.

### The four conditions

**Condition 1 — the custom daemon owns the clock; Screen Time must not.**
Do **not** set Screen Time App Limits or Downtime windows that end at the same time as your daemon's budget. That is where double-warnings come from: Screen Time's "1 minute left" notification and your daemon's "1 minute left" dialog firing within seconds of each other, from two systems the child cannot reconcile. **Set Screen Time's Downtime window deliberately wider than your daemon's** (e.g. daemon enforces bedtime at 21:00; Screen Time Downtime starts 22:00). Screen Time then only ever fires when your daemon has already failed — which is exactly the backstop role you want, and the child never sees both.

**Condition 2 — split the domains cleanly and write the split down.**

| Concern | Owner |
|---|---|
| Daily/weekly time budget, warnings, countdown | **Custom daemon** |
| Lock / logout / shutdown | **Custom daemon** (only thing that can) |
| Per-app and per-category limits | Screen Time (it's better at this and you get shields free) |
| Web content filtering, adult sites | **Screen Time** (you cannot build this) |
| Communication limits, contacts | **Screen Time** (you cannot build this) |
| App installs (Ask to Buy) | **Screen Time** |
| Telemetry, dashboards, audit trail | **Custom daemon → k3s** |
| Bedtime hard stop | **Custom daemon** primary; Screen Time Downtime as wider backstop |
| Survives OS reinstall | **Screen Time** (account-bound) |

**Condition 3 — one Screen Time controller.** The community-documented conflict is **two adults both holding Parent/Guardian roles causing settings conflicts**, with the fix being to keep only the Organiser. [VERIFIED-SECONDARY] Designate one parent account as the Screen Time controller, full stop.

**Condition 4 — do not attempt to read or write Screen Time state from your daemon.** No poking `RMAdminStore-*` (EPERM since 26.3 anyway), no scripting System Settings, no `defaults write` against Screen Time preferences. Any of these will break at an OS update, may fight the real controller, and would put your daemon in a race with `ScreenTimeAgent`. **Treat Screen Time as a black box you configure by hand, once, out of band.** This is the single clearest "avoid" in the coexistence story.

### Residual risks to accept knowingly

- **The 30–60 second post-restart bypass window** in Screen Time is real. Your daemon should cover it: enforce from `RunAtLoad` on the LaunchDaemon, and treat "just booted" as a state to enforce *more* strictly, not less. This is one place your daemon strictly improves on Apple.
- **Screen Time's own unreliability** (settings reverting, silent sync failure) means you should not *rely* on the backstop. It is a second layer, not a guarantee. If you want a backstop you can actually trust, that's `pmset repeat shutdown` or MDM (§2.6), not Screen Time.
- **Two notification sources will occasionally collide anyway.** Condition 1 minimises it, it does not eliminate it. Accept it; it's cosmetic.
- **The age-18 cliff.** Screen Time management ends at 18 regardless of Family Sharing. Your daemon does not. Note it in the design's lifetime assumptions.
- **macOS 27 changes the calculus in Screen Time's favour.** Time Allowances, Daily Schedules, Pause Device Use and faster sync make Screen Time a meaningfully stronger layer on 27 than on 26. **But it still cannot power the machine off**, so the custom daemon's core justification is untouched.

---

## 3. Contradictions and qualifications against the POC's assumptions

Listed because the brief asked for anything that cuts against prior findings.

1. **The platform assumption is stale by four days.** macOS 27 Golden Gate shipped 2026-09-14 with a **rewritten Screen Time**. Everything validated on macOS 26 needs re-testing, and the upgrade needs an explicit defer/accept decision. This is the CGSession pattern repeating in real time.

2. **`ScreenSaverEngine.app` is the next `CGSession`, not a safe replacement for it.** The POC learned the right lesson (don't trust blog advice) but arguably drew the wrong conclusion (this other undocumented binary is fine). Both are undocumented internal artifacts. Build **two independent lock paths** and a boot-time self-test.

3. **"Screen Time as the layer that survives an OS reinstall" is correct but weaker than it sounds.** It survives reinstall, yes — but it has a documented 30–60s post-restart bypass window, documented silent-sync failures, and at least four live macOS bypasses (Spotlight, LSUIElement, Chrome, system clock). It is a real backstop; it is not a reliable one.

4. **Power-off is *not* uniquely a custom-daemon capability.** Apple ships **`ShutDownDevice` as a supported MDM command on macOS**, and `pmset repeat shutdown` also exists. The custom daemon is the right answer *given the APNs-certificate barrier*, but the reasoning should be "MDM is procedurally out of reach," not "no supported mechanism exists." Worth 30 minutes to confirm the barrier before committing.

5. **A bash LaunchDaemon cannot hold a durable TCC grant.** This is the biggest hidden cost between POC and production. TCC binds to **code identity**; loose scripts have none; subprocesses don't inherit the parent's grant; and grants silently detach across updates. If the design wants window titles, browser URLs, or `knowledgeC.db`, the agent **must** become a signed, notarized bundle with a fixed bundle ID and Team ID. Budget the $99/yr and the signing pipeline.

6. **Window titles need Screen Recording, not Accessibility** — and the failure is silent, returning degraded data with no prompt and no error. Any telemetry plan that assumes Accessibility is enough will ship and appear to work while collecting nothing.

7. **Apple's Screen Time data is already partly out of reach and trending worse.** `RMAdminStore-*` and DeviceActivity captures became FDA-proof in **macOS 26.3**. `knowledgeC.db` survives on 26.x but is unverified on 27. Any design that reads Apple's data as a primary source is building on sand.

8. **There is no maintained open-source macOS parental-control daemon to fork.** Every candidate is a 0-star personal project. The nearest neighbour, `mac-screentime-enforcer`, is architecturally the closest thing to your design and worth reading end-to-end — but it is a LaunchAgent in the user session, where yours is a root LaunchDaemon, which is the stronger choice.

---

## 4. Open questions — worth 30 minutes each before committing

1. **Does `knowledgeC.db` survive macOS 27?** No source either way. Test on a 27 machine before designing any dependency on it.
2. **Do `ScreenSaverEngine.app` and `SACLockScreenImmediate` still lock the screen on macOS 26.6+ and 27?** The Hammerspoon issue dated 2026-09-14 is a warning shot. Test both; ship both; self-test at boot.
3. **Can you actually obtain an APNs MDM push certificate as an individual in 2026?** Is mdmcert.download still operating? This is the fork in the road between "custom daemon does everything" and "custom daemon + NanoMDM backstop with PPPC-delivered TCC grants."
4. **Does Apple's MDM `RestartDevice` work on macOS?** Apple's command list says yes; at least one vendor doc says Apple never implemented it for macOS. Contested — test if it matters.
5. **Does `pmset repeat shutdown` still work on macOS 26/27 Apple Silicon?** Best sources are 2024. Cheap to verify, and it's a free bedtime backstop if it holds.
6. **Do the macOS 27 SDK release notes mention FamilyControls/ManagedSettings/DeviceActivity at all?** Four days old and not yet indexed by search. A 15-minute re-check in a month is cheap insurance against building around a gap Apple just closed.
7. **What is macOS 27's actual Screen Time sync latency?** Apple claims "more quickly," unquantified. If it turns out to be seconds, the latency argument for the custom control plane weakens (though the power-off argument does not).

---

## 5. Sources

**Apple primary**
- Family Controls framework — <https://developer.apple.com/documentation/familycontrols> (availability: iOS 15.0, iPadOS 15.0, Mac Catalyst 15.0; no native macOS)
- Managed Settings framework — <https://developer.apple.com/documentation/managedsettings>
- Device Activity framework — <https://developer.apple.com/documentation/deviceactivity>
- Requesting the Family Controls entitlement — <https://developer.apple.com/documentation/familycontrols/requesting-the-family-controls-entitlement>
- Apple Frameworks Engineer: "The Screen Time API frameworks... only work on iOS and iPadOS devices" — <https://developer.apple.com/forums/thread/721295> (2022-12)
- Screen Time bypass via date/time change — <https://developer.apple.com/forums/thread/809318>
- Device management commands for Apple devices (ShutDownDevice / RestartDevice / Lock on macOS) — <https://support.apple.com/guide/deployment/mdm-command-list-dep789n2k1qp/web>
- Manage downtime in Screen Time on Mac (macOS Tahoe 26) — <https://support.apple.com/en-sg/guide/mac-help/mchl69510069/mac>
- Set up Screen Time on Mac (now serving macOS 27) — <https://support.apple.com/guide/mac-help/set-up-screen-time-on-mac-mchl8ea3ee0f/mac>
- Use Screen Time to manage your child's device — <https://support.apple.com/en-us/108806>
- Family Sharing and parental controls overview (age-18 cliff) — <https://support.apple.com/en-us/119854>
- **Apple Newsroom, "Apple's new child safety features now available", 2026-09-14** — <https://www.apple.com/newsroom/2026/09/apples-new-child-safety-features-now-available/>
- Apple Newsroom, "Apple expands tools to help parents protect kids and teens online", 2025-06 — <https://www.apple.com/newsroom/2025/06/apple-expands-tools-to-help-parents-protect-kids-and-teens-online/>
- Deprecated Kernel Extensions and System Extension Alternatives — <https://developer.apple.com/support/kernel-extensions>
- Use declarative device management to manage Apple devices — <https://support.apple.com/guide/deployment/declarative-device-management-manage-apple-depc30268577/web>
- What's new for enterprise in macOS Tahoe 26 — <https://support.apple.com/en-us/124963>

**macOS 27 coverage (all 2026)**
- MacRumors, macOS Golden Gate release date, 2026-09-10 — <https://www.macrumors.com/2026/09/10/macos-27-golden-gate-release-date/>
- MacRumors, macOS Golden Gate roundup — <https://www.macrumors.com/roundup/macos-27/>
- MacRumors, iOS 27 parental controls, 2026-06-08 — <https://www.macrumors.com/2026/06/08/ios-27-parental-controls/>
- 9to5Mac, parental controls in iOS/iPadOS/macOS 27, 2026-09-14 — <https://9to5mac.com/2026/09/14/heres-whats-new-with-parental-control-features-in-ios-27-ipados-27-and-macos-27/>
- 9to5Mac, Screen Time overhaul, 2026-06-10 — <https://9to5mac.com/2026/06/10/apple-is-giving-screen-time-and-parental-controls-a-long-overdue-upgrade-in-ios-27/>
- Help Net Security, 2026-09-15 — <https://www.helpnetsecurity.com/2026/09/15/apple-parental-controls-ios-27/>

**Screen Time reliability / bypasses**
- Michael Tsai, "Screen Time Brokenness", 2025-09-24 — <https://mjtsai.com/blog/2025/09/24/screen-time-brokenness/>
- LSUIElement / setActivationPolicy bypass — <https://1-day.medium.com/your-kid-might-be-bypassing-screen-time-app-limits-on-macos-using-this-trick-0fed8225bf79>
- Tech Lockdown, iOS 26 Screen Time changes, updated 2026-04-20 — <https://www.techlockdown.com/articles/ios-26-screen-time-changes>
- iDownloadBlog, App Limits not working, 2026-03-12 — <https://www.idownloadblog.com/2026/03/12/fix-app-limits-not-working/>
- Fone.tips, iOS 26 Screen Time confirmed 2026 bugs — <https://fone.tips/ios-26-screen-time-not-working/>
- Timing, "Screen Time for Mac" ("Downtime cannot force a log out") — <https://timingapp.com/blog/screen-time-for-mac/>
- Mac Observer, Screen Time not updating (sync latency) — <https://www.macobserver.com/iphone/apple-screen-time-not-updating/>

**Prior art — parental control / time limiting**
- PlayCap — <https://github.com/paddler/playcap> · announcement thread <https://forums.macrumors.com/threads/playcap-an-open-source-tool-that-enforces-roblox-time-limits-on-macos-screen-time-cant.2488398/>
- mac-screentime-enforcer — <https://github.com/hselomein/mac-screentime-enforcer> · HA thread (2025-12) <https://community.home-assistant.io/t/i-built-a-home-assistant-controlled-screen-time-enforcer-for-kids-on-macs-open-source-looking-for-parent-testers/962348>
- screen-quota — <https://github.com/mcevoypeter/screen-quota>
- SelfControl — <https://github.com/SelfControlApp/selfcontrol>
- Gate — <https://github.com/Turnonac/screentime-app>
- Allow2 — <https://allow2.github.io/> · <https://github.com/Allow2/Allow2iOS>
- K9 Web Protection (OSS revival) — <https://github.com/khaleel-git/K9-Web-Protection>
- Timekpr-nExT — <https://github.com/skaasjager/timekpr-next> · <https://www.linuxuprising.com/2019/11/timekpr-next-is-linux-parental-control.html>

**Prior art — activity tracking & Screen Time data access**
- ActivityWatch — <https://activitywatch.net/> · <https://docs.activitywatch.net/en/latest/faq.html>
- aw-watcher-window permission issues — <https://github.com/ActivityWatch/activitywatch/issues/376> · <https://github.com/ActivityWatch/aw-watcher-window/issues/60> · <https://github.com/orgs/ActivityWatch/discussions/768>
- **screentime-backup (macOS 26.3 FDA vaulting)** — <https://github.com/alexjmiller5/screentime-backup>
- nichtlegacy/screentime — <https://github.com/nichtlegacy/screentime>
- mac4n6, knowledgeC.db forensics — <https://www.mac4n6.com/blog/2018/8/5/knowledge-is-power-using-the-knowledgecdb-database-on-macos-and-ios-to-determine-precise-user-and-application-usage> [STALE: 2018]
- 0xdevalias, notes on exporting Screen Time data — <https://gist.github.com/0xdevalias/38cfc92278f85ae89a46f0c156208fd5>

**Prior art — device agents & fleet tooling**
- osquery — <https://github.com/osquery/osquery> (5.23.1, 2026-06-24)
- Fleet, fleetd authentication — <https://fleetdm.com/guides/fleetd-authentication>
- Fleet, Orbit — <https://fleetdm.com/docs/using-fleet/orbit>
- Fleet, shut-down-device MDM command — <https://fleetdm.com/mdm-commands/apple-shut-down-device>
- Zentral — <https://github.com/zentralopensource/zentral>
- NanoMDM — <https://github.com/micromdm/nanomdm> · MicroMDM certificates <https://micromdm.io/blog/certificates/>
- Munki — <https://github.com/munki/munki>
- Nudge — <https://github.com/macadmins/nudge>
- Santa — <https://northpole.security/santa>
- SimpleMDM, 20 popular open-source tools for MacAdmins (updated 2025-01-15) — <https://simplemdm.com/blog/popular-open-source-tools-for-mac-admins/>

**macOS platform mechanics**
- Hammerspoon2 issue #224, CGSession path missing, **2026-09-14** — <https://github.com/cmsj/Hammerspoon2/issues/224>
- kCGWindowName requires Screen Recording — <https://gist.github.com/chockenberry/164ab2d3dd76736f81c9e9eed63d81bf> · <https://www.ryanthomson.net/articles/screen-recording-permissions-catalina-mess/>
- AXUIElementCopyAttributeValue failing despite AXIsProcessTrusted — <https://developer.apple.com/forums/thread/794253>
- SACLockScreenImmediate — <https://blog.timac.org/2016/0605-programmatically-lock-the-screen/> [STALE: 2016]
- ernw macOS 26 Tahoe hardening guide — <https://github.com/ernw/hardening/blob/master/operating_system/osx/26/Hardening_Guide-macOS_26_Tahoe_1.0.md>
- macOS TCC reference — <https://hacktricks.wiki/en/macos-hardening/macos-security-and-privilege-escalation/macos-security-protections/macos-tcc/index.html>
- pmset reference — <https://ss64.com/mac/pmset.html> · <https://www.dssw.co.uk/blog/2024-05-02-scheduled-shut-down-macos/>
- Apple, The Life Cycle of a Daemon — <https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/Lifecycle.html>

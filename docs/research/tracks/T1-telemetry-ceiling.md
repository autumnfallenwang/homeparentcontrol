# T1 — Target Capability Ceiling: Telemetry & Permission Cost

**Project:** homeparentcontrol · **Track:** T1 (critical path) · **Author:** research agent
**Date probed:** 2026-09-18 · **Host = target spec:** macOS 26.6.2 (build 25G83), Darwin 25.6.0, arm64 (Apple Silicon T8132)
**Probe user:** `nicolewang` (uid 501), member of `admin`. All probes run as a **non-root** GUI user. Read-only. No settings changed, no consent dialogs fired.

> **Important host caveat that shapes several results:** the terminal running these probes (**iTerm2**) **already holds Screen Recording** TCC permission (`CGPreflightScreenCaptureAccess()` → `true`, verified below). This means window-title results here reflect the *granted* state. It does **not** affect the permission-free probes (lsappinfo, NSWorkspace, ioreg, pmset, last, log) — those need no TCC and would behave identically on a clean machine.

> **OS-version scope (cross-track T7):** All empirical results here are on **macOS 26.6.2**. Per T7, **macOS 27 "Golden Gate" shipped 2026-09-14** (four days before this probe); nothing here was tested on 27. **Version-fragile items to re-verify on 27:** (a) TCC/FDA reach into `knowledgeC.db`, Biome, and Daemon Containers (Apple has been steadily vaulting these — see T1.3); (b) `CGWindowListCopyWindowInfo` redaction semantics; (c) BTM daemon-gating disposition (see T1.8); (d) unified-log `<private>` redaction defaults. Items that are pure BSD/POSIX (`ps`/`%cpu`, `ioreg` `HIDIdleTime`, `last`/wtmp, `pmset -g log`) are the **least** version-fragile.

---

## VERDICT ON THE HYPOTHESIS

**Hypothesis:** *"App-level usage is obtainable permission-free; window titles and URLs are gated behind Screen Recording / Accessibility."*

**CONFIRMED, with one refinement on URLs.**

- **App-level usage — permission-free: CONFIRMED.** Foreground app bundle-id/name, **per-process CPU** (enables CPU-gated time accounting), idle time, and power/session/login events are all readable by an ordinary process with **no TCC prompt and no TCC grant**. A root LaunchDaemon can sample all of these directly — and crucially, so can even a *pure-bash* daemon, since these need no code-identity grant (unlike everything below).
- **Window titles — gated behind Screen Recording: CONFIRMED.** `CGWindowListCopyWindowInfo`'s `kCGWindowName` is populated here only because the host has Screen Recording; without it the key is redacted (empty/absent) for other apps' windows. (Accessibility/`AXUIElement` is an *alternate* route to the same data behind a *different* grant — Accessibility TCC.)
- **URLs — gated, but behind a DIFFERENT tier than titles: REFINED.** A browser's **active-tab URL** is not exposed by Screen Recording at all. It requires **Apple Events / Automation TCC** (per-browser, e.g. "control Google Chrome"). What Screen Recording leaks is the **page *title*** (it appears in the window title), not the URL. So: **titles → Screen Recording; URLs → Automation/AppleEvents.**
- **Bonus ceiling item:** Apple's own aggregated usage (**Screen Time / `knowledgeC.db`**) is gated behind **Full Disk Access** — the richest single source, but the highest-friction grant.

**One-line permission ceiling:** *Foreground app + idle + power/session are free; add Screen Recording for window/page titles; add per-browser Automation for URLs; add Full Disk Access for Apple's pre-aggregated Screen Time / knowledgeC history — and for a headless daemon every one of those grants must be pre-provisioned by MDM/PPPC or a manual one-time add, keyed to a STABLE code signature or it dies on the next update.*

---

## THE TABLE

| Signal | Command / API | Permission required | Grantable at install for a headless daemon? | Verified? |
|---|---|---|---|---|
| Foreground app bundle-id / name / pid | `lsappinfo front` → `lsappinfo info -only bundleid <asn>` | **None** | N/A (no grant needed) | ✅ ran it here |
| Foreground app (alt) | Swift `NSWorkspace.shared.frontmostApplication` / `.menuBarOwningApplication` | **None** | N/A | ✅ ran it here |
| Foreground app (System Events route) | `osascript -e 'tell app "System Events" to …frontmost…'` | **Automation TCC** (control System Events) — *prompts* | Only via MDM/PPPC (targets `/usr/bin/osascript`); no UI grant for headless | 🌐 research only (NOT fired — would prompt) |
| Full list of running apps | `lsappinfo list` / `NSWorkspace.runningApplications` | **None** | N/A | ✅ ran it here |
| **Per-process CPU** (PlayCap-style activity gating) | `ps -A -o pid,%cpu,time,comm`; `top -l 1`; `ps -p <pid> -o %cpu` | **None** | N/A | ✅ ran it here |
| User idle time (HID) | `ioreg -c IOHIDSystem` → `HIDIdleTime` (nanoseconds) | **None** | N/A | ✅ ran it here |
| Console / logged-in user | `stat -f%Su /dev/console`; `scutil` `State:/Users/ConsoleUser` | **None** | N/A | ✅ ran it here |
| Window titles (any app) | `CGWindowListCopyWindowInfo` → `kCGWindowName` | **Screen Recording TCC** (silently redacted without it; **no prompt** from this API) | Yes — MDM/PPPC `ScreenCapture`, or one-time manual add; keyed to code signature | ✅ ran it here (host has SR; titles returned) |
| Window titles (alt route) | Accessibility `AXUIElementCopyAttributeValue(kAXTitle)` | **Accessibility TCC** | Yes — MDM/PPPC `Accessibility`, or manual add | 🌐 research only (not fired — needs grant) |
| Browser active-tab **URL** | `osascript -e 'tell app "Google Chrome" to get URL of active tab of front window'` (Safari: `URL of front document`) | **Automation TCC**, per-browser (+ Safari also needs "Allow JavaScript from Apple Events" for some ops) | Only via MDM/PPPC `AppleEvents` (source→target pair); *no* System-Settings UI path | 🌐 research only (NOT fired — would prompt) |
| Apple Screen Time / app-usage history | `sqlite3 ~/Library/Application Support/Knowledge/knowledgeC.db` (`ZOBJECT`, stream `/app/inFocus`) | **Full Disk Access** | Yes — MDM/PPPC `SystemPolicyAllFiles`, or manual add; keyed to code signature | ✅ ran it here (denied: *Operation not permitted*) |
| System-wide CoreDuet knowledge | `/private/var/db/CoreDuet/Knowledge/knowledgeC.db` | **Full Disk Access** (+ dir is root-only) | Yes — MDM/PPPC `SystemPolicyAllFiles` | ✅ ran it here (denied: *Permission denied*) |
| Sleep / wake / display-on / assertions | `pmset -g log` | **None** | N/A | ✅ ran it here |
| Login / logout / app launch / screensaver | `log show --predicate 'process=="loginwindow"'` (use `/usr/bin/log`) | **None** (some fields `<private>`-redacted) | N/A | ✅ ran it here |
| Login / reboot / shutdown history | `last`, `last reboot` (wtmp) | **None** | N/A | ✅ ran it here |
| TCC state itself (who has what) | `sqlite3 …/com.apple.TCC/TCC.db` | **Full Disk Access** | Yes (MDM/PPPC) | 🌐 research only (FDA-gated, same class as knowledgeC) |
| Biome (activity streams) | `~/Library/Biome/…` | **Full Disk Access** | Yes (MDM/PPPC) | ✅ ran it here (denied: *Operation not permitted*) |
| launchd registration of a daemon (path/state/loaded) | `launchctl print system/<label>`; `launchctl dumpstate` | **None** | N/A | ✅ ran it here |
| **BTM disposition** (allowed/disallowed, developer attribution) | `sudo sfltool dumpbtm` | **root (sudo)**; BTM store is TCC/SIP-protected | N/A (inspection only) | 🌐 research only (store = *Operation not permitted* w/o sudo; ran that denial) |

---

## PER-QUESTION FINDINGS

### T1.1 — Foreground app identity with NO TCC prompt? → **YES, two independent permission-free routes.**

**`lsappinfo` (ran):**
```
$ lsappinfo front
ASN:0x0-0x11011:
$ lsappinfo info -only bundleid ASN:0x0-0x11011:
"CFBundleIdentifier"="com.microsoft.VSCode"
"LSDisplayName"="Code"
"pid"=514
```
No permission, no prompt. `lsappinfo list` also enumerates every running app with bundle id, path, launch/checkin times, coalition, and foreground/background type — all free.

**`NSWorkspace` via `swift` (ran; `/usr/bin/swift` present):**
```
frontmost.localizedName=Windows App
frontmost.bundleIdentifier=com.microsoft.rdc.macos
frontmost.pid=483
menuBarOwning.bundleIdentifier=com.microsoft.rdc.macos
runningApps.count=81
```
`NSWorkspace.frontmostApplication` is permission-free. (Bundle id differs from the `lsappinfo` sample only because focus changed between calls — both are correct, both free.)

**System Events via `osascript` — NOT fired.** `tell application "System Events" to get name of first application process whose frontmost is true` returns the same fact, **but triggers an Automation ("wants to control System Events") consent prompt**, attributed to the responsible process (the daemon / `osascript`). For a headless daemon there is no one to click it. **Do not use this route** — the two permission-free routes above make it unnecessary.

**Conclusion:** foreground app identity is **permission-free**. Use `lsappinfo` or `NSWorkspace`, never System Events.

### T1.2 — Does root bypass TCC? → **NO. Verified by mechanism + local corroboration.**

Root does **not** bypass TCC. TCC is enforced above POSIX ownership and above root: the databases are protected by SIP (system TCC.db) and by TCC itself (user TCC.db), and FDA/Screen Recording/Automation are grants that a uid-0 process still does not implicitly hold. Sources: SentinelLabs, Huntress, Eclectic Light, HackTricks (all consistent).

**Local corroboration (ran):** `~/Library/Application Support/Knowledge/knowledgeC.db` is mode `-rw-r--r--`, owned by `nicolewang` — plain POSIX says *any* process (certainly root) can read it. Yet:
```
$ ls -la ~/Library/Application Support/Knowledge/
ls: .../Knowledge/: Operation not permitted
```
The block is **TCC, not POSIX** — proving TCC overrides ordinary file permissions and, by the same mechanism, would override root. A root LaunchDaemon therefore gains **nothing** toward FDA/Screen Recording/Automation from being root; those must be granted explicitly (see T1.7). *(Strict verification that uid-0 is refused would need a root probe, which needs sudo — not run. Marked mechanism-verified + corroborated, not root-executed.)*

### T1.3 — Apple Screen Time / `knowledgeC.db` readable? → **Only with Full Disk Access.**

**User DB (ran):** file exists, 92 MB, mode 644, owned by user — but the containing `Knowledge/` directory returns **`Operation not permitted`** on `ls`, and `sqlite3 file:…knowledgeC.db?mode=ro` fails to open. This is TCC / Full Disk Access gating.
```
$ stat ~/Library/Application Support/Knowledge/knowledgeC.db
-rw-r--r-- 92147712 nicolewang .../knowledgeC.db      # exists, 92MB
$ sqlite3 "file:$HOME/Library/Application Support/Knowledge/knowledgeC.db?mode=ro" "SELECT count(*) FROM sqlite_master;"
Error: unable to open database file
$ ls ~/Library/Application Support/Knowledge/
Operation not permitted
```
**System CoreDuet DB (ran):** `/private/var/db/CoreDuet/Knowledge/knowledgeC.db` → `stat: Permission denied` (root-owned directory *and* TCC-protected).

**Has Apple tightened it?** Yes, historically. `knowledgeC.db` was freely readable pre-Catalina; since macOS 10.15 the `Knowledge/` store has been behind **Full Disk Access**, and that remains true on 26.6.2 (confirmed empirically here). It still records the high-value `/app/inFocus` stream (which app was frontmost and for how long), plus backlight/lock, power state, and Now-Playing metadata (mac4n6, Belkasoft, forensics sources). **With FDA granted, it is readable and is the single richest usage source** (pre-aggregated timeline, no polling needed). Without FDA it is completely opaque. This is the strongest argument for provisioning FDA (T1.7).

**Cross-track T7 (further vaulting, probed here):** T7 reports that on **macOS 26.3** Apple moved `RMAdminStore-*` (Screen Time / remote-management store) and DeviceActivity captures **beyond FDA** — EPERM *even with FDA granted* — while `knowledgeC.db` and Biome remain FDA-readable on 26.x (unverified on 27). What I can add empirically on this 26.6.2 host (all read-only, no FDA granted):
- `~/Library/Biome/` → **`Operation not permitted`** (TCC/FDA-gated, consistent with "readable *with* FDA").
- `~/Library/Daemon Containers/` → **`Operation not permitted`** (this is the stronger "data-protection / vaulted" class; a signed daemon container is *not* opened by FDA alone — matches T7's "beyond FDA" claim, though I could not run the with-FDA test).
- Real `~/Library/Application Support/com.apple.remotemanagementd/` (where `RMAdminStore-Local.sqlite` lives on a managed Mac) → **`No such file or directory`**: this user is **not** enrolled in Screen Time/Family, so there is no live specimen here. (The only `RMAdminStore-*.sqlite` files on disk are inside a **CoreSimulator** device image — simulator data, not the host, and not representative.)
- `~/Library/Application Support/com.apple.ScreenTimeAgent/` → does not exist here.

I **cannot refute** T7's "EPERM even with FDA" claim (that needs FDA granted, which I won't do), so it stays **researched-not-verified**; but the Daemon-Containers denial is consistent with it. **Net operational read: T7's conclusion "do not build core telemetry on Apple's own data" is well-supported** — the best source (knowledgeC) needs FDA and is version-fragile, and the Screen-Time/DeviceActivity stores are being actively locked down release-over-release. Treat Apple data as a *nice-to-have if FDA is provisioned*, never the foundation.

### T1.4 — Window titles & browser URLs — which tier?

**Window titles → Screen Recording (verified positive).** `CGWindowListCopyWindowInfo` does **not** show a prompt (by design it silently limits its output). With Screen Recording it returns real titles; without it, `kCGWindowName` is redacted for other apps' windows.
```
CGPreflightScreenCaptureAccess (has Screen Recording?): true      # host iTerm2 IS granted
--- windows at layer 0 (normal app windows) ---
owner=Visual Studio Code  title="Preview poc2-plan.md — homeparentcontrol"
owner=iTerm2              title="nicolewang@Nicoles-MacBook-Air:~/Deloitte/SSO_SLO_TEST/POC_091726_2"
owner=Windows App         title="Devices"
owner=Google Chat         title="Google Chat - Chat"
owner=Google Chrome       title="Your Repositories"      # <-- active TAB TITLE leaks via window title
```
Because the host holds Screen Recording, titles came back — including a Chrome window title equal to its **active tab's page title** ("Your Repositories"). On a machine **without** Screen Recording, `kCGWindowName` would be `<absent>`/`<empty>` for these (well-documented; the negative case is 🌐 research, since I won't revoke the host's grant). `CGPreflightScreenCaptureAccess()` is the **non-prompting** way for the daemon to check whether it currently holds the grant (safe to call; `CGRequestScreenCaptureAccess()` is the one that prompts — do not call it headless).

**Browser URLs → Automation / Apple Events (NOT fired).** Screen Recording gives you the page **title**, never the **URL**. The URL requires scripting the browser:
`osascript -e 'tell application "Google Chrome" to get URL of active tab of front window'` (Safari: `get URL of front document`). This triggers a per-browser **Automation** consent prompt ("… wants to control Google Chrome") — a *different, per-target* TCC service from Screen Recording, and one that **cannot** be granted through the System Settings UI for a headless tool (see T1.7). Not fired here.

**Net:** app + page **title** are one Screen-Recording grant away; the **URL** is a separate per-browser Automation grant.

**Cross-track T7 — silent failure (important design risk):** T7 flags that window-title capture needs **Screen Recording, NOT Accessibility**, and that it **fails silently** — degraded data with *no prompt and no error*. This matches the API contract exactly and is the worst-case failure mode for this design: a probe that **looks like it succeeded** but returns `<empty>`/absent titles. I could not reproduce the *negative* here because the host holds Screen Recording (so titles are populated), but the behavior is structurally confirmed: `CGWindowListCopyWindowInfo` **returns success and raises nothing** whether or not you hold the grant — the only difference is whether `kCGWindowName` is present. **Mitigation the daemon MUST implement:** call `CGPreflightScreenCaptureAccess()` (non-prompting) at startup and before trusting any title, and treat a `false` there — or an all-`<empty>` `kCGWindowName` set across other-app windows — as "capability absent," not "user is idle / no windows." Do **not** call `CGRequestScreenCaptureAccess()` from the daemon (it prompts).

### T1.5 — Idle vs merely-logged-in → **Permission-free.**
```
$ ioreg -c IOHIDSystem | grep HIDIdleTime
"HIDIdleTime" = 1707840458        # nanoseconds since last HID input (~1.7 s here)
```
`HIDIdleTime` is in **nanoseconds** (divide by 1e9 for seconds). No permission, no prompt. This cleanly distinguishes "actively using" from "logged in but idle" and is the correct signal for real screen-time accounting (vs. session-open time). Console user is also free via `scutil`/`stat /dev/console` (`kCGSSessionOnConsoleKey=TRUE` when at the physical console).

### T1.6 — Power / session / login events — availability & history depth (all permission-free).

- **`pmset -g log` (ran):** sleep/wake/dark-wake, display on/off, power assertions (incl. `caffeinate`), lid, charge. **Retention ≈ 7 days** here (earliest line 2026-09-11, ~22 k lines). Backed by `/var/log/powermanagement`.
- **`log show --predicate …` (ran; call it as `/usr/bin/log` — a shell function named `log` shadows it in this user's zsh):** `process == "loginwindow"` yields app launch/exit, check-in, screensaver, `com.apple.loginwindow.logging` events; screensaver/lock events queryable. Some fields print as `<private>` (Apple's log redaction) unless a debug profile is installed. **Retention:** earliest queryable entry here ≈ **2026-08-19 (~30 days)**; but the dense `Persist/*.tracev3` store only spans ~1.5 days (Sep 17→18) at this logging volume — i.e. **detailed unified-log history is volume-bounded and short; do not rely on it for long look-back.**
- **`last` / `last reboot` (ran):** login/logout/reboot/shutdown. **wtmp reaches back to 2025-10-23 (~11 months)** — by far the longest cheap history for session boundaries.
```
$ last | head
nicolewang ttys000   Fri Sep 18 10:10   still logged in
nicolewang console   Thu Sep 17 18:14   still logged in
reboot  time         Thu Sep 17 18:14
$ last reboot | head
reboot time  Thu Sep 17 18:14
reboot time  Fri Aug 28 21:51
reboot time  Sun Jul 26 07:00
```
**Guidance:** for durable long-term session/uptime history use `last`/wtmp (months); for recent power detail use `pmset` (~1 week); use `log show` for rich recent event detail only (days). None require a TCC grant.

### T1.7 — Can a TCC grant be given ONCE at install and persist for a headless (no-GUI) daemon?

**Short answer: YES for FDA and Screen Recording, and even for Automation — but only if you do BOTH of (a) provision it non-interactively and (b) sign the daemon with a STABLE identity. Get either wrong and it breaks.**

**The core problem.** A root LaunchDaemon has no GUI session, so it can never receive or click a TCC consent prompt. Every grant must be pre-provisioned. Two provisioning paths:

1. **MDM + PPPC profile (the robust, supported way).** A "Privacy Preferences Policy Control" configuration profile pushed by an MDM can *silently* pre-authorize:
   - `SystemPolicyAllFiles` → **Full Disk Access** (unlocks knowledgeC / Screen Time / TCC.db reads).
   - `ScreenCapture` → **Screen Recording** (unlocks window/page titles). *(Note: on Sequoia+ Screen Recording gained periodic user "reminder" prompts for interactive apps; PPPC-provisioned system daemons are the way to avoid that churn.)*
   - `Accessibility` → alternate window-title route.
   - `AppleEvents` (source→target) → **Automation** to Chrome/Safari for URLs. **This is the *only* way to grant Automation to a headless tool — the System Settings UI has no "add" button for Automation.** Each grant is a (client-requirement, target-requirement) pair.
2. **Manual one-time add in System Settings (works for a lab/self-host, not for fleet).** For **Full Disk Access** and **Screen Recording** you can drag the binary (or "+"-add it) once at install. This works for FDA and SR. It does **not** work for Automation. It requires an admin sitting at the machine once.

**What the grant is tied to — the make-or-break detail.** TCC stores each grant with a **code-signing requirement**, not just a path. Behavior:
- **Ad-hoc / unsigned binary:** TCC pins the grant to the **code-directory hash of that exact build**. Any rebuild or self-update is a *new* identity → **the grant is silently revoked** and (for a headless daemon) cannot be re-granted without a human. This is a real, current failure mode — e.g. the documented case of Full Disk Access being **revoked on every Homebrew update** because the updated binary's signature no longer matches (anthropics/claude-code issue #55661).
- **Signed with a stable Developer ID (Team ID) identity:** provision the grant against a **designated requirement** of the form `identifier "com.you.daemon" and anchor apple generic and certificate leaf[subject.OU] = <TEAMID>`. Then updates that keep the same signing identity **retain the grant** — the path and even the build hash can change; the requirement still matches.
- Declaring the `com.apple.security.files.all` hardened-runtime entitlement additionally helps pin FDA to the team identity rather than the per-build hash.

**Therefore the install-time recipe that persists across agent updates:**
1. Ship the daemon **signed with a stable Apple Developer ID (fixed Team ID + bundle identifier)**, hardened runtime. Never ad-hoc-sign; never re-sign with a throwaway cert per build.
2. Provision grants via an **MDM PPPC profile** whose payload matches that code requirement (identifier + `anchor apple generic` + Team ID) — FDA + Screen Recording, plus AppleEvents→browsers if URLs are wanted. (Self-host fallback: manually add the *signed* binary to FDA and Screen Recording once; accept that Automation/URLs then aren't available without MDM.)
3. Keep the signing identity constant across releases → grants survive updates untouched. Change the Team ID or go unsigned → every update re-locks the agent out.

**Summary for T1.7:** Persistable? **Yes** — FDA and Screen Recording via MDM/PPPC *or* one-time manual add; Automation only via MDM/PPPC. **Survives updates?** Only if the daemon carries a **stable code signature (Team ID)**; the grant is keyed to the signature/requirement, secondarily the path — an unsigned/rotating-signature binary loses the grant on every update.

**Cross-track T7 convergence — what TCC binds to (path vs cdhash vs Team ID):** T7's independent finding matches this track: **TCC binds grants to code identity, subprocesses do not inherit the grant, and grants silently detach on update.** Two consequences that are decisive for the architecture:
- **A pure-bash LaunchDaemon cannot hold a durable TCC grant at all.** A grant would have to attach to `/bin/sh` or `/usr/bin/osascript` (system binaries you can't stably own), and each spawned child is a *new* responsible process that does not inherit anything. So **anything past the permission-free tier (bundle-id, CPU, idle, power/session) requires a signed, notarized, single-binary bundle with a fixed bundle ID + Team ID** — not a script.
- **Attribution granularity:** TCC stores, per service, an `auth_value` plus a **code requirement** (typically `identifier … and anchor apple generic and certificate leaf[subject.OU]=<TEAMID>`). For unsigned/ad-hoc code the effective key degrades to the **cdhash of that exact build** → new build = new identity = silent revoke (the Homebrew/Claude-Code FDA-revoked-on-update case is exactly this). **Path alone is never sufficient.** *I could not read `TCC.db` locally to display the requirement string (it is itself FDA-gated — `Operation not permitted`), so the cdhash-vs-TeamID mechanism is **researched + corroborated by the observed non-inheriting, signature-keyed behavior**, not dumped from this host's TCC.db.*
- **This converges with T1.8 (BTM):** the *same* stable Developer-ID signature that makes TCC grants durable is *also* what BTM requires to attribute a `/Library/LaunchDaemons` daemon to a real developer instead of "Unknown Developer / disallowed." **One decision — sign+notarize with a fixed Team ID — satisfies both.** The prior POC's pure-bash daemon satisfies *neither*.

---

### T1.8 — Background Task Management (BTM) disposition of a LaunchDaemon (handed over from T3)

**T3's claim, and it holds up:** on macOS 26, BTM gates LaunchDaemons by their **entry point**. A plist that invokes `/bin/sh` or points at a bare script is attributed to an **"unidentified / Unknown Developer"** and can be left **disallowed after a reboot**; a Developer-ID-signed binary is attributed to its Team ID and allowed. **This directly threatens the prior POC's pure-bash daemon.**

**What I could observe WITHOUT sudo (ran here):**
- **BTM store is NOT readable without root.** `ls /private/var/db/com.apple.backgroundtaskmanagement/` → **`Operation not permitted`** (TCC/SIP-protected). The store file is `BackgroundItems-v*.btm`. So the *disposition* and *developer attribution* fields are **not** observable without `sudo sfltool dumpbtm`. Clean negative.
- **launchd registration IS readable without root** — but it is a *different* thing from BTM disposition. `launchctl print system/<label>` and `launchctl dumpstate` work as the ordinary user:
  ```
  $ launchctl print system/com.apple.tccd.system
  system/com.apple.tccd.system = {
      path = /System/Library/LaunchDaemons/com.apple.tccd.system.plist
      type = LaunchDaemon
      state = running
      program = /System/Library/PrivateFrameworks/TCC.framework/Support/tccd
  $ launchctl dumpstate | head
  system = { type = system … service count = 424 … }
  ```
  This tells you whether a daemon is **bootstrapped/running and its program path** — useful for the daemon to self-check "am I loaded?" — but it does **not** expose BTM's allowed/disallowed decision. **A daemon can be `state = running` this session yet be `disallowed` in BTM and fail to auto-load after the next reboot.** So `launchctl` is *not* a substitute for `sfltool dumpbtm` here.
- **No POC specimen on this machine:** `/Library/LaunchDaemons/` holds 8 plists, **none** matching home/parent/control/poc; `/Library/LaunchAgents/` likewise. Nothing to inspect, and I installed nothing.

**Is the system-daemon distinction real? YES (researched, macOS-26-specific source).** BTM historically covered only LaunchAgents and login items, but **"as of 14.6.1 it also gates LaunchDaemons under `/Library/LaunchDaemons/` if their executable doesn't carry an Apple Developer signature"** — and this is live on Tahoe/macOS 26. In `sfltool dumpbtm` output the field is literally **`Disposition:`**, e.g. `Disposition: [enabled, disallowed, notified]`, and a script/unsigned daemon shows **`Parent Identifier: Unknown Developer`** (System Settings shows *"Item from unidentified developer"*). Manual `launchctl bootstrap` **"evaporates across reboots"** because BTM re-blocks it at boot. (Sources: mgaebler.me "When macOS Tahoe breaks Nix: it's BTM"; Eclectic Light "In the background: Identification", 2026-02; Objective-See `DumpBTM`.)

**Reconciling with "the POC worked":** a pure-bash daemon can appear to work **in the session it is manually bootstrapped** (hence the POC report), but as an unsigned/script entry point its BTM `Disposition` is liable to be `disallowed` and it **will not reliably auto-load after reboot** without a human toggling *Login Items & Extensions → Allow in the Background* ON — which a headless deployment can't do. **This is a genuine invalidation risk for the pure-bash design and converges with T1.7:** the fix for both BTM attribution *and* durable TCC grants is the **same** — ship a **Developer-ID-signed, notarized single binary with a fixed bundle ID + Team ID**, not a shell script.

*Status: launchd-observable facts ✅ ran here; BTM store denial ✅ ran here; BTM disposition/attribution semantics 🌐 researched-not-verified (needs `sudo sfltool dumpbtm`).*

---

## WHAT THE USER MUST RUN INTERACTIVELY (these WOULD prompt / need a grant / need sudo — I did not fire them)

1. **Confirm the System-Events Automation prompt behavior for foreground app** (optional; the permission-free routes already cover this):
   ```
   osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true'
   ```
   Expect a one-time "wants to control System Events" dialog.

2. **Browser active-tab URL (the real gap — needs per-browser Automation):**
   ```
   osascript -e 'tell application "Google Chrome" to get URL of active tab of front window'
   osascript -e 'tell application "Safari" to get URL of front document'
   ```
   Each pops a per-browser Automation consent dialog. Confirms URLs are reachable *only* with Automation granted.

3. **Prove knowledgeC / Screen Time is readable once FDA is granted:** in System Settings → Privacy & Security → **Full Disk Access**, add the terminal (or the signed daemon binary), then:
   ```
   sqlite3 "$HOME/Library/Application Support/Knowledge/knowledgeC.db" \
     "SELECT ZOBJECT.ZVALUESTRING AS app, (ZOBJECT.ZENDDATE-ZOBJECT.ZSTARTDATE) AS secs
      FROM ZOBJECT WHERE ZSTREAMNAME='/app/inFocus' ORDER BY ZSTARTDATE DESC LIMIT 20;"
   ```
   This turns the current *Operation not permitted* into rows, verifying the FDA payoff.

4. **Confirm the Screen-Recording *negative* case** (only if a clean baseline is wanted): run the `CGWindowListCopyWindowInfo` snippet from a process that does **not** hold Screen Recording (e.g. a freshly built unsigned binary) and observe `kCGWindowName` come back `<absent>`/`<empty>` for other apps. On this host it cannot be shown because iTerm2 already holds the grant.

5. **BTM disposition of a LaunchDaemon (T1.8) — needs sudo, so run it yourself:**
   ```
   sudo sfltool dumpbtm > ~/Documents/btmdump.txt ; open ~/Documents/btmdump.txt
   ```
   **What to look for:** for each background item, the **`Disposition:`** line (e.g. `[enabled, disallowed, notified]` vs `[enabled, allowed]`) is the allowed/blocked verdict; the **developer attribution** — a script/unsigned daemon reads `Parent Identifier: Unknown Developer` (and shows as *"Item from unidentified developer"* in System Settings → Login Items & Extensions), whereas a Developer-ID-signed binary shows a real **`Developer Name`/Team Identifier**. Compare a script-based daemon's entry against a signed binary's entry. Anything with `disallowed` will not auto-load at the next boot. *(Objective-See's `DumpBTM` tool gives the same output.)*

6. **RMAdminStore / DeviceActivity "beyond FDA" test (T1.3, T7 claim):** on a Mac actually enrolled in Screen Time, grant Terminal FDA, then attempt to read `~/Library/Application Support/com.apple.remotemanagementd/RMAdminStore-Local.sqlite`. If it returns **EPERM even with FDA**, that confirms Apple vaulted it beyond FDA (T7's claim). This host is not Screen-Time-enrolled, so the file does not exist here to test.

---

## EVIDENCE APPENDIX (trimmed command output)

**Environment (ran):**
```
ProductVersion: 26.6.2   BuildVersion: 25G83
Darwin 25.6.0 … RELEASE_ARM64_T8132 arm64
uid=501(nicolewang) groups=…,80(admin),204(_developer)…
/usr/bin/swift  /usr/bin/swiftc   (Xcode at /Applications/Xcode.app)
```

**Idle (ran):** `"HIDIdleTime" = 1707840458` (ns).

**knowledgeC denials (ran):** user dir `ls` → `Operation not permitted`; sqlite open → `unable to open database file`; CoreDuet `stat` → `Permission denied`.

**Screen Recording preflight (ran):** `CGPreflightScreenCaptureAccess … : true` (host is granted → titles visible, incl. Chrome tab title "Your Repositories").

**pmset retention (ran):** earliest log line `2026-09-11` (~7 days).

**Unified log (ran, via `/usr/bin/log`):** earliest queryable entry `2026-08-19` (~30 days); `Persist/*.tracev3` span Sep 17→18 (~1.5 days dense).

**last / wtmp (ran):** `wtmp begins Thu Oct 23 20:46:53 EDT 2025` (~11 months of session history).

**Per-process CPU (ran):** `ps -A -o pid,%cpu,time,comm` and `top -l 1` both return per-PID `%CPU` with no permission; `ps -p 514 -o %cpu` → `2.6  /Applications/Visual Studio Code.app/…/Code`. Bridge PID→bundle-id via `lsappinfo`/`NSWorkspace`. **Enables PlayCap-style CPU-gated time accounting (charge budget only when a process is actually busy, not merely alive) entirely permission-free.**

**BTM / launchd (ran):** `/private/var/db/com.apple.backgroundtaskmanagement/` → `Operation not permitted`; `launchctl print system/com.apple.tccd.system` → shows `path=…/com.apple.tccd.system.plist type=LaunchDaemon state=running`; `launchctl dumpstate` → `service count = 424` (both without sudo). `/Library/LaunchDaemons/` = 8 plists, no POC.

**Vaulted Apple data (ran):** `~/Library/Biome/` → `Operation not permitted`; `~/Library/Daemon Containers/` → `Operation not permitted`; real `~/Library/Application Support/com.apple.remotemanagementd/` → `No such file or directory` (host not Screen-Time-enrolled).

---

## SOURCE NOTES (research-only items)

- Root ≠ TCC bypass; TCC/SIP protect the databases: SentinelLabs "Bypassing macOS TCC…", Huntress "Full Transparency", Eclectic Light "Explainer: Permissions, privacy and TCC" (2025-11), HackTricks macOS-TCC.
- `CGWindowListCopyWindowInfo` does not prompt and redacts `kCGWindowName` without Screen Recording: soffes `canRecordScreen` gist, Apple Dev Forums thread 706187, Ghostie-Shimeji issue #29.
- Automation/AppleEvents to System Events/browsers prompts and can only be pre-granted via PPPC targeting `/usr/bin/osascript` or the signed client; sandbox/headless AppleEvents to System Events are refused with no promptable path: scriptingosx "Avoiding AppleScript Security…", Jamf community PPPC threads, loom issue #6366 / PR #6367.
- FDA keyed to code signature and revoked on update unless team-identity-pinned: anthropics/claude-code issue #55661, TheRobBrennan podcast-queue-report PR #31, Karol Mazurek "Snake&Apple IX — TCC", Apple Dev Forums 801461.
- knowledgeC `/app/inFocus`, FDA-gated, Screen Time location: mac4n6 "Knowledge is Power!", Belkasoft "KnowledgeC Database Forensics", 0xdevalias gist "accessing/exporting Apple's Screen Time data", Retrospect "macOS Sequoia/Tahoe Application Data Privacy — Full Disk Access".
- BTM gates system LaunchDaemons since 14.6.1, `Disposition:` / `Unknown Developer` attribution, blocks survive reboots: mgaebler.me "When macOS Tahoe breaks Nix: it's BTM", Eclectic Light "In the background: Identification" (2026-02) and "Manage Login and Background items" (2025-12), Objective-See `DumpBTM`, ss64 `sfltool`.

*Discrepancy / staleness flags:* exact unified-log retention is volume-dependent (here ~30 days queryable but only ~1.5 days dense) — treat as a soft ceiling, not a guarantee. The Screen-Recording *negative* (redaction without the grant) is documented but not reproduced here because the host already holds the grant. The root-refusal of knowledgeC is inferred from the TCC mechanism + observed non-root denial, not executed as uid 0 (would need sudo).

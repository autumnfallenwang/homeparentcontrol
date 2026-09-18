# T2 — Agent runtime, notifications and code signing

**Research date:** 2026-09-18
**Target:** headless agent on a child's Mac mini (Apple Silicon, macOS 26), running as a root LaunchDaemon.
**Prior art:** ~240-line bash POC using `osascript` for notifications; notifications attributed to "Script Editor"; cannot be Time Sensitive; workaround is a modal `display dialog` for the final warning.

> **Sourcing note.** Everything load-bearing below is cited to Apple (developer.apple.com / support.apple.com) where Apple documents it. Where Apple does *not* document something and I am relying on third-party reports or on reasoning, it is explicitly marked **[INFERENCE]** or **[THIRD-PARTY]**. Apple's requirements in this area have shifted across releases and some of Apple's own pages are missing or stale — those are flagged inline.

---

## TL;DR

**Two decisions, and the brief conflated them. Separate them.**

1. **BUILD the Swift `.app` notifier — $0. GO.** An ad-hoc signed bundle already fixes most of what the POC lacks: real app name and icon, its own System Settings entry, notification actions. It also satisfies two *hard* constraints that have nothing to do with notifications (BTM and TCC both require a Mach-O/bundled identity). And it makes the $99 a later, reversible decision.
2. **DON'T buy the $99 Apple Developer Program yet — NO-GO, with one named trigger to revisit.** It is **recurring, not one-off**: Time Sensitive needs an embedded provisioning profile, and Apple evaluates that profile **at every app launch** — *"if your Developer ID provisioning profile expires, the app will no longer launch."* Let the membership lapse and the notifier stops working. The free path has no such cliff.

**Time Sensitive requires the paid $99/yr program. There is no free path.** Apple's own capability matrix marks "Time Sensitive Notifications" ✅ for ADP and Developer ID and ❌ for the free tier. It is a *restricted* entitlement: without an embedded provisioning profile, AMFI kills the app at spawn (`-413`). Ad-hoc signing cannot obtain a profile.

**But the $99 buys a break-through the child can switch off in two clicks** — System Settings > Notifications > [app] > "Allow time sensitive alerts", or System Settings > Focus > "Time Sensitive Notifications". Apple documents this: *"The user can turn off the ability for time sensitive notification interruptions."* And **no configuration profile can force it back on** — the MDM notifications payload has no time-sensitive key.

**Apple's own recommended API for this exact situation is free and stronger.** `CFUserNotification` — *"Use `CFUserNotification` in processes that do not otherwise have user interfaces, but may need occasional interaction with the user"* — is a dialog, not a notification, so Focus cannot suppress it and the child has no toggle for it. It supports 3 buttons and a timeout. **The POC's modal-dialog workaround was the right instinct; `CFUserNotification` is that instinct done properly.**

**Language: Swift.** Runner-up Go. bash and Python are eliminated by a hard constraint (BTM requires a Mach-O daemon entry point — Apple DTS's explicit advice), not by preference. Python additionally **is not on the machine at all**: `/usr/bin/python3` is a 78-hard-link `xcode-select` shim, not an interpreter. Swift's two historical drawbacks are both gone — **the Swift runtime ships inside the OS's dyld shared cache**, and the whole compile/bundle/sign chain works with **Command Line Tools only, no Xcode** (both verified on-machine).

**Three things to know that were not in the brief:**
- **`osascript display notification` may already be silently broken on macOS 26/27.** It returns exit 0 while `com.apple.ScriptEditor2` has no notification registration at all. If so, the POC has no working notification path today. **Verify on the target machine first.**
- **macOS 27 "Golden Gate" shipped 2026-09-14.** Reviewed in full: **no change contradicts anything here.** New: launchd will not load a `.plist` carrying `com.apple.quarantine`.
- **Nothing this project installs is ever quarantined** (measured: scp/rsync/local builds/tar extraction all produce `com.apple.provenance`, never `com.apple.quarantine`), so **Gatekeeper never assesses it and notarization is irrelevant.** `spctl -a` says "rejected" for a local ad-hoc binary that runs perfectly.

---

# T2.2 — Time Sensitive notifications

## What Time Sensitive actually is

`UNNotificationInterruptionLevel.timeSensitive` — macOS **12.0+**, so fully available on macOS 26.

Apple's documented behaviour:

> "The system presents the notification immediately, lights up the screen, can play a sound, and breaks through system notification controls."
>
> "Time Sensitive notifications are similar to active notifications, but can break through system controls such as Notification Summary and Focus. **The user can turn off the ability for time sensitive notification interruptions.**"

— <https://developer.apple.com/documentation/usernotifications/unnotificationinterruptionlevel/timesensitive>

That last sentence is the crux of the whole go/no-go. See "The defeat surface" below.

## The four things you need

### 1. The entitlement — `com.apple.developer.usernotifications.time-sensitive`

This is the Xcode capability **"Time Sensitive Notifications"**. It is a *restricted* entitlement: it must be authorized by a provisioning profile.

> **Stale-docs flag.** Apple has **no live documentation page** for this entitlement. `https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.usernotifications.time-sensitive` returns **HTTP 404**, and the key does not appear anywhere in Apple's `bundleresources` documentation index (only `...usernotifications.critical-alerts` and `...usernotifications.filtering` are indexed). The entitlement is nonetheless real and is listed as a supported capability in Apple's account help (below). Treat any third-party page that cites an Apple doc URL for this entitlement as citing a dead link.

### 2. The authorization option — **do not use it, it is deprecated**

`UNAuthorizationOptions.timeSensitive` exists but is **deprecated on macOS from 12.0 — the same version that introduced it.** Apple's deprecation message is literally:

> "Use time-sensitive entitlement"

— <https://developer.apple.com/documentation/usernotifications/unauthorizationoptions/timesensitive>

So the answer to "which authorization option?" is: **none**. You request plain `[.alert, .sound]` (and `.badge` if wanted) and the *entitlement* is what grants the capability. Any guide telling you to pass `.timeSensitive` to `requestAuthorization` is written against the iOS 15 beta behaviour and is stale.

At runtime you can read back whether it actually stuck via `UNNotificationSettings.timeSensitiveSetting` (macOS 12.0+) — <https://developer.apple.com/documentation/usernotifications/unnotificationsettings/timesensitivesetting>. **Do this.** See the silent-degradation trap below.

### 3. Info.plist keys

There is **no dedicated Info.plist key for Time Sensitive.** The interruption level is set per-notification in code:

```swift
let content = UNMutableNotificationContent()
content.title = "15 minutes left"
content.interruptionLevel = .timeSensitive   // the whole point
```

What the Info.plist *does* need is to make the process a legitimate app bundle:

| Key | Value | Why |
|---|---|---|
| `CFBundleIdentifier` | e.g. `com.yourname.hpc.notifier` | **Load-bearing.** This is the notification's identity, the System Settings > Notifications entry, and the App ID the provisioning profile is tied to. |
| `CFBundlePackageType` | `APPL` | Marks it an app, not a bundle/plugin. |
| `CFBundleExecutable` | binary name | Standard. |
| `CFBundleName` / `CFBundleDisplayName` | e.g. `Screen Time` | The name the child sees on the banner. |
| `CFBundleIconFile` | `.icns` name | Without this the banner gets a generic icon. |
| `CFBundleShortVersionString`, `CFBundleVersion` | | Required for a valid bundle. |
| `LSMinimumSystemVersion` | `12.0`+ | |
| `LSUIElement` | `true` | Headless helper: no Dock icon, no menu bar. This is what `terminal-notifier` does. |

### 4. A provisioning profile at `Contents/embedded.provisionprofile`

This is the part people miss, and it is where the money goes. Apple documents the mechanism in **"Signing a daemon with a restricted entitlement"**:

> "Some APIs are usable from a daemon but require that the daemon claim a restricted entitlement that's authorized by a provisioning profile... This is problematic because a daemon is a standalone executable, so you can't embed a provisioning profile in it. **To get around this limitation, wrap your daemon in an app-like structure.**"

and the resulting layout:

```
MyDaemon.app/
  Contents/
    Info.plist
    MacOS/MyDaemon
    PkgInfo
    _CodeSignature/CodeResources
    embedded.provisionprofile      <-- this authorizes the restricted entitlement
```

> "Note the presence of the embedded provisioning profile; it's this profile that authorizes your daemon to use the entitlement."

— <https://developer.apple.com/documentation/xcode/signing-a-daemon-with-a-restricted-entitlement>

A provisioning profile is generated from a **registered App ID with the capability enabled**, in Certificates, Identifiers & Profiles — which is behind Apple Developer Program membership.

## Does it require a paid account? **Yes. Unambiguously.**

Apple's account help page **"Supported capabilities (macOS)"** is a three-column matrix. I parsed the live page (the checkmarks are icons, not text, so they don't survive a naive text scrape):

| Capability | ADP | Developer ID | Apple Developer |
|---|:---:|:---:|:---:|
| **Time Sensitive Notifications** | ✅ | ✅ | ❌ |
| Communication Notifications | ✅ | ✅ | ❌ |
| Push notifications | ✅ | ✅ | ❌ |
| App Sandbox | ✅ | ✅ | ✅ |
| Hardened runtime | ✅ | ✅ | ✅ |

Apple's own definitions of those columns, from the same page:

> **ADP:** Apple Developer Program membership. Members of this paid program can distribute apps on the App Store.
> **Developer ID:** macOS apps signed with a Developer ID certificate.
> **Apple Developer:** Apple Account holders who have agreed to the Apple Developer Agreement to access certain resources on the Apple Developer website. **No cost is associated with this agreement and developers can't distribute apps.**

— <https://developer.apple.com/help/account/reference/supported-capabilities-macos/>

So the free tier ("Apple Developer") explicitly **cannot** get Time Sensitive Notifications. And the Developer ID column is not an independent free route — Developer ID certificates are themselves only issued to ADP members:

> "To distribute your Mac software with Developer ID, you'll need to be a member of the Apple Developer Program or Apple Developer Enterprise Program" — <https://developer.apple.com/support/developer-id>

**Ad-hoc signing (`codesign -s -`) cannot work either, and fails loudly.** A restricted entitlement with no profile to back it is rejected by AMFI at process spawn:

- `AppleMobileFileIntegrityError Code=-413 "No matching profile found"` — the app **does not launch at all**.
- **[THIRD-PARTY]** A real-world instance of exactly this: <https://github.com/Amir-Hackett/notchmeter/pull/14> — *"That entitlement is restricted: an app claiming one outside the App Store must carry a provisioning profile granting it, at Contents/embedded.provisionprofile... The app claimed an authority it could not show, and AMFI refused it at spawn."* Their fix was to drop the entitlement: *"The release signs with no entitlements. Focus break-through goes with it; the notices arrive at the ordinary level."*
- **[THIRD-PARTY]** Unrestricted entitlements (`com.apple.security.*`) work on ad-hoc signatures; restricted `com.apple.developer.*` ones do not. <https://hacktricks.wiki/en/macos-hardening/macos-security-and-privilege-escalation/macos-security-protections/macos-amfi-applemobilefileintegrity.html>

### The silent-degradation trap

There are two distinct failure modes and they look nothing alike:

1. **Claim the entitlement without a profile** → AMFI kills the app at spawn (-413). Loud.
2. **Omit the entitlement and just set `interruptionLevel = .timeSensitive`** → the app launches, `add()` reports **success**, and the notification is **silently delivered at ordinary `.active` level** — i.e. Focus suppresses it and you never find out. **[THIRD-PARTY]**, reported at <https://github.com/openclaw/openclaw/issues/127589>: *"When requesting time-sensitive priority without the required entitlement, the system silently downgrades to ordinary active priority while reporting complete success."*

Mode 2 is the one that will bite this project, because it is exactly what "just build a Swift bundle and set the interruption level" produces. **Mitigation: always assert `settings.timeSensitiveSetting == .enabled` at startup and log/alert if not.**

## The defeat surface — why this matters more than the price

Time Sensitive is user-revocable in **two independent places**, and the child is the user:

1. **System Settings > Notifications > [your app] > "Allow time sensitive alerts"** — *"Let apps send time-sensitive notifications."* <https://support.apple.com/guide/mac-help/change-notifications-settings-mh40583/mac>
2. **System Settings > Focus > [the Focus] > "Time Sensitive Notifications"** — *"With this setting on, apps that aren't on your Allowed Apps list can send notifications that are marked as Time Sensitive."* <https://support.apple.com/guide/mac-help/mchl613dc43f/mac>

And Apple states it plainly in the API docs: *"The user can turn off the ability for time sensitive notification interruptions."*

**Can a configuration profile force it back on? No.** I pulled Apple's authoritative payload schema for `com.apple.notificationsettings`:

<https://github.com/apple/device-management/blob/release/mdm/profiles/com.apple.notificationsettings.yaml>

Available keys: `BundleIdentifier`, `NotificationsEnabled`, `ShowInNotificationCenter`, `ShowInLockScreen`, `AlertType` (0/1/2 = None/Temporary Banner/**Persistent Banner**), `BadgesEnabled`, `SoundsEnabled`, `CriticalAlertEnabled`. Plus iOS-only `ShowInCarPlay`, `GroupingType`, `PreviewType` (all marked `macOS: introduced: n/a`).

**There is no time-sensitive key.** So the enforcement story is:

| Child's move | Can a config profile stop it? |
|---|---|
| Turns off notifications for the app entirely | ✅ Yes — `NotificationsEnabled: true` is force-enforced |
| Sets alert style to "None" / banner instead of alert | ✅ Yes — `AlertType: 2` (Persistent Banner) |
| Turns off sound | ✅ Yes — `SoundsEnabled: true` |
| **Turns off "Allow time sensitive alerts"** | ❌ **No key exists** |
| **Turns off Time Sensitive in the Focus itself** | ❌ **No key exists** |
| Enables a Focus mode | ⚠️ Only Time Sensitive/Critical break through, and both are toggleable |

Good news on the profile: on macOS this payload is `supervised: false`, `requiresdep: false`, **`allowmanualinstall: true`** (introduced macOS 10.15) — meaning **no MDM enrollment is needed**; the parent can install a `.mobileconfig` by hand. Apple's description: *"A notification settings payload specifies the restriction enforced notification settings for apps using their bundle identifier. The profile specifies notification settings by bundle identifier (even for apps that aren't installed on the device yet), and **those settings will always be enforced**."* That is a genuinely valuable, **free** hardening win independent of the $99 question — it stops the child from simply muting the agent.

**The one thing that is both force-breakthrough and profile-enforceable is Critical Alerts** (`CriticalAlertEnabled` in the profile + `com.apple.developer.usernotifications.critical-alerts` entitlement). Apple's doc: *"it can request authorization to receive push notifications that cause the system to play a sound even when the app is locked, muted, or a person uses Do Not Disturb focus."* <https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.usernotifications.critical-alerts> — **but** that entitlement requires ADP *plus* a manual request form and Apple approval, and Apple grants it for health/public-safety/home-security use cases. **[INFERENCE]** A personal parental-control tool is very unlikely to be approved. Do not plan around it.

## How a root LaunchDaemon gets a notification delivered

**Short answer: it cannot do it itself. It must hand off to a process running inside the user's GUI (Aqua) session, and that process must be a real `.app` bundle.** Two hard constraints, from Apple DTS:

### Constraint 1 — `UNUserNotificationCenter` requires a real app bundle

`UNUserNotificationCenter.current()` raises `NSInternalInconsistencyException: bundleProxyForCurrentProcess is nil: mainBundle.bundleURL` when the calling process is not an `.app`. Confirmed across multiple Apple Developer Forums threads:

- "Can UserNotifications be used in a command line program?" — <https://developer.apple.com/forums/thread/724249>
- "Is it possible to use UNUserNotificationCenter from a LaunchAgent?" — <https://developer.apple.com/forums/thread/679326>
- "UNUserNotificationCenter crash (bundleProxyForCurrentProcess)" — <https://developer.apple.com/forums/thread/649583>

This is why the POC's `osascript` route attributes to **Script Editor**: `/usr/bin/osascript` is itself unbundled, so macOS attributes the notification to `com.apple.ScriptEditor2`. The fix genuinely is a bundle — not a signing tier.

### Constraint 2 — it needs a GUI session and user-level TCC

Apple DTS, on posting notifications from a launch agent/daemon: posting requires **user-level TCC authorization, only available when running in a user context**; a daemon attempting it gets `UNErrorCodeNotificationsNotAllowed`. — <https://developer.apple.com/forums/thread/804854>

And more generally: *"a daemon can be running when no user is logged in, or when multiple users are logged in, and thus it's not obvious who'll get the notification."* AppKit is not daemon-safe (TN2083). — <https://developer.apple.com/forums/thread/656460>

DTS's recommended architecture is exactly the split: **a separate user-level component that the daemon delegates to over IPC.** The accepted solution in thread 679326 was a LaunchAgent + bundled menu-bar app + XPC.

### So: yes, `launchctl asuser`, or a LaunchAgent

Two workable shapes:

**(a) Fire-and-forget (simplest, closest to the bash POC's spirit)**
```sh
uid=$(/usr/bin/stat -f %u /dev/console)     # console owner = the GUI session user
launchctl asuser "$uid" /usr/bin/open -a /Library/.../Notifier.app --args "15 minutes left" "..."
```
`launchctl asuser` *"executes the given command in as similar an execution context as possible to that of the target user's bootstrap"* — <https://ss64.com/mac/launchctl.html>. This puts the app in the right session and bootstrap namespace so the notification is attributed and delivered.
- **[INFERENCE]** The notifier must spin a run loop briefly after `add()` before exiting — `add()` is asynchronous and a process that exits immediately may drop the notification. Budget a short `RunLoop.run(until:)` or wait on the completion handler.
- **Caveat:** if no one is logged in, or the session is at the login window, there is no target. Guard on `stat -f %u /dev/console` returning a real (>=501) uid. Apple notes `launchctl asuser` is unreliable in a fast-user-switching login window — <https://developer.apple.com/forums/thread/692749>.

**(b) Long-running LaunchAgent + IPC (what DTS recommends)**
A `LaunchAgent` in `/Library/LaunchAgents` whose `Program` is `Notifier.app/Contents/MacOS/Notifier`, running in the Aqua session, holding notification authorization, listening on an XPC/Unix socket that the root daemon writes to.
- More moving parts, but: the auth grant lives in one long-lived process, it can handle notification *action* callbacks (e.g. "Request 10 more minutes"), and it survives without re-launch cost.
- **Trade-off for this project:** a LaunchAgent runs as the child and is unloadable by the child. A root LaunchDaemon is not. So the agent is a soft target — the daemon must treat "notifier unreachable" as a condition to fall back to a modal dialog, not as a silent no-op.

**[INFERENCE]** For this project, (a) is the right call: the daemon stays the single source of truth, there is no second long-lived process for the child to kill, and re-launching per-warning costs nothing at the frequency involved (a handful of warnings per session).

### Is there a registration step — must the app be launched once by the user?

**Effectively yes, once, in the user's session.** The app must run and call `requestAuthorization(options:)`; that call is what creates the System Settings > Notifications entry and raises the consent prompt. Apple: *"The first time that your app launches and calls the `requestAuthorizationWithOptions:completionHandler:` method, the system prompts the user to grant or deny the requested interactions."* — <https://developer.apple.com/library/archive/documentation/NetworkingInternet/Conceptual/RemoteNotificationsPG/SupportingNotificationsinYourApp.html> (archived doc, but the behaviour is unchanged).

- **[INFERENCE]** It does not have to be launched *by the child clicking it* — a first launch via `launchctl asuser ... open -a` in their session will raise the prompt in that session just the same. But someone has to click "Allow" once.
- **Shortcut:** deploying the `com.apple.notificationsettings` profile **with the bundle ID pre-listed** side-steps this. Apple's schema explicitly says the profile applies *"even for apps that aren't installed on the device yet"* and the settings *"will always be enforced."* Install the profile first, then the app — no consent prompt to win, and the child can't revoke it. This is the single best free hardening move available and I'd do it regardless of the Swift decision.

### Does the bundle need to be in `/Applications`?

**No.** Nothing in Apple's documentation ties notification delivery to `/Applications`. What matters is that it is a well-formed bundle with a `CFBundleIdentifier` that LaunchServices knows about — and Apple's own "daemon in app's clothing" sample installs to `/Library/Application Support/<product>/` and runs it from there. <https://developer.apple.com/documentation/xcode/signing-a-daemon-with-a-restricted-entitlement>

**[INFERENCE]** For *this* project put it under a **root-owned** path — `/Library/Application Support/homeparentcontrol/Notifier.app` — not `/Applications`. Reason: `/Applications` is group-writable by `admin`, and if the child's account is an admin (the default for the first account on a Mac) they can modify or replace the bundle. A root-owned directory under `/Library` cannot be tampered with by a standard user. If the entry ever fails to appear, force registration with:
```
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f /Library/Application\ Support/homeparentcontrol/Notifier.app
```

## The alternative Apple actually recommends for this exact situation: `CFUserNotification`

This is the most important finding in T2.2 and it reframes the whole decision.

Apple's documentation for `CFUserNotification`:

> "A `CFUserNotification` object presents a simple dialog on the screen and optionally receives feedback from the user. The contents of the dialog can include a header, a message, an icon, text fields, a pop-up button, radio buttons or checkboxes, and up to three ordinary buttons. **Use `CFUserNotification` in processes that do not otherwise have user interfaces, but may need occasional interaction with the user.**"
>
> "...You can also specify a **timeout** for the dialog, in which case the dialog cancels itself if the user does not respond in the allotted time period."

— <https://developer.apple.com/documentation/corefoundation/cfusernotification>

It is **not marked deprecated on any platform** in Apple's current documentation (checked 2026-09-18), and Apple DTS recommends it by name for launchd agents that need to talk to the user:

> DTS, on notifications from a launch agent: use `CFUserNotification` from CoreFoundation — it "works from launchd agents (user context is clear)", though it is "quite cumbersome to use, especially from Swift." — <https://developer.apple.com/forums/thread/804854>
> "You may have better luck using `CFUserNotificationDisplayNotice`, an older and lower-level notification API." — <https://developer.apple.com/forums/thread/724249>

Why this matters here:

| Property | `UNUserNotificationCenter` + Time Sensitive | `CFUserNotification` |
|---|---|---|
| Cost | **$99/yr ADP** | **$0** |
| Needs `.app` bundle | **Yes** | **No** — works from a plain binary |
| Needs entitlement + provisioning profile | **Yes** | **No** |
| Needs user to grant notification permission | **Yes** (one-time prompt) | **No** |
| Child can disable it in System Settings | **Yes — two separate toggles** | **No toggle exists** |
| Suppressed by Focus / DND | Only if Time Sensitive is off — i.e. **yes, defeatable** | **No** — it is a window, not a notification. Focus governs Notification Center, not app windows. **[INFERENCE — well grounded, but worth a 5-minute empirical test with a Focus enabled]** |
| Attribution | Your app name + icon | Generic, but supports a custom icon via the dictionary |
| Interactive (buttons) | Yes (notification actions) | **Yes — up to 3 buttons, plus text fields, plus a timeout** |
| Unobtrusiveness | Banner — polite | Dialog — intrusive by design |

`CFUserNotification` is essentially "the POC's modal-dialog workaround, done properly": same Focus-immunity, but via a supported C API instead of `osascript`, so it loses the "Script Editor" attribution, gains a custom icon, gains a timeout, and gains up to three real buttons (e.g. *"OK"* / *"Request 10 more minutes"*).

The daemon still has to cross the session boundary — it is a window, so it needs the Aqua session. Same `launchctl asuser` handoff as above. DTS notes it is *"less suitable for daemons"* only because a daemon must decide *which* user gets it; with a single-child Mac mini that ambiguity does not exist — resolve the console owner with `stat -f %u /dev/console` and you are done.

## T2.2 verdict

- **To send a genuine Time Sensitive notification you need: a Swift `.app` bundle + `LSUIElement` + `CFBundleIdentifier` + the `com.apple.developer.usernotifications.time-sensitive` entitlement + an `embedded.provisionprofile` authorizing it + a Developer ID (or Development) signature + $99/yr ADP.** No authorization option — that API is deprecated; the entitlement is the mechanism.
- **A root LaunchDaemon cannot deliver it directly.** It must hand off into the user's GUI session, via `launchctl asuser <uid> open -a ...` or a bundled LaunchAgent + IPC. The app must be run once in that session to obtain notification authorization — unless a `com.apple.notificationsettings` profile pre-grants it.
- **The bundle does not need to be in `/Applications`** — and for tamper-resistance it should not be; put it in a root-owned path under `/Library/Application Support/`.
- **The $99 buys a break-through that the child can turn off in System Settings, and no configuration profile can force it back on.** Against an adversarial user, Time Sensitive is a soft guarantee. `CFUserNotification` is a hard one.

---

# T2.3 — Signing and notarization, with concrete costs

## ⚠️ Methodology and provenance note — READ BEFORE INTERPRETING ANY EVIDENCE

**Some `com.apple.quarantine` attributes found in this session's scratchpad were FABRICATED by us to simulate a download. They do not indicate that anything was actually downloaded from the internet.**

Specifically, strings of the form `0081;68cc0000;com.apple.Safari;C1FE3A62-...` and `0083;68cc0000;Safari;...` in
`…/scratchpad/qtest2` … `qtest6` and `…/scratchpad/pkgtest` were written by hand with `xattr -w` by a research
subagent in order to test Gatekeeper's behaviour. **No browser was involved and nothing was downloaded.** The
`com.apple.Safari` agent-name field and the `C1FE3A62-…` UUIDs are synthetic. Out of context these look alarming;
they are test fixtures.

**All such attributes have since been removed** (`xattr -d com.apple.quarantine`, 24 files/directories, verified
clean by re-scan). The `qtest*` directories are intentionally left in place as evidence.

**This experiment was stopped mid-flight and should not be repeated.** Executing the quarantined fixtures caused
real Gatekeeper malware dialogs ("Apple could not verify … is free of malware") to appear on the machine owner's
screen. **Provoking Gatekeeper by launching quarantined code is off-limits for this project.** Consequences for
this document:

- Everything in the block below marked **[OBSERVED]** was measured **without** any quarantine attribute and
  **without** provoking Gatekeeper. It stands.
- Claims about what Gatekeeper does to a *quarantined* artifact are marked **[RESEARCHED — NOT VERIFIED]** and
  rest on documentation, not on a test we ran.
- Tests that would require launching quarantined code are listed at the end under "Tests the owner could run
  deliberately" and were **not** performed.

## Empirical baseline (measured on macOS 26.6.2, build 25G83, arm64 — this machine)

These are **[OBSERVED]**, not quoted:

```
# 1. Locally created file  -> com.apple.provenance ONLY. No quarantine.
$ printf '...' > local.sh; xattr local.sh
com.apple.provenance

# 2. Locally compiled binary -> cc AUTO-APPLIES an ad-hoc signature on arm64
$ cc t.c -o tbin; codesign -dv tbin
CodeDirectory v=20400 ... flags=0x20002(adhoc,linker-signed)
$ xattr tbin
com.apple.provenance            # again: no quarantine

# 3. File extracted from a tarball on-box -> no quarantine
$ tar xzf a.tgz -C ex; xattr ex/local.sh
com.apple.provenance

# 4. An UNSIGNED arm64 binary is killed by the kernel
$ codesign --remove-signature tbin_unsigned; ./tbin_unsigned
$ echo $?
137                              # 128+9 = SIGKILL

# 5. Gatekeeper ASSESSMENT rejects the local ad-hoc binary -- yet it runs fine
$ spctl -a -vv tbin
tbin: rejected
$ spctl --status
assessments enabled
```

Item 5 is the single most important thing to understand about macOS signing, and it is where most people go wrong: **`spctl` "rejected" does not mean "will not run."** Gatekeeper's assessment gates *quarantined* files. An unquarantined ad-hoc binary is rejected by `spctl -a` and executes normally. Everything about Gatekeeper in this project hinges on quarantine, and **nothing we install will be quarantined.**

## Quarantine: what actually applies it

`com.apple.quarantine` is applied by the **downloading application**, not by the OS to all new files. An app opts in via the `LSFileQuarantineEnabled` Info.plist key, and the sandbox/LaunchServices then tags files it writes. Browsers, Mail, Messages, AirDrop and archive utilities that open quarantined archives all do this.

**[OBSERVED, above]** None of the delivery paths this project will use apply quarantine:

| Delivery path | Quarantined? | Basis |
|---|---|---|
| `scp` / `rsync` from another machine | **No** | scp/rsync are not quarantine-aware apps; they set no xattr. **[OBSERVED analogue: locally written files get only `com.apple.provenance`]** |
| Built on-box (`swiftc`, `cc`, `xcodebuild`) | **No** | **[OBSERVED]** |
| `tar -xzf` at the command line | **No** | **[OBSERVED]** (twice, independently) |
| **`unzip` or `ditto -x -k` of a quarantined `.zip`** | **⚠️ YES — propagates** | **[OBSERVED]** — extracted files came out carrying `com.apple.quarantine`. **This contradicts widespread folklore.** `/usr/bin/unzip` is Apple-signed with no quarantine symbols, so propagation happens below the tool; mechanism not determined. |
| `cp` of a quarantined file | **Yes (preserved)** | **[OBSERVED]** — `cp` copies xattrs |
| `rsync` of a quarantined file | **No** | **[OBSERVED]** — macOS `rsync` doesn't copy xattrs by default |
| `curl -o file` | **No** | **[OBSERVED]**, and **[D]** Apple DTS: *"Most Unix-y tools don't quarantine their downloads, including curl and scp."* <https://developer.apple.com/forums/thread/666452> |
| `git clone` | **No** | **[INFERENCE]** — git is not quarantine-aware; same class as the above |
| Downloaded in Safari/Chrome | **Yes** | This is the case Gatekeeper exists for |

> **Note on `com.apple.provenance`.** Every file above carried `com.apple.provenance`, a newer xattr unrelated to Gatekeeper's download check. It is not `com.apple.quarantine` and does not trigger a Gatekeeper assessment. **[INFERENCE]** — Apple does not document this attribute; I am reporting what I measured.

> **⚠️ Deployment consequence — prefer `tar`/`rsync` over `.zip`.** Since `unzip`/`ditto` **propagate** quarantine while `tar` and `rsync` do not, an agent shipped as a `.zip` that ever passes through a quarantining path arrives quarantined. **Ship a tarball, or rsync the tree.**

> **⚠️ Quarantine blocking is enforced at `exec`, not only through LaunchServices. [OBSERVED]** A quarantined, non-notarized Mach-O is **SIGKILLed (rc=137), silently**, when run straight from a shell — no dialog in the terminal, but the kill is what raises the GUI malware alert. A notarized Developer ID binary (tested against `/usr/local/bin/docker`, which satisfies `codesign --test-requirement="=notarized"`) runs fine even when quarantined. **Shell scripts are exempt** — a quarantined `#!/bin/sh` script ran normally. **Implication for this project: a LaunchDaemon binary that somehow acquired quarantine would be killed by launchd at exec.** [INFERENCE — not directly tested with a real daemon.] Combined with macOS 27 refusing to load a quarantined `.plist`, the rule is absolute: **never let any installed artifact carry quarantine.** Verify post-install with `xattr -r /Library/Application\ Support/homeparentcontrol`.

**Consequence: notarization is irrelevant to this project.** Apple ties the notarization requirement specifically to Developer ID *distribution*:

> "Beginning in macOS 10.15, all software built after June 1, 2019, and **distributed with Developer ID** must be notarized."

— <https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution>

Software the machine's own admin builds or copies on-box is not "distributed with Developer ID" and is never assessed, because it is never quarantined. Also note Apple's own instruction that you **cannot** notarize ad-hoc work: *"Use a 'Developer ID' application, kernel extension, system extension, or installer certificate... (Don't use a Mac Distribution, **ad hoc**, Apple Developer, or local development certificate.)"* — same page. Notarization additionally requires an active ADP membership to obtain a Developer ID certificate at all (<https://developer.apple.com/support/developer-id>).

## The signing tier table

| Tier | Cost | What it enables | What it blocks | Expiry |
|---|---|---|---|---|
| **Unsigned** | $0 | Nothing on Apple Silicon. | **The binary does not run at all** — kernel SIGKILLs it (**[OBSERVED]**: exit 137). Only reachable by deliberately stripping a signature. | n/a |
| **Ad-hoc** (`codesign -s -`; also applied automatically by `cc`/`swiftc` as `linker-signed`) | **$0** | Runs on arm64. A `.app` bundle gets **full notification identity**: own name, own icon, own System Settings > Notifications entry, alert style, actions. `CFUserNotification` works. `UNUserNotificationCenter` works at `.active`/`.passive`. Local install, `installer -pkg`, LaunchDaemon execution. | **Restricted entitlements — AMFI kills the process at spawn, `-413 "No matching profile found"`.** So: **no Time Sensitive.** No notarization. No Team Identifier. **TCC identity = cdhash, so every rebuild is a "new app"** and notification permission resets. `spctl -a` rejects it (harmless unless quarantined). | Never (no certificate involved) |
| **Self-signed Keychain identity** (Certificate Assistant > Code Signing) | **$0** | Everything ad-hoc does, **plus a stable designated requirement** so TCC/notification grants survive rebuilds. **[THIRD-PARTY]** — widely reported working; Apple documents creating the cert (<https://developer.apple.com/library/archive/documentation/Security/Conceptual/CodeSigningGuide/Procedures/Procedures.html>) but not the TCC consequence. | Same entitlement wall as ad-hoc. Not trusted by Gatekeeper. No Team Identifier. | You choose at creation (e.g. 10 years) |
| **Free Apple ID / "personal team"** (Apple's **"Apple Developer"** tier) | **$0** | An *Apple Development* certificate. App Sandbox, Hardened Runtime. Xcode builds. | **Time Sensitive Notifications: ❌** per Apple's own matrix. Also blocked: Push notifications, Communication Notifications, Sign in with Apple, System Extensions. **No Developer ID, no notarization.** Apple: *"developers can't distribute apps."* | **Resolved.** Apple TN3125: *"**Unlike Apple's other platforms, macOS doesn't require a provisioning profile to run third-party code.**"* So the 7-day free-profile clock **only starts if the bundle actually embeds one**. Test: does `MyApp.app/Contents/embedded.provisionprofile` exist? **No → nothing expires. Yes → the app stops launching after 7 days.** Cert itself conventionally ~1 yr, but **Apple documents no validity period for a personal-team cert — unverified.** <https://developer.apple.com/documentation/technotes/tn3125-inside-code-signing-provisioning-profiles> |
| **Developer ID** — Apple Developer Program | **$99 USD/yr** | **`com.apple.developer.usernotifications.time-sensitive` + provisioning profile → Time Sensitive notifications.** A **Team Identifier** (named developer in BTM/Login Items instead of "unidentified"; makes `AssociatedBundleIdentifiers` work). Notarization. Gatekeeper-clean internet distribution. Stable TCC identity. Signed `.pkg` installers. | App Store distribution needs a different cert (Mac App Distribution) — not relevant here. | **⚠️ Not a one-time purchase — see "the subscription trap" below.** Apps *without* an embedded Developer ID profile keep running after the cert expires (**[D]** Apple: *"As long as your Developer ID certificate was valid when you compiled your app, then users can download and run your app, even after the expiration date"*). But an app **with** an embedded Developer ID provisioning profile — **which is exactly what Time Sensitive requires** — is different: Apple evaluates that profile **at every app launch**, and *"if your Developer ID provisioning profile expires, the app will no longer launch."* Signed `.pkg`s are stricter still: they *"only launch if your Developer ID Installer certificate is valid."* <https://developer.apple.com/help/account/certificates/create-developer-id-certificates/> |

**Price confirmation:** $99 USD/year, individual or organization — <https://developer.apple.com/programs/> and <https://developer.apple.com/support/compare-memberships/>. Prices are listed in local currency at enrollment. A **fee waiver** exists for accredited educational institutions and government entities (<https://developer.apple.com/help/account/membership/fee-waivers/>) — not applicable to a family project.

## What signing each artifact actually requires

### (a) A Swift `.app` bundle sending notifications
- **Ordinary notifications:** ad-hoc is enough. Bundle + `CFBundleIdentifier` + `LSUIElement` + `codesign -s -`. **Verified end to end on this OS** (see T2.1): compile with CLT-only `swiftc`, link `UserNotifications.framework`, hand-build `Contents/`, `codesign --force --deep --sign - --identifier com.example.x`, run — `UNUserNotificationCenter.current()` returns a live object.
- **Time Sensitive:** Developer ID + App ID with the capability + `embedded.provisionprofile` + Hardened Runtime. **$99/yr.**
- Prefer a **stable** identity (self-signed or Developer ID) over raw ad-hoc so the notification grant survives updates.

### (b) A `.pkg` installer
- Signing a pkg uses a **`Developer ID Installer`** certificate via `productsign` — a *different* certificate from **`Developer ID Application`** (which signs the Mach-O/app inside). Both come with ADP; up to 5 of each per team; **Account Holder role required**. **[D]** Apple's certificate table: *Developer ID Application — "Sign a Mac app before distributing it outside the Mac App Store"*; *Developer ID Installer — "Sign and distribute a Mac Installer Package… outside the Mac App Store."* <https://developer.apple.com/help/account/certificates/certificates-overview/>
- **[D] Using the wrong one silently half-works — Apple's own warning:** *"**WARNING:** Make sure you sign the installer package using your Developer ID Installer certificate. The `productsign(1)` command-line tool allows you to sign an installer package using your Developer ID Application certificate. **Although this approach may appear to work, the resulting installer archive will fail on the destination Mac.**"* <https://help.apple.com/xcode/mac/current/en.lproj/deve51ce7c3d.html>
- **An unsigned `.pkg` installs fine from the command line as root:** `sudo installer -pkg foo.pkg -target /`. `installer(8)` performs no Gatekeeper assessment; the GUI Installer.app path is the one that checks quarantine. **[THIRD-PARTY, documented; NOT VERIFIED]** — *"Installing with `installer` will also not trigger GateKeeper checks, whether the quarantine flag is set or not."* (Armin Briegel, <https://scriptingosx.com/2025/08/installing-packages/>). **[OBSERVED]** partial corroboration: `spctl -a --type install` rejects an unsigned pkg **identically with and without quarantine**, confirming `spctl` reports policy truth rather than what `installer` does; and `man installer`'s only trust flag is `-allowUntrusted`, worded for *signed-but-untrusted* certs — it says nothing about unsigned pkgs, consistent with those simply not being blocked from the CLI. The root install itself was **not run** (no passwordless sudo, and we would not prompt the owner).
- For this project a pkg is optional anyway; a `rsync` + `launchctl bootstrap` install script is simpler and equally unquarantined.

### (c) A plain LaunchDaemon binary or shell script
- **Mach-O binary:** must be signed **at least ad-hoc** on Apple Silicon or the kernel kills it (**[OBSERVED]**: exit 137). The toolchain does this automatically — `cc`/`swiftc` emit `flags=0x20002(adhoc,linker-signed)` with no action from you. So in practice "unsigned" is not a state you reach by accident.
- **Shell scripts:** not signed and not signable in any meaningful way — the *interpreter* (`/bin/bash`, `/bin/sh`) is the signed code, and it is Apple's. This is exactly what breaks BTM attribution; see the next section.
- `launchd` itself performs no Gatekeeper assessment when starting a daemon. **But BTM does perform an attribution check — and that is a different, and newer, gate.**

---

# BTM — Background Task Management (cross-track verification for T3)

**Asked to verify independently, not adopt. Verdict: CONFIRMED in substance, with two corrections to the framing, one of which changes what the $99 buys.**

## Confirmed

**Apple DTS states the root cause directly.** Apple Developer Forums, "Issue with LaunchDaemon running bash showing up as unidentified developer" — Quinn "The Eskimo!", Apple DTS:

> "This facility relies on the concept of **responsible code**, and the system has a very hard time tracking that when you use a script."
>
> "My general advice on this front is to **switch to using a Mach-O executable**. You can then either put the actual functionality in that executable, or use it to run your scripting executable of choice. Your executable should get `AssociatedBundleIdentifiers` working."

— <https://developer.apple.com/forums/thread/755904>

**[THIRD-PARTY]** A macOS Tahoe 26-era field report with `sfltool dumpbtm` evidence — Nix's LaunchDaemons blocked on Tahoe:

> BTM identifies the service by its entry point. The dump shows `Executable Path: /bin/sh`, `Parent Identifier: Unknown Developer`, `Disposition: [enabled, disallowed, notified]`.
> "`launchctl bootstrap` bypasses BTM for the running session. The BTM database itself is untouched. **On the next boot, BTM wins.**"
> Reported as applying to `/Library/LaunchDaemons/` since macOS 14.6.1.

— <https://mgaebler.me/en/blog/nix-macos-tahoe-btm-blocks-launchdaemons/>, corroborated by <https://eclecticlight.co/2026/02/20/in-the-background-identification/>

**[OBSERVED] Circumstantial corroboration from this machine.** Every one of the 8 third-party LaunchDaemons installed in `/Library/LaunchDaemons` here (Docker, Zoom, Microsoft AutoUpdate, Google Updater, Logitech, Examsoft) points its `Program`/`ProgramArguments[0]` at a **Mach-O binary** — in `/Library/PrivilegedHelperTools/` or inside an `.app`. **Not one uses a script entry point.** That is what shipping software does.

**So yes: T3 is right that the daemon's entry point must be a compiled Mach-O binary, and that this eliminates bash and Python as the agent's entry point.** I agree, and it is a hard constraint, not a preference.

## Correction 1 — it is not "Developer-ID-signable" that BTM needs, it is "Mach-O"

Apple DTS's advice is *"switch to using a Mach-O executable"* — **not** "obtain a Developer ID." The failure is that macOS cannot track *responsibility* through an interpreter: it sees `/bin/sh`, which is Apple's binary, not yours, so there is nothing to attribute the daemon to.

An **ad-hoc signed** Mach-O has its own cdhash and is attributable *to itself*, which is categorically different from being attributed to `/bin/sh`. Whether that is sufficient for BTM to allow it by default — or whether it too lands `disallowed` because it still has no Team Identifier — **is not answered by any source I could find.** This is the key open question and I am flagging it rather than guessing.

> **Recommended 15-minute experiment on the target Mac mini, before spending anything:** install a trivial Mach-O daemon signed ad-hoc in `/Library/LaunchDaemons`, reboot, and run `sudo sfltool dumpbtm | grep -A10 <your label>`. Read the `Disposition`. If it says `[enabled, allowed]`, ad-hoc is sufficient and the $99 buys nothing for persistence. If it says `disallowed`, the Team Identifier matters. **This single test resolves the most expensive open question in the round.**

## Correction 2 — the child can toggle it off, and the fix is MDM, not $99

The Nix report's own remedy is *"System Settings > General > Login Items & Extensions > 'Allow in the Background' and toggle the `sh` entries ON."* That cuts both ways: **whatever the parent can toggle on, the child can toggle off.** For a parental-control agent this is a bigger hole than the first-boot disallow.

The only way to make a background item non-toggleable is Apple's **`com.apple.servicemanagement`** ("Managed Login Items") payload, which *"auto-enables and auto-allows matched items."* I pulled its authoritative schema:

<https://github.com/apple/device-management/blob/release/mdm/profiles/com.apple.servicemanagement.yaml>

```yaml
payloadtype: com.apple.servicemanagement
macOS: { introduced: '13.0', devicechannel: true,
         userapprovedmdm: true, allowmanualinstall: false }
RuleType rangelist: [BundleIdentifier, BundleIdentifierPrefix,
                     Label, LabelPrefix, TeamIdentifier]
```

Two decisive details:

1. **`allowmanualinstall: false`** — unlike the notifications payload, this one **cannot be installed by hand. It requires MDM enrollment** (user-approved MDM). That is a whole separate lift for T3 to cost, and it is the *only* route to an un-disableable agent.
2. **`RuleType` accepts `Label` and `LabelPrefix`** — matching the launchd job label, which needs **no Team Identifier and no Developer ID.** So even the MDM-enforced path does not require the $99.

## Reconciliation — what the $99/yr actually buys

**Plainly: it buys notifications, not daemon persistence.**

| Capability | Needs $99 Developer ID? |
|---|---|
| **Time Sensitive notifications (Focus break-through)** | **YES — exclusively. No free path exists.** |
| Correct app name/icon/Settings entry on notifications | No — ad-hoc `.app` bundle |
| Focus-immune alert to the child | No — `CFUserNotification`, free, and *stronger* |
| Daemon survives reboot under BTM | No — **compile to Mach-O**. That is the fix. (Ad-hoc sufficiency unverified — see experiment above.) |
| Daemon cannot be toggled off by the child | No — needs **MDM** + `com.apple.servicemanagement`, matchable by `Label` |
| Named developer instead of "unidentified" in Login Items | Yes — a Team Identifier is the only way to get a name |
| `AssociatedBundleIdentifiers` working | Yes (per DTS) |
| Notification permission survives agent updates | No — a free self-signed Keychain identity also gives a stable DR |
| Notarization / Gatekeeper-clean | Not applicable — nothing here is ever quarantined |

**I therefore partially disagree with T3's conclusion that BTM "settles the Apple Developer account question."** BTM settles the *language* question (compiled binary, so not bash/Python) — and on that I fully agree with T3. It does not settle the *account* question. The $99 remains justified only by Time Sensitive notifications, and Time Sensitive is itself two toggles away from being defeated by the child.

---

# OS version scoping — macOS 26 vs macOS 27 "Golden Gate"

**The brief assumed macOS 26. That assumption is now stale: macOS 27 "Golden Gate" shipped Monday 2026-09-14, four days ago.**
Confirmed: <https://www.macrumors.com/2026/09/10/macos-27-golden-gate-release-date/>, <https://9to5mac.com/2026/09/09/apple-confirms-macos-27-golden-gate-launch-date-september-14/>, <https://developer.apple.com/documentation/macos-release-notes/macos-27-release-notes>

**I reviewed the full macOS 27 release notes against every conclusion in this document.** Keyword sweep of the complete notes (891 lines flattened from Apple's JSON):

| Term | Occurrences in macOS 27 release notes |
|---|---|
| "Time Sensitive", "interruption", "UserNotifications" | **0** |
| "notariz", "codesign", "provisioning", "AMFI" | **0** |
| "Background Task", "Login Item", "ServiceManagement" | **0** |
| "entitlement" | 1 — unrelated (Neural Engine background inference) |

**Verdict: nothing in macOS 27 changes any T2.2 or T2.3 conclusion.** The capability matrix I cite is Apple's live account-help page, not version-scoped, so it is current today. Four macOS 27 changes are nonetheless worth recording:

1. **Launch Daemons and Agents — new hard gate.** *"Fixed: [launchd] no longer supports loading property list files with the quarantine extended attribute. (166415497)"* → **a LaunchDaemon `.plist` that carries `com.apple.quarantine` will not load on macOS 27.** Our install paths (scp/rsync/local build) do not quarantine, so this is safe — but it converts "don't download the plist with a browser" from a style note into a hard requirement. Verify with `xattr /Library/LaunchDaemons/<label>.plist` post-install.
2. **Privacy & Security Settings — known issue.** *"a process **without a bundle ID** cannot be granted access to specific app data containers or app group containers owned by other developer teams."* → further, independent evidence that a bare script or bare binary is a second-class citizen for permissions. Reinforces the bundle requirement.
3. **TCC — deprecation.** *"Apps can no longer access the local TCC database directly."* Relevant to T6/T7 if any telemetry planned to read `TCC.db`; that route is closed.
4. **Installer packages** now default to **arm64** when no architecture is specified; audit pre/post-install scripts. And **Intel support is dropped entirely** in macOS 27 (M1+ only) — irrelevant for an Apple Silicon Mac mini, but it means any Intel fallback thinking can be discarded.

**Scoping statement for everything above and below:** empirically verified on **macOS 26.6.2 (build 25G83, arm64)**; macOS 27 release notes reviewed and found to contain no contradicting change. Conclusions should be re-tested if the Mac mini is upgraded to 27, particularly the BTM experiment.

---

# T2.1 — Language choice

## Corrections to two premises in the brief

- **"Python is no longer bundled with macOS" — TRUE, and worse than stated.** `/usr/bin/python3` is not a Python at all. It is Apple's `xcode-select` tool shim: **one 118,640-byte binary with 78 hard links**, shared with `/usr/bin/swift`, `/usr/bin/clang`, `/usr/bin/git` and 74 others, carrying the embedded identifier `com.apple.dt.xcode_select.tool-shim-public`. On a machine with no Xcode and no Command Line Tools it raises the GUI "install the command line developer tools?" dialog — **a modal prompt, in a root daemon, on a child's machine.** With tools installed it resolves to Python **3.9.6**, which belongs to the developer tools (LLDB depends on it), is upstream-EOL, and which Apple DTS explicitly declines to bless as a general runtime (<https://developer.apple.com/forums/thread/838682>). Policy of record is still the Catalina note: *"Future versions of macOS won't include scripting language runtimes by default... it's recommended that you bundle the runtime within the app."* (<https://developer.apple.com/documentation/macos-release-notes/macos-catalina-10_15-release-notes>)
- **"The target machine has no runtime to install" is NOT an argument against Swift.** The Swift **runtime ships in the base OS**, inside the dyld shared cache — there is no file at `/usr/lib/swift/libswiftCore.dylib`, yet it loads. **A Swift binary you build runs on a stock macOS 26/27 with no Xcode and no CLT.** Only *building* needs tools, and only Command Line Tools, not Xcode. This removes the historical objection to Swift outright.

## Verified build chain (measured, not assumed)

The full Swift notification path was compiled, bundled, signed and executed on macOS 26.6.2 using **Command Line Tools only**:

```
/Library/Developer/CommandLineTools/usr/bin/swiftc \
  -sdk /Library/Developer/CommandLineTools/SDKs/MacOSX26.sdk \
  -target arm64-apple-macos13.0 \
  -framework UserNotifications -framework AppKit main.swift -o unotify
# zero errors; content.interruptionLevel = .timeSensitive compiles
codesign --force --deep --sign - --identifier com.example.unotify UNotify.app
# flags=0x2(adhoc) -> UNUserNotificationCenter.current() returns a live object
```

Also confirmed: `/usr/bin/codesign`, `/usr/bin/plutil`, `/usr/bin/xcrun` are **real base-OS binaries, not shims** — codesigning needs no CLT at all. The one genuine Xcode-only gap is `actool`/`ibtool` (asset catalogs, storyboards), which a headless helper does not need. And the bundle requirement is not graceful: the same binary run **outside** a bundle **hard-crashes** with `NSInternalInconsistencyException: bundleProxyForCurrentProcess is nil`.

## `osascript` may already be broken on macOS 26+ — the POC's current path is at risk

**[OBSERVED on this machine, macOS 26.6.2]**

```
$ sdef /System/Library/ScriptingAdditions/StandardAdditions.osax | grep -A4 'display notification'
  <direct-parameter .../>  with title / subtitle / sound name      # exactly 4 parameters
$ osascript -e 'display notification "x" with title "y" interruption level critical'
38:52: syntax error: A identifier can't go after this """. (-2740)
$ osascript -e 'display notification "probe" with title "HPC test"'; echo $?
0                                             # reports success
$ defaults read com.apple.ncprefs apps | grep -ci scripteditor
0                                             # ScriptEditor2 NOT registered...
$ defaults read com.apple.ncprefs apps | grep -c '"bundle-id"'
79                                            # ...while 79 other apps ARE
```

So: the command **cannot** set an interruption level (the parameter does not exist in the grammar — this is not a workaround-able limitation), it returns exit 0, and `com.apple.ScriptEditor2` has **no notification registration at all** despite the call succeeding. This corroborates an unanswered Apple Developer Forums report of `display notification` silently doing nothing since Tahoe: <https://developer.apple.com/forums/thread/808496>.

**[CAVEAT — I am not over-claiming]** `ncprefs` may be cached in memory and registration may be lazy, and I could not visually confirm whether a banner appeared. Treat this as **strong corroboration, not proof**. **Action: the owner should eyeball a `display notification` on the actual Mac mini before relying on the POC's warning path at all.** If it is dead, the notification question is no longer "should we improve attribution" but "the POC has no working notification path."

## Language comparison

Scored 1–5 (5 = best). **Bold** = hard constraint, not a preference.

| Criterion | bash | Python | Go | Swift |
|---|:--:|:--:|:--:|:--:|
| **BTM: compiled Mach-O daemon entry point** (Apple DTS: *"switch to using a Mach-O executable"*) | **0 — fails** | **0 — fails** (unless frozen to a binary) | **5** | **5** |
| Notification capability (interruption level, identity, actions) | 1 — osascript: 4 params, no interruption level, possibly broken on 26+ | 1 — same osascript path, or PyObjC (not preinstalled) | 2 — no mature `UNUserNotificationCenter` bindings; must ship an `.app` regardless | **5 — native, first-party, only way to set `.timeSensitive`** |
| Preinstalled on target | 5 — bash 3.2.57 **(2007, GPLv2-frozen)**; zsh 5.9 default | **0 — `/usr/bin/python3` is a stub, not a Python** | 5 — nothing to install (static binary) | **5 — Swift runtime is in the dyld shared cache** |
| Single-binary distribution & updates | 3 — copy a script | 1 — must bundle a 10–40 MB runtime, sign every `.so` | **5 — best in class; `CGO_ENABLED=0` cross-compiles from anywhere** | 4 — one binary, but **must build on a Mac** |
| Signing implications | **0 — unsignable; attributed to `/bin/sh`** | 0–2 | 5 | 5 (`codesign` needs no CLT) |
| TCC / durable permission identity | **0 — attributed to the interpreter** | 0 | 4 | 5 |
| Power events (`IORegisterForSystemPower`) | 1 — SIGTERM trap only (see below) | 2 | 3 — needs cgo, or purego | **5 — native, no bridge** |
| Maintainability for this owner | 4 — POC exists, owner fluent | 4 — owner's CLI language | 3 — new language for owner | 3 — new language for owner |
| Ecosystem consistency (TS web apps, Python CLIs) | 2 | **5** | 2 | 1 |
| Third-party dependency rot risk | n/a | medium | **high for the macOS-framework parts** | **none — all first-party** |
| **Total (excl. hard-constraint zeros)** | eliminated | eliminated | **32** | **38** |

### Notes behind the scores

**bash and Python are eliminated by a hard constraint, not by preference.** Two independent mechanisms converge:
- **BTM** attributes a script-entry-point daemon to `/bin/sh` → "unidentified developer" → can be left `disallowed` after reboot (Apple DTS + Tahoe field report with `sfltool dumpbtm` evidence; see the BTM section above).
- **TCC** binds grants to code identity; a script's identity is the interpreter, which is Apple's binary, so no durable grant is possible. Independently reinforced by macOS 27's own release note that a **process without a bundle ID** cannot be granted container access.

Python carries an additional, independent disqualifier: **there is no Python on the machine**, and invoking the stub can raise a GUI installer prompt from a root daemon.

**Go is a genuinely strong runner-up and the Fleet Orbit precedent is real** — a signed, notarized, supervisor/worker Go agent is the reference implementation for this class. But Orbit's macOS-framework surface is *thin*: it orchestrates osquery and does inventory/update work, delegating OS introspection to a separate signed binary. **Our agent's differentiating work is exactly the framework-heavy part Orbit avoids** — notifications with interruption levels, power notifications, console-session detection. That is precisely where Go is weakest:
- No mature `UNUserNotificationCenter` bindings. `go-macos/usernotifications` is **0 stars, created three weeks ago**; `progrium/macdriver` has 5.4k stars but is **18 months stale**; `gen2brain/beeep` (1.7k stars, the de-facto choice) **shells out to `osascript`/`terminal-notifier`** — i.e. straight back into the broken path.
- `purego` (the no-cgo bridge) is self-described **beta**, and structurally **cannot catch Objective-C exceptions — an ObjC exception kills the Go process outright.** Given that `UNUserNotificationCenter.current()` throws exactly such an exception outside a bundle, that is a live crash risk.
- And the notification code must live in an `.app` bundle regardless — which **neutralizes Go's single-binary advantage precisely where it would have mattered.**

**Swift wins because every macOS-specific thing this agent must do is first-party in Swift and third-party-or-absent everywhere else**, and because its two historical drawbacks have both evaporated: the runtime ships in the OS, and the full build+bundle+sign chain works with Command Line Tools alone.

## Recommendation

> ### Build the agent in **Swift**. Runner-up: **Go**.

**Rationale.** The agent's hard requirements are macOS-platform requirements: a Mach-O daemon entry point that BTM will attribute (Apple DTS's explicit advice), a bundled app identity that TCC and Notification Center will bind to, notifications with a settable interruption level, and system power notifications. Swift does all four natively, with zero third-party dependencies, zero runtime to install on the target, and a build chain that needs only Command Line Tools. Go can do the first two well and the last two only through bridges that are either beta (`purego`, which cannot catch ObjC exceptions), stale (`macdriver`, 18 months), or brand-new (`go-macos/*`, 0 stars). For a system that a single parent must maintain for years, the language with no bridge to rot is worth more than the language the owner already knows.

**The ecosystem-consistency argument loses here, and it should.** The owner's TypeScript/Python stack is the right call for the *control plane*, which is a web app and should stay one. The agent is a different kind of artifact — a signed root daemon welded to macOS internals — and consistency across that boundary buys nothing. Keep the control plane in Hono/Next.js; treat the agent as the platform-specific component it is.

**What would flip it to Go:**
1. **If the $99 is declined AND `CFUserNotification` is adopted as the only notification path.** That collapses the macOS surface to two plain **C** APIs — `CFUserNotificationDisplayAlert` and `IORegisterForSystemPower` — both of which cgo handles cleanly with no ObjC bridge and no `.app` bundle. Go's cross-compilation and single-binary story would then dominate, and Swift's advantage would nearly vanish. **This is the most likely flip and it is directly coupled to the go/no-go below.**
2. If the agent grows substantial shared code with a Go control plane, or must build in non-macOS CI.
3. If a maintained, production-proven Go binding for `UNUserNotificationCenter` appears (re-check `go-macos/usernotifications` in 6–12 months; it may mature).

**A hybrid is legitimate and should not be dismissed:** Go (or even the existing bash) for the scheduling/state/network core, plus a ~150-line Swift `.app` helper for notifications. This is what most real products do. I recommend against it *only* because a solo-maintained family project pays a real tax for two toolchains, and Swift can do the whole job. If the owner strongly prefers Go for the core, the hybrid is a perfectly defensible second choice.

---

# Go / no-go on the Swift notification bundle

## **GO on the Swift bundle. NO-GO (for now) on the $99 Time Sensitive entitlement.**

These are two separate decisions and the brief conflated them. Separating them is the main recommendation of this track.

### GO: build the Swift `.app` notifier — **$0**

Do it now, ad-hoc or self-signed. It is independently justified even if Time Sensitive is never bought:

- Fixes the **"Script Editor"** attribution completely — real app name, real icon, its own System Settings > Notifications entry.
- Gives notification **actions** (e.g. "Request 10 more minutes"), subtitles, threading, alert style — none of which `osascript` can do.
- **Replaces a notification path that may already be dead on macOS 26/27** (see the `osascript` evidence above).
- Satisfies **BTM** (Mach-O entry point) and gives **TCC** a stable identity — both hard constraints from T3 and T7 that apply regardless of notifications.
- **Makes the $99 a later, reversible decision.** Once the bundle exists with a fixed `CFBundleIdentifier`, adding Time Sensitive later is: enrol in ADP → register the App ID → enable the capability → download a profile → drop it in `Contents/embedded.provisionprofile` → re-sign. **No rearchitecting.** That optionality is the strongest argument for building it now.

Pair it with two free hardening moves:
- **`CFUserNotification` for the final warning.** Apple's own recommendation for *"processes that do not otherwise have user interfaces, but may need occasional interaction with the user."* Focus-immune, no entitlement, no bundle, no toggle the child can flip, and it supports up to 3 buttons and a timeout. This is the POC's modal-dialog instinct, vindicated and upgraded.
- **A manually-installed `com.apple.notificationsettings` profile** (`allowmanualinstall: true`, no MDM needed) pinning `NotificationsEnabled: true` and `AlertType: 2` for the agent's bundle ID. Apple: those settings *"will always be enforced."* Stops the child muting the agent, and pre-grants notification permission so no consent prompt has to be won.

### NO-GO (for now): the $99/yr Apple Developer Program

**The price is $99 USD/year**, individual (<https://developer.apple.com/programs/>).

**What it buys in this specific scenario — exactly one thing: Time Sensitive notifications.** It does *not* buy daemon persistence (compiling to Mach-O does that, free), it does *not* buy un-disableable background items (that needs MDM, and the rule can match by `Label` with no Team ID), it does *not* buy notarization relevance (nothing here is ever quarantined), and it does *not* uniquely buy a stable TCC identity (a free self-signed Keychain identity gives that too). Its only *other* real benefits are a named developer instead of "unidentified" in Login Items, and working `AssociatedBundleIdentifiers`.

**Why no-go, stated plainly:** the thing the $99 buys is **defeatable by the child in two clicks**, in either System Settings > Notifications > [app] > "Allow time sensitive alerts" or System Settings > Focus > "Time Sensitive Notifications" — and **no configuration profile can force it back on**, because the `com.apple.notificationsettings` payload has no time-sensitive key. Apple's own documentation says so: *"The user can turn off the ability for time sensitive notification interruptions."* Paying $99/yr for a guarantee the adversary can revoke, when a free API (`CFUserNotification`) provides an unrevocable one, is the wrong trade for this threat model.

### ⚠️ The subscription trap — the $99 is recurring, and stopping breaks the app

**This is the single most important thing I learned after first drafting this document, and it strengthens the NO-GO.**

Time Sensitive requires a **restricted entitlement**, which requires an **embedded provisioning profile** (`Contents/embedded.provisionprofile`) — Apple TN3125: *"restricted entitlements must be authorized by a provisioning profile."* And Apple evaluates a Developer ID provisioning profile **at every single app launch**:

> "[macOS] will evaluate the validity of your Developer ID provisioning profile **at every app launch** … **if your Developer ID provisioning profile expires, the app will no longer launch.**"

— <https://developer.apple.com/help/account/certificates/create-developer-id-certificates/>

**So the two paths are not symmetric:**

| | Lapse behaviour |
|---|---|
| Ad-hoc / self-signed notifier (**no** embedded profile) | Runs forever. Nothing to expire. **[D]** TN3125: *"macOS doesn't require a provisioning profile to run third-party code."* |
| Developer ID notifier **with** the Time Sensitive profile | **Stops launching when the profile expires.** The parental-control warnings go dark until the membership is renewed and the app re-signed and redeployed. |

That converts "$99 once, try it out" into **"$99 every year forever, or the child's screen-time warnings silently stop working"** — on a system whose entire value is that it keeps running unattended for years. For a family project maintained by one parent, a renewal reminder missed in year three is a realistic failure mode, and the failure is silent.

**This is decisive for sequencing, not just cost.** Build the ad-hoc/self-signed bundle now: it has no expiry, no renewal, no annual cliff. Buy the $99 only if the BTM experiment or observed child behaviour forces it — and if you do, treat the renewal as an operational dependency with a calendar alarm, and keep the free `CFUserNotification` path as the fallback that still works when the profile lapses.

### What is actually lost by not paying

Be honest: it is not nothing.

- **The polite middle ground disappears.** Time Sensitive is a *banner* that breaks through Focus. Without it, warnings that land during a Focus session must either be suppressed (useless) or escalated to a modal dialog (intrusive). For the 30-minute and 15-minute warnings — where you want the child to notice but not to be interrupted mid-sentence — there is no free equivalent. You get either a banner the child may never see, or a dialog that stops everything.
- **Attribution in Login Items stays "unidentified developer."** Cosmetic, but it is the line an inquisitive child would investigate.
- **`AssociatedBundleIdentifiers` will not work**, so the BTM entry will be less cleanly labelled.

**Mitigation that costs nothing:** escalate by tier — ordinary banner at T-30, banner + sound at T-15, `CFUserNotification` dialog at T-5 and at cutoff. The dialog is Focus-immune and unrevocable, so the *enforcement-critical* warnings are never the ones that can be suppressed. Only the courtesy warnings are, and if the child suppresses those, the dialog still arrives.

### Revisit the $99 when

1. The **BTM ad-hoc experiment** (see above) comes back `disallowed` — meaning a Team Identifier is genuinely required for the daemon to survive reboot. **That would move this to a clear go**, because then the $99 buys persistence as well as notifications. **Run this test first; it is 15 minutes and it is the highest-value unknown in this track.**
2. The child demonstrably uses Focus to dodge warnings *and* the `CFUserNotification` dialog proves too blunt in daily use.
3. The project ever needs to be installed on a machine the owner does not administer, where quarantine and Gatekeeper would apply.

---

# Power events and shutdown detection (cross-track response to T6)

**Asked to weigh T6's point that the agent must observe system power events, and to determine whether launchd reliably delivers SIGTERM at shutdown. I confirm T6's conclusion but dissent from its reasoning on one point, which I am surfacing rather than smoothing over.**

## Does launchd deliver SIGTERM to a LaunchDaemon at full system shutdown?

**Yes — Apple documents it explicitly.** From *The Life Cycle of a Daemon*:

> "If the system is being shut down or restarted, it sends a `SIGTERM` signal to all daemons, followed a few seconds later by `SIGKILL` signal."

— <https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/Lifecycle.html>

So SIGTERM is **not** limited to `launchctl unload`/`bootout`. Three caveats qualify it:

1. **`EnableTransactions` inverts this.** **[THIRD-PARTY]** If the job sets `EnableTransactions` and has no outstanding transactions, launchd considers it already clean and sends **SIGKILL directly, with no SIGTERM**. A daemon that wants a shutdown hook must therefore *not* enable transactions — a non-obvious trap. (<https://developer.apple.com/forums/thread/93275>, <https://developer.apple.com/forums/thread/725418>)
2. **The window is short** — "a few seconds", tunable via `ExitTimeOut`; launchd is documented as especially aggressive at restart/shutdown.
3. **[THIRD-PARTY]** Multiple Apple Developer Forums reports of SIGTERM handlers not firing in practice (<https://developer.apple.com/forums/thread/44221>). Contradicts the documentation; unresolved.

## Where I partially disagree with T6

T6 characterised clean-shutdown detection as "straightforward in Swift/Go/C, awkward in bash". **I think that overstates the gap for this specific requirement, and I want the disagreement on record.**

- A bash `trap 'printf clean > /var/db/hpc/exit_flag' TERM` **does** capture shutdown, given the documented SIGTERM. The real bash trap is subtler: **bash defers traps until the current foreground command completes**, so a daemon blocked in `sleep 60` will not run its handler until the sleep returns — past the SIGKILL deadline. The fix is the standard idiom `sleep 60 & wait $!`, which makes the trap fire immediately. Easy to get wrong, but not awkward once known.
- More importantly: **SIGTERM cannot distinguish "system shutting down" from "`launchctl bootout`" from "admin killed it".** All three deliver SIGTERM. A `clean_exit` flag set on SIGTERM is really a *"terminated politely"* flag — which for T6's stated purpose (clean shutdown vs crash) is *mostly* what is wanted, but is not the same thing.
- And the case that matters most — **kernel panic, power loss, hard power-button hold — delivers no signal in any language.** Swift is no better than bash there. Both rely on the absence of the flag.

**Net: `IORegisterForSystemPower` is genuinely better** — it distinguishes shutdown from sleep from logout, gives an explicit willTerminate/willSleep callback, and is not subject to the transactions trap. So T6's *conclusion* is right. But this is a **moderate, supporting** argument against bash, not a load-bearing one. **The load-bearing argument against bash is BTM**, which is categorical: a script-entry-point daemon may simply not be allowed to run after reboot. I would not want the case against bash to rest on the power-event point, because that point is weaker than it looks.

## macOS 26 `<private>` log redaction

T6 reports macOS 26 redacts dynamic log strings as `<private>` by default, ruling out `os_log` as the primary emission path in favour of structured JSON on stdout captured by `StandardOutPath`. **This does not shift the language recommendation** — every candidate writes JSON to stdout trivially. Two notes:
- The `%{public}s` breadcrumb T6 recommends requires an `os_log` call, which is a plain C API available from Swift, Go (cgo) and even bash (via `/usr/bin/logger`, though without the `%{public}s` format control). **Swift has the cleanest access**; this marginally reinforces the existing recommendation rather than changing it.
- **[OBSERVED, macOS 27]** macOS 27's release notes add a section for the **Apple Unified Logging System** ("New Features"). Anyone relying on T6's redaction finding should re-read that section against macOS 27 before finalising the logging design — I did not investigate it, as it falls under T6.

---

# Cross-track reconciliation — summary of agreements and disagreements

| Claim | Source track | My verdict |
|---|---|---|
| A script-entry-point LaunchDaemon is attributed to `/bin/sh` / "unidentified developer" and can be left `disallowed` after reboot | T3 (BTM) | **CONFIRMED** — Apple DTS states the cause (*"the system has a very hard time tracking [responsible code] when you use a script"*); Tahoe field report gives `sfltool dumpbtm` evidence; all 8 third-party daemons on this machine use Mach-O entry points |
| Therefore bash and Python are eliminated as the agent language | T3 | **AGREE — hard constraint** |
| Therefore the $99/yr Apple Developer Program is required, not optional | T3 | **DISAGREE.** BTM needs a **Mach-O executable** (DTS's words), not a Developer ID. Making the item non-toggleable needs **MDM + `com.apple.servicemanagement`**, whose `RuleType` accepts `Label`/`LabelPrefix` — **no Team Identifier required**. Whether ad-hoc alone satisfies BTM is **unverified** and is Open Question #1. |
| TCC binds grants to code identity; a bash daemon cannot hold a durable grant | T7 | **CONFIRMED** — independently: ad-hoc signing makes the designated requirement a cdhash that changes every build; macOS 27's own release notes add that a *process without a bundle ID* cannot be granted container access |
| The agent must observe system power events; awkward in bash | T6 | **CONCLUSION AGREED, REASONING QUALIFIED** — Apple documents SIGTERM at shutdown, so bash can detect clean exit via `trap` + `sleep & wait`. The real gaps are shutdown-vs-bootout ambiguity and the `EnableTransactions` trap. A supporting argument, not load-bearing. |
| Fleet Orbit (Go) is the reference implementation for this class | T7 | **TRUE BUT NOT DECISIVE** — Orbit's macOS-framework surface is thin (it delegates introspection to osquery). Our agent's differentiating work is exactly the framework-heavy part Orbit avoids, and that is where Go's bindings are weakest |
| macOS 27 shipped 2026-09-14 and the brief's macOS 26 assumption is stale | coordinator | **CONFIRMED** — and reviewed: **no macOS 27 change contradicts any T2 conclusion**; two new items recorded (quarantined-plist gate, no-bundle-ID container restriction) |

## What the $99/yr buys — final answer

**One purchase, one thing — not three.**

- **Time Sensitive notifications: REQUIRES the $99.** No free path exists. Apple's capability matrix marks the free tier ❌, and AMFI kills any ad-hoc app that claims the entitlement.
- **Daemon persistence under BTM: FREE.** Compile to a Mach-O binary. (Ad-hoc sufficiency unverified — Open Question #1. If it fails, this moves to the paid column and the go/no-go flips to GO.)
- **Durable TCC grants: FREE.** A stable signing identity is what matters, and a self-signed Keychain code-signing certificate provides one at no cost.

---

# Open questions / things to verify on the target machine

| # | Question | How | Why it matters |
|---|---|---|---|
| 1 | Does BTM allow an **ad-hoc signed Mach-O** LaunchDaemon by default, or also mark it `disallowed`? | Install a trivial ad-hoc daemon, reboot, `sudo sfltool dumpbtm \| grep -A10 <label>`, read `Disposition` | **Decides whether the $99 is required for persistence.** Highest-value unknown. |
| 2 | Does `osascript display notification` actually display anything on the target Mac? | Run it and look at the screen with Focus off | Determines whether the POC has a working notification path *at all* today |
| 3 | Is `CFUserNotification` genuinely un-suppressed by Focus? | Enable a Focus, fire `CFUserNotificationDisplayAlert` | The whole free fallback rests on this |
| 4 | Can a **standard (non-admin)** child account toggle a system LaunchDaemon off in Login Items & Extensions? | Log in as the child, open System Settings | If no, the BTM hole is much smaller than feared |
| 5 | Does `sudo installer -pkg` install an unsigned pkg without a Gatekeeper prompt? | Build an unsigned pkg, install it | Only matters if a pkg installer is chosen over rsync |
| 6 | Is the Mac mini on macOS 26 or 27? | `sw_vers` | 27 adds the quarantined-plist gate; re-run test 1 after any upgrade |

---

# Tests the owner could run deliberately (NOT performed by this track)

These would each require launching quarantined code and would put a Gatekeeper malware dialog on screen. They were
**not** run. Expected outcomes are stated from documentation and are **[RESEARCHED — NOT VERIFIED]**. Run them only
deliberately, knowing a dialog will appear, and only on a machine where that is acceptable.

| Test | Status now | Result |
|---|---|---|
| Launch an **unsigned** app carrying quarantine | **[D]** documented, not tested by us | **Blocked outright**; dialog proposes Trash, **no working override** — even with "Anywhere" enabled. Tested by Howard Oakley on fresh **Tahoe 26.6.1** VMs: <https://eclecticlight.co/2026/08/11/how-can-you-run-code-that-hasnt-been-notarised/> |
| Launch an **ad-hoc signed** app carrying quarantine | **[D]** | Blocked; override via System Settings > Privacy & Security > **Open Anyway**. Not quarantined → *"launched normally, without any warning dialog."* |
| Launch a **free personal-team signed** app carrying quarantine | **[INFERENCE]** | Expected blocked like ad-hoc — an Apple Development cert is neither App Store nor Developer-ID-notarized, and cannot be notarized. **No Apple sentence states this outcome explicitly.** |
| Launch **Developer ID, NOT notarized** carrying quarantine | **[D]** | Blocked with *"Apple can't check it for malicious software"* → Open Anyway. <https://support.apple.com/en-us/102445> |
| Launch **Developer ID AND notarized** carrying quarantine | **[D]** | Allowed, with a one-time consent dialog. **[OBSERVED]** corroboration: a quarantined notarized binary (`/usr/local/bin/docker`) exec'd fine, while quarantined ad-hoc binaries were SIGKILLed. |
| `sudo installer -pkg unsigned.pkg -target /` | **[NOT VERIFIED]** | Expected to succeed with no Gatekeeper prompt. Blocked by lack of passwordless sudo; we would not prompt the owner. Partial corroboration in T2.3. |
| Does `scp`/`rsync` from a remote host set quarantine? | **[D] — now answered** | **No.** Apple DTS: *"Most Unix-y tools don't quarantine their downloads, including curl and scp."* <https://developer.apple.com/forums/thread/666452> |
| Personal-team macOS app after 7 days | **[NOT VERIFIED]** | Resolved by reasoning instead: the clock exists only if `Contents/embedded.provisionprofile` exists. Check that file rather than aging an app. |

**Two macOS 15+ details worth knowing if anyone ever does hit the Gatekeeper path:** the **"Open Anyway" button is only available for about an hour** after you try to open the app, and it requires your **login password** (<https://support.apple.com/guide/mac-help/open-a-mac-app-from-an-unidentified-developer-mh40616/mac>). Also, `spctl --master-disable` and all rule-database edits are **deprecated as of macOS 15** — any guide recommending `spctl --add`/`--enable` is stale; Apple points to configuration profiles instead.

**None of these block the project**, because nothing this project installs will ever be quarantined. They matter only
if the install method ever changes to a browser download.

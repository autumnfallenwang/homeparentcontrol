# T8 — Parent override

**Date:** 2026-09-18
**Brief:** `needs.md` **P1.5** (with **P0.3**, **AR.1**, **O.1**)
**Fits inside:** `raw/T4-contract.md` (agent↔server contract) · `raw/T2-runtime-notifications-signing.md` (`CFUserNotification`)
**Research host:** macOS 26.6.2 (build 25G83), arm64 — same spec as the target Mac mini.

**Evidence grades used throughout**

| Tag | Meaning |
|---|---|
| **[VERIFIED]** | Executed or read on this machine, in this track, today |
| **[RESEARCHED]** | Primary source (Apple docs/headers/DTS, IETF RFC) or credible secondary, cited |
| **[INFERENCE]** | My reasoning from the above. Not established fact |

> **Safety note.** Per the brief, **no dialog was displayed and no consent prompt was triggered.**
> The `CFUserNotification` verification was done by (i) reading Apple's SDK headers and (ii)
> `swiftc -typecheck` — which produces **no binary and executes nothing**. The test program that
> would display a dialog is *written out below but was deliberately not run* (§1.6).

---

## 0. Verdicts first

| # | Question | Verdict |
|---|---|---|
| **T8.1** | Can `CFUserNotification` accept text input? | ✅ **YES — verified.** Up to **8 fields**, each independently maskable via `CFUserNotificationSecureTextField(i)`. ⚠️ **But only through `CFUserNotificationCreate` (dictionary form).** The convenience `CFUserNotificationDisplayAlert` **cannot** — it has no dictionary parameter. |
| **T8.2** | Where does the affordance appear? | ✅ **Adopt the owner's candidate — ride the existing warning dialog**, as a *two-stage* prompt: a third button on the warning, which opens a separate code dialog. Plus one addition the owner did not propose: re-raise it **once per window on first unlock after the lock fires**. An always-available hotkey/menu item is rejected (violates P0.3). A post-enforcement-only affordance is **impossible** — Apple DTS: nothing third-party can draw over the lock screen. |
| **T8.3** | Offline code scheme | ✅ **HMAC-SHA256 truncated to 6 digits, RFC 4226 §5.3, over a counter that binds `(device, screen-time-day, duration, seq)`.** The duration is *inside* the code, so the agent infers the grant size from which candidate matched — nothing extra to type. TOTP rejected (no duration binding, hostile clock story, 30 s step unusable verbally). |
| **T8.4** | The honest security limit | ⚠️ **The child can read `override.key` with `sudo` and mint valid codes forever. This is true and unfixable in this design.** But it is **not the weakest link** — `sudo touch /var/db/homeparentcontrol/DISABLE` (T3 §5.6 Tier 1) is a *total* bypass requiring no cryptography. AR.1 covers it, because it fails at `launchctl bootout` long before it fails here. Mitigations are **visibility, caps and reconciliation** — never obfuscation. |
| **T8.5** | Online path, and composition | ✅ **Zero new primitives needed** — `policy.overrides[]` already exists (T4-D6). One new *field* (`granted_via`). Grant latency **≤5 s** because the parent is by definition in the UI (`attended` cadence). **Build both. Ship (b) first** — it is a day's work and de-risks (a), which depends on an unverified empirical fact. |
| **T8.6** | Semantics | ✅ A grant **moves tonight's start boundary later by N minutes** for one named window — not a suspension, not a budget top-up (though both types are specified so D.4 cannot reopen this design). Granted after the lock fires: **the Mac does not unlock**, the enforcer simply stops re-locking; she logs back in herself within ~5 s. Grants stack, capped at **60 min each / 120 min / 3 grants per day**. |

**Conflicts with prior tracks that I am not smoothing over:** five, in §9. The sharpest is that
**T4 §10.5 must be withdrawn** — it designs a child→parent "Ask for more time" request flow that
P1.5 explicitly forbids.

---

## 1. T8.1 — Can `CFUserNotification` accept text input?

### 1.1 Answer: yes, and it is a first-class documented feature

**[VERIFIED]** Read directly from the SDK on this machine:

```
/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk/System/Library/Frameworks/
    CoreFoundation.framework/Versions/A/Headers/CFUserNotification.h
```

The header's own overview says so in its first paragraph:

> "The contents of the notification can include a header, a message, **textfields**, a popup button,
> radio buttons or checkboxes, a progress indicator, and up to three ordinary buttons."

and, on the reply:

> "It also carries a response dictionary, which describes **the contents of the textfields**."

and, on masking:

> "Certain request flags are specified when a notification is created. These specify an alert level
> … **specify whether any of the textfields are to be secure textfields** …"

**[VERIFIED]** `diff` of the macOS **26.5** and **27.0** SDK copies of this header: **byte-identical.**
So this survives the macOS 27 "Golden Gate" upgrade that T7 flagged as an invalidation event.
Nothing in the text-entry surface changed.

### 1.2 The critical catch: `DisplayAlert` cannot do it

This is the single most important implementation fact in T8.1, and it is easy to get wrong because
T2 §"the alternative Apple actually recommends" and the POC discussion both name
`CFUserNotificationDisplayAlert`.

**[VERIFIED — header signature]**

```c
SInt32 CFUserNotificationDisplayAlert(CFTimeInterval timeout, CFOptionFlags flags,
    CFURLRef iconURL, CFURLRef soundURL, CFURLRef localizationURL,
    CFStringRef alertHeader, CFStringRef alertMessage,
    CFStringRef defaultButtonTitle, CFStringRef alternateButtonTitle,
    CFStringRef otherButtonTitle, CFOptionFlags *responseFlags);
```

There is **no dictionary parameter and no text-field parameter**, and no out-parameter that could
return typed text. `responseFlags` returns only which button was pressed.

**[RESEARCHED]** Confirmed against Apple's open-source CoreFoundation: `CFUserNotificationDisplayAlert`
builds a fixed dictionary from its scalar arguments only; text fields are never populated.
<https://github.com/apple-opensource/CF/blob/master/CFUserNotification.c>

> **Consequence:** the override prompt **must** use the dictionary form —
> `CFUserNotificationCreate` + `CFUserNotificationReceiveResponse` + `CFUserNotificationGetResponseValue`.
> `DisplayNotice`/`DisplayAlert` remain fine for the *warning* dialogs, which need no input.

### 1.3 How many fields, and can input be masked?

**[VERIFIED — header]**

```c
CF_INLINE CFOptionFlags CFUserNotificationCheckBoxChecked(CFIndex i)  { return ((CFOptionFlags)(1UL << (8 + i))); }
CF_INLINE CFOptionFlags CFUserNotificationSecureTextField(CFIndex i)  { return ((CFOptionFlags)(1UL << (16 + i))); }
CF_INLINE CFOptionFlags CFUserNotificationPopUpSelection(CFIndex n)   { return ((CFOptionFlags)(n << 24)); }
```

**Field count: 8, and the bit layout is why.** Secure-field flags occupy bits **16–23**; bit 24
begins the popup-selection field. So `i` is usable only over `0…7`. This matches Apple's
documentation for `kCFUserNotificationTextFieldTitlesKey`, which states the index "must be in the
range 0 to 7". **[RESEARCHED]**
<https://developer.apple.com/documentation/corefoundation/kcfusernotificationtextfieldtitleskey>

**Masking: yes, per-field.** `CFUserNotificationSecureTextField(0)` OR-ed into the creation flags
makes field 0 a password-style field. Masking is **per index**, so you can mix a plain field and a
masked field in the same dialog.

Apple's open-source CF shows the client side merely packages the dictionary and flags into an XML
plist and hands it to the `com.apple.UNCUserNotificationAgent` Mach service; the *rendering* of a
secure field is done by `UserNotificationCenter.app`, not by CF. **[RESEARCHED]**

**[VERIFIED]** That renderer is present and alive on this machine right now:

```
/System/Library/CoreServices/UserNotificationCenter.app          # exists
pgrep -lf UserNotificationCenter → 85951 .../MacOS/UserNotificationCenter   # running
/System/Library/LaunchAgents/com.apple.UserNotificationCenterAgent.plist
/System/Library/LaunchAgents/com.apple.UserNotificationCenterAgent-LoginWindow.plist
```

### 1.4 Retrieving what was typed

**[VERIFIED — header]** `CFUserNotificationGetResponseValue(un, kCFUserNotificationTextFieldValuesKey, idx)`
returns the string for field `idx`. `kCFUserNotificationTextFieldValuesKey` doubles as an *input*
key (pre-filled values) and the *output* key in the response dictionary.
**[RESEARCHED]** In Apple's CF source, the accessor indexes into the response array:
`if (0 <= idx && idx < CFArrayGetCount(value)) retval = CFArrayGetValueAtIndex(value, idx);`

### 1.5 Does it work from a root LaunchDaemon with no GUI session?

**Not directly — and this has a security benefit, not just a cost.**

**[RESEARCHED]** Apple DTS is explicit that `CFUserNotification` is the right API for exactly this
situation — *"works from launchd agents (user context is clear)"* — but that a **daemon** is
"less suitable" because it must decide *which* user gets the dialog.
<https://developer.apple.com/forums/thread/804854> · T2 §"the alternative Apple actually recommends"

With one child on one Mac mini that ambiguity does not exist. T2 already established the bridge, and
it is unchanged here:

```sh
uid=$(/usr/bin/stat -f %u /dev/console)     # console owner = the GUI session user
[ "$uid" -ge 501 ] || exit 0                # guard: nobody logged in / at login window
launchctl asuser "$uid" /usr/local/libexec/hpc-prompt --mode=override-code
```

`launchctl asuser` *"executes the given command in as similar an execution context as possible to
that of the target user's bootstrap"*. **[RESEARCHED]** <https://ss64.com/mac/launchctl.html>

**[VERIFIED]** `stat -f %u /dev/console` returns `501` on this host — the guard works and is cheap.

⚠️ **[RESEARCHED]** `launchctl asuser` is documented-unreliable in a fast-user-switching login
window. <https://developer.apple.com/forums/thread/692749> Guard on `uid >= 501`, treat failure as
"no prompt shown" and **never** treat a failed prompt as a failed code entry.

> #### The privilege boundary this creates — exploit it
>
> **[INFERENCE, and it is load-bearing for §4]** The helper spawned by `asuser` runs **as the child's
> uid**. Therefore the helper must **never hold `K_ovr`**. Design:
>
> - `hpc-prompt` (child's uid) renders the dialog and writes the typed string to **stdout**;
> - `enforcerd` (root) reads it, does the HMAC comparison, and applies the grant.
>
> This means the override secret sits behind `sudo` rather than behind nothing. It does not defeat
> an admin (§5), but it is free and it puts the bar exactly where AR.1 puts it.

### 1.6 The test I wrote and did **not** run

**[VERIFIED]** This type-checks cleanly against `Target: arm64-apple-macosx26.0`,
`Apple Swift version 6.3.3`. `swiftc -typecheck` emits **no binary and executes nothing** — no
dialog was displayed.

```swift
// T8 compile-only probe. Verifies the Swift surface of CFUserNotification text entry.
import CoreFoundation
import Foundation

func buildOverridePrompt() -> CFDictionary {
    let d: [CFString: Any] = [
        kCFUserNotificationAlertHeaderKey:          "Parent override" as CFString,
        kCFUserNotificationAlertMessageKey:         "Ask a parent for the override code." as CFString,
        kCFUserNotificationTextFieldTitlesKey:      ["Code"] as CFArray,   // 1 field
        kCFUserNotificationTextFieldValuesKey:      [""] as CFArray,       // prefill
        kCFUserNotificationDefaultButtonTitleKey:   "Unlock" as CFString,
        kCFUserNotificationAlternateButtonTitleKey: "Cancel" as CFString,
        kCFUserNotificationAlertTopMostKey:         kCFBooleanTrue as Any,
    ]
    return d as CFDictionary
}

// Caution level; field 0 masked like a password (see §1.7 — recommend OFF in production).
let flags: CFOptionFlags =
    CFOptionFlags(kCFUserNotificationCautionAlertLevel) | CFUserNotificationSecureTextField(0)

func readCode() -> String? {
    var err: Int32 = 0                                     // NB: Int32, not SInt32, in Swift
    guard let un = CFUserNotificationCreate(nil, 120, flags, &err, buildOverridePrompt()) else { return nil }
    var response: CFOptionFlags = 0
    guard CFUserNotificationReceiveResponse(un, 120, &response) == 0 else { return nil }   // 0 = got a reply
    guard (response & 0x3) == CFOptionFlags(kCFUserNotificationDefaultResponse) else { return nil }
    return CFUserNotificationGetResponseValue(un, kCFUserNotificationTextFieldValuesKey, 0) as String?
}
```

Everything above compiled: the two text-field keys bridge as `CFArray`, `CFUserNotificationSecureTextField(0)`
is callable from Swift and returns `CFOptionFlags`, and `GetResponseValue` bridges to `String?`.
**The only Swift-vs-C wrinkle is that `SInt32` does not exist in Swift; use `Int32`.** Noting it
because it is the exact error a first implementation will hit.

**To actually verify rendering, on the Mac mini, deliberately (⚠️ V-T8.1 in §11):**
build the above with a `main`, run it **once, in the child's own session, while the owner is
present**, confirm the field appears, confirm masking, confirm the 120 s timeout returns
`kCFUserNotificationCancelResponse`, then repeat via `sudo launchctl asuser $uid`. ~15 minutes.

### 1.7 Should the field be masked? — **No. Recommend masking OFF.**

**[INFERENCE]** Masking is *available* (verified above) and should nonetheless be disabled:

1. The parent reads the digits aloud to the child **in person**. The child necessarily knows the
   code. Masking protects against nobody who matters.
2. Masking removes her ability to check her own typing → more failed attempts → the rate limiter
   (§4.6) fires → false tripwire alerts to the parent, which is the fastest way to get an alert
   channel ignored.
3. The threat masking defends (shoulder-surfing a reusable secret) does not exist here: the code is
   single-use, duration-bound and dead the same night.

Keep `CFUserNotificationSecureTextField(i)` documented as a one-line change if the owner disagrees.

### 1.8 Risk flag carried forward

⚠️ **[RESEARCHED]** There is an **unanswered** 2021 Apple Developer Forums report of
`CFUserNotificationDisplayAlert` showing on Catalina but **not** on Big Sur.
<https://developer.apple.com/forums/thread/682520>

This is the *same evidence pattern* T2 used to doubt `osascript display notification` — an
unanswered forum report plus an inference. It does not overturn anything, but it means the entire
warning-and-override surface rests on a mechanism **never once observed working from a daemon on
macOS 26 in this project.** T2 already listed this as its open test #3. **T8 raises it to the top
blocking test**, because T8.2's design has no fallback surface (§2.4).

---

## 2. T8.2 — Where does the override affordance appear?

### 2.1 The constraint that decides it

**[RESEARCHED — Apple DTS, primary]** Quinn, on displaying a window or alert over the loginwindow:

> "The way the lock screen is set up, **the only third-party code that can display UI is an
> `SFAuthorizationPluginView`**. And the goal of that class is to replace the login UI, not
> supplement it."

<https://developer.apple.com/forums/thread/654383>

> **Therefore: an affordance that appears only *after* enforcement fires is not buildable.**
> Once the screen is locked there is no supported way to put a code box in front of the child.
> Writing an authorization plug-in to do it is a non-starter for an ad-hoc-signed hobby agent and
> would be a far larger security surface than the thing it protects.

⚠️ **[INFERENCE, interesting, unverified]** `com.apple.UserNotificationCenterAgent-LoginWindow.plist`
exists with `LimitLoadToSessionType = "LoginWindow"` and `ProgramArguments = [..., "-loginwindow"]`
**[VERIFIED]** — i.e. Apple *does* run a UNC presenter in the LoginWindow session. That suggests a
`CFUserNotification` might render at the **login window** (no user logged in). That is a *different*
context from the **lock screen** of a logged-in session, which is what bedtime produces. I am not
building on it, and I am not recommending anyone try. Recorded so a later reader does not think it
was missed.

### 2.2 Options, evaluated

| Option | P0.3 ("no interaction surface for the child") | Works? | Cost | Verdict |
|---|---|---|---|---|
| **Ride the existing warning dialog** (owner's candidate) | ✅ **Intact.** She cannot invoke it; the system raises it. It does nothing without a secret she does not hold | ✅ Yes | ~0 new surface; one extra button | ✅ **ADOPT** |
| Hotkey / menu-bar item / status item | ❌ **Violates P0.3.** A persistent, child-invocable surface is precisely the thing P0.3 denies. Also needs a LaunchAgent in her session, which is a new BTM/TCC identity to manage (T1, T3) | ✅ Yes | High | ❌ **REJECT** |
| Only after enforcement fires | ✅ | ❌ **No — not buildable** (§2.1). Under `action: "shutdown"` the Mac is *off* | — | ❌ **REJECT** |
| A `Terminal` command she types | ❌ Teaches her the agent's CLI; discoverable surface | ✅ | Low | ❌ **REJECT** — the worst of both |
| Web page on the control plane, opened on her Mac | ❌ New UI on her end; and it needs the network, defeating the whole point | ⚠️ | Med | ❌ **REJECT** |

### 2.3 Recommendation — a **two-stage** prompt, not one dialog

The owner's instinct is right. One refinement: **do not put the text field on the warning dialog.**

**Stage 1 — the existing warning** (unchanged except for one button). `CFUserNotificationDisplayAlert`
is fine here; no input needed.

```
┌──────────────────────────────────────────────┐
│  ⚠  Bedtime in 5 minutes                     │
│     Your Mac will lock at 21:30.             │
│                                              │
│          [ Parent override ]      [  OK  ]   │
└──────────────────────────────────────────────┘
      alternate button                default
```

**Stage 2 — only if "Parent override" is pressed.** `CFUserNotificationCreate` with one text field.

```
┌──────────────────────────────────────────────┐
│  Parent override                             │
│  Ask a parent for the override code.         │
│                                              │
│  Code   [ 481906                          ]  │
│                                              │
│          [   Cancel   ]      [  Unlock  ]    │
└──────────────────────────────────────────────┘
```

**Why two stages rather than one:**

1. `CFUserNotification` allows a maximum of **three** buttons. Keeping the warning at two leaves a
   slot free for a future need. A combined dialog would spend it immediately.
2. The code field then appears **only on deliberate action**, which is a stronger P0.3 story: the
   default nightly experience has no input surface at all.
3. The warning fires 3–4 times a night and is mostly ignored. A text field on it becomes furniture;
   a text field she had to ask for does not.
4. Independent timeouts: the warning can be brief, the code dialog needs ~120 s (she is walking to
   another room and back).

**When Stage 1 shows the button:** at every configured warning lead (`15, 5, 1` minutes) **and at
the boundary itself**. Configurable via `override.prompt.show_on_warning_lead_minutes`.

### 2.4 The addition the owner did not propose — one grace prompt per window

**[INFERENCE]** There is a real hole in "warnings only": she presses "Parent override" at T-5, walks
off to ask, the 120 s dialog times out, the Mac locks, and now **there is no way to redeem the code
she was just given** (§2.1). That is the exact scenario the feature exists for, and it fails.

Fix, ~20 lines:

> On the **first transition from locked → unlocked inside a restricted window**, the enforcer raises
> the Stage-2 code dialog and defers its re-lock for `override.prompt.grace_s` (default **90 s**).
> **Once per restricted window**, persisted so a restart does not reset it, and emitted as an audit
> event.

Not exploitable: 90 seconds, once per night, logged. It relies on `lock` being a *predicate
re-evaluated every tick* (T4-D13) rather than a one-shot, which the contract already mandates.

⚠️ **This only works under `action: "lock"`.** See §9 C4.

### 2.5 Does this violate P0.3? — No, and the distinction is precise

P0.3 denies the child a **management or viewing surface** — "about denying an interaction surface".
The test that matters is: *can she initiate anything?*

| | "Parent override" button (T8) | "Ask for more time" button (T4 §10.5) |
|---|---|---|
| Child can invoke it unprompted | No — only on a dialog the system raises | No |
| Sends anything to the parent | **No** | **Yes — creates a request channel** |
| Works without a parent secret | **No** | Yes — anyone can press it |
| Creates a nag surface | No | **Yes** |

The first is an *input slot for a parent-supplied secret*. The second is a *child-initiated request
channel*, which P1.5 rules out in the owner's own words. They look similar and are not.
**§9 C1 records that T4 §10.5 must be withdrawn.**

---

## 3. T8.3 — The offline code scheme

### 3.1 Why offline is mandatory, restated

O.1 is "fail-open on ignorance, fail-closed on knowledge". A cached policy **keeps enforcing
indefinitely** while the server is unreachable (T4 §8.3: *"the cached policy never expires"*).
So the exact moment mechanism (b) stops working — k3s down, LAN down, Wi-Fi flaky — is a moment when
bedtime **still fires**. A network-only override is a lock with the key inside.

### 3.2 Mechanism comparison

Assumptions for the table: the child has admin (AR.1); the parent transmits the code **verbally, in
person**; the agent's clock may be off (T4 §8.4.3); "local key read" means she runs `sudo cat` on the
agent's state directory.

| # | Scheme | Usable code | Online brute force | Survives a **local key read**? | Replay protection | Clock dependence | Parent gets it with the server down | Verdict |
|---|---|---|---|---|---|---|---|---|
| **A** | **TOTP (RFC 6238, T=30 s)** | 6 digits | Strong | ❌ No — shared secret | Time-step only; reusable within the step | ❌ **Severe.** 30 s step vs. an admin-settable clock; T4's monotonic fallback makes step alignment fragile after days offline | ✅ Authenticator app | ❌ **Reject.** Also: **cannot express a duration** — parent must convey "how long" some other way |
| **B** | **TOTP, long step (T=1 h, ±1)** — Family Link's shape | 6 digits | Strong | ❌ No | Weak — reusable for up to 2 h | ⚠️ Moderate | ✅ Authenticator app (non-standard step) | ⚠️ **Near-miss.** Fixes the usability, still no duration binding |
| **C** | **HMAC over (device, day, duration, seq)** — HOTP with a structured counter | **6 digits** | Strong (§3.4) | ❌ No | ✅ Strong — single-use, tracked by tuple | ✅ **Low** — 24 h granularity, ±1 day accepted | ✅ Offline card page or printed card (§3.6) | ✅ **RECOMMEND** |
| **D** | **Signed grant token (Ed25519)** | ~110 base32 chars | N/A | ✅ **Yes** — device holds only the public key | ✅ Nonce in payload | ✅ Low | ✅ Signer on parent's phone | ❌ **Reject.** Unusable verbally; cannot be truncated without destroying verification. QR is dead — **a Mac mini has no camera** |
| **E** | **Pre-provisioned one-time codes; device stores only hashes** (the "recovery codes" pattern) | ~10 Crockford chars | Strong | ✅ **Yes** — but only if entropy survives *offline* cracking (§3.5) | ✅ Strongest | ✅ **None** | ✅ Printed/saved list — **best of all here**, no computation | ⚠️ **Upgrade path only** (§5.5) |
| **F** | Static shared PIN | 4–6 digits | Weak | ❌ No | ❌ **None** — learned once, reusable forever | ✅ None | ✅ Memorised | ❌ **Reject outright** |
| **G** | *(reference)* Online grant, mechanism (b) | — | N/A | N/A | ✅ | ✅ | ❌ **Fails exactly when needed** | ✅ Build it too — as the *primary*, not the only (§6) |

### 3.3 Recommended scheme, concretely

**Name:** `hpc-ovr-v1`. It is **RFC 4226 HOTP with a structured counter** — deliberately, so the
truncation is Apple-free, well-reviewed, and implementable in ~30 lines on both ends.

```
K_ovr    32 random bytes, per device, server-generated, 30-day rotation
day      the screen-time day in policy.timezone, as "YYYY-MM-DD"
minutes  ∈ policy.override.allowed_minutes           (default [15, 30, 60])
seq      0-based counter within (day, minutes)        (0 … max_seq_per_bucket-1, default 3)

msg  = "hpc-ovr-v1" ‖ 0x00 ‖ device_id ‖ 0x00 ‖ day ‖ 0x00 ‖ dec(minutes) ‖ 0x00 ‖ dec(seq)
mac  = HMAC-SHA256(K_ovr, msg)
code = DynamicTruncate(mac) mod 10^6            # RFC 4226 §5.3, verbatim
```

Displayed to the parent grouped `481 906`.

**Verification, agent side (root):**

```
for d in {day-1, day, day+1}:                   # ±1 day clock tolerance
  for m in allowed_minutes:                     # 3
    for s in 0 … max_seq_per_bucket-1:          # 3
      if constant_time_eq(code, derive(d, m, s)):
          if redeemed.contains(d, m, s):  → reject "already used"
          if caps_exceeded(d, m):         → reject "daily limit"
          → GRANT m minutes; record redeemed(d, m, s)
```

**Four properties worth naming, because they are what makes this beat TOTP:**

1. **The duration is inside the code.** The parent says six digits; the agent *derives* whether it
   meant 15, 30 or 60 from which candidate matched. **Nothing extra to type, and a 15-minute code
   cannot be replayed as a 60-minute one.** No other scheme in the table gives this.
2. **`seq` gives a second code the same night** without reuse — the parent can grant twice.
3. **24-hour granularity kills the clock problem** that sinks TOTP (§3.7).
4. **27 candidate HMACs per verification** — about 30 µs. Irrelevant cost.

### 3.4 Code length vs. brute force — the arithmetic

Valid code set per verification: `3 days × 3 durations × 3 seq = 27` out of `10^6`.

| Digits | Space | P(hit/guess) | Median guesses | At 20 attempts/night | Verdict |
|---|---|---|---|---|---|
| 4 | 10⁴ | 2.7×10⁻³ | ~185 | ~9 nights | ❌ Too short |
| **6** | **10⁶** | **2.7×10⁻⁵** | **~18,500** | **~925 nights ≈ 2.5 years** | ✅ **Recommended** |
| 8 | 10⁸ | 2.7×10⁻⁷ | ~1.85×10⁶ | ~250 years | Overkill; measurably worse to say aloud |

**RFC 4226 mandates ≥ 6 digits** and recommends numeric-only "so that it can be easily entered on
restricted devices". **[RESEARCHED]** <https://www.rfc-editor.org/rfc/rfc4226.txt>

Note the attempt budget is genuinely ~20/night, not 20/hour, because **the dialog is only reachable
when the system raises it** (§2.3) — roughly 4 prompts per night × 5 attempts. And every failure is
an audit event. Guessing is not a threat; §5 is.

**What "lockout" means here — and what it must *not* mean.** **[INFERENCE, and it matters]**

> Lockout means **the override prompt stops accepting codes** for `attempt_window_s` (default
> 900 s), and the attempts are logged and surfaced. **It must never mean extra punishment** — not a
> longer lock, not an earlier bedtime, not a shutdown.

Making lockout punitive would invert T4 §8.2's harm asymmetry (*"a parental control that has ever
locked a kid out wrongly is a parental control that gets uninstalled"*) and would hand her a
self-inflicted denial-of-service: type garbage, get punished, blame the tool. **Failing to redeem an
override leaves the evening exactly as it would have been with no override feature at all.** That is
the correct null behaviour.

RFC 4226 §7.3's throttling parameter `T` is the precedent: refuse after `T` unsuccessful attempts.
It says nothing about punishing the user. **[RESEARCHED]**

### 3.5 Why scheme E (hashed code list) is the *upgrade path*, not the answer

E is the only scheme that survives a local key read, and it deserves an honest hearing rather than
a dismissal, because that property is exactly what §5 says we cannot have.

It works like server backup codes: the server mints N random codes, ships the agent **only**
`{id, minutes, KDF(code)}` in the signed policy, and the parent holds the plaintext list. An admin
child reading the disk gets hashes.

**Why it does not win here.** She has admin, so she can copy the hash file and crack it **offline,
unthrottled, on her own hardware**. The entropy must therefore survive offline cracking, not online
guessing:

| Code | Entropy | Argon2id @ ~10⁵ guesses/s (GPU) | Verbally usable? |
|---|---|---|---|
| 8 digits | 26.6 bits | **~11 minutes** | ✅ |
| 8 Crockford base-32 | 40 bits | ~3 months | ⚠️ |
| **10 Crockford base-32** | 50 bits | ~350 years | ❌ `K7M4-P2QX-9B` read aloud, nightly |

**So E costs ~10 characters of nightly friction to defeat an attacker who has a one-command bypass
available (§5.2).** That is the definition of security theatre, and the brief asks me not to build
it. **Recorded as the documented upgrade path if AR.1 is ever revoked** (§5.5) — mirroring T4 §6.9's
convention of writing down the stronger design so the decision stays reversible.

### 3.6 How the parent gets the code when the server is down

**This is the sharpest question in the brief and it has a specific answer.** The parent UI is a
Next.js app on the same k3s cluster. **If the cluster is down, the UI is down** — so a
server-rendered code is unavailable in precisely the scenario the offline path exists for. Any
design where the parent must load a page to get a code has not actually solved the problem.

**Recommendation — a self-contained offline code card, saved to the parent's phone.**

> The parent UI serves a **single static HTML file** with `K_ovr` embedded, which computes codes
> entirely in the browser with `crypto.subtle.importKey`/`sign` (HMAC-SHA256 is in WebCrypto
> everywhere). The parent saves it to their home screen **once**, while the server is up. It then
> works forever with no network, no app store, no account, on a plane.

~50 lines. It shows a 3×3 grid — `15 / 30 / 60 min` × `seq 0 / 1 / 2` — for today, with a date
picker for "tomorrow" in case the child's Mac has drifted. This is the right shape for a self-hosted
home system: the parent's device becomes the offline authority, which is what "self-hosted" should
mean.

**Fallbacks, in order:** (1) a printed 30-day card in a drawer — 90 rows, one sheet, covers a dead
phone; (2) any second parent device with the page saved; (3) `openssl dgst -sha256 -hmac` from the
owner's laptop, documented in the runbook.

⚠️ **Honest cost, stated in §5.6:** `K_ovr` now exists in plaintext on the parent's phone. That is
the same secret the child's Mac already holds, so it widens *who* can leak it, not *what* leaks.

### 3.7 Clock dependence, and the day-boundary trap

The day bucket is **24 hours wide**, so this scheme tolerates hours of skew where TOTP tolerates
seconds. Accepting `day ± 1` extends that to ±24 h at a cost of 3× the candidate set (already
priced into §3.4).

Which clock does the agent use? **T4 §8.4.3's trusted time basis, unchanged** — the local clock
normally; `server_time_at_last_sync + mach_continuous_time()` delta once skew exceeds 5 minutes.
**No new time machinery.** And because `mach_continuous_time()` advances through sleep (T4-D14),
the projection stays good for days.

⚠️ **The trap: bedtime straddles midnight.** With a bedtime of 21:30→07:00, a code minted on the
evening of the 18th may be typed at 00:20 on the 19th. A naive `YYYY-MM-DD` bucket changes
underneath the grant, mid-window.

**Fix — and I considered and rejected the obvious one.** Moving the rollover to 04:00 does not help:
the 04:00–07:00 tail is still on the far side. The correct fix is the ±1 day acceptance window
already specified, which covers the straddle *exactly* and costs nothing extra. The parent's card
shows "today", the agent accepts yesterday/today/tomorrow. **Do not attempt a clever screen-time-day
definition; it is schedule-dependent and will be wrong for a budget rule (D.4).**

### 3.8 Prior art

**[RESEARCHED]** **Google Family Link "parent access code"** is the closest shipping analogue and
validates the shape: parent-held, **locally generated**, time-based, refreshing on a **60-minute**
step (not 30 s — the same usability concession this design makes with a 24 h step), typed by the
child on the device to unlock or change limits.
<https://support.google.com/families/answer/7307262?hl=en>

Two divergences, both deliberate:

1. Reporting is inconsistent on whether Family Link's code truly works with the *child's* device
   offline — several sources say the child device must reach Google at press time. **T8 treats
   offline redemption as a hard requirement**, not best-effort, because O.1 makes it one.
2. Family Link's code **carries no duration**; it authenticates a parent, who then adjusts settings
   on-device. That requires an on-device settings UI — which **P0.3 forbids**. Binding the duration
   into the code is how this design gets the same outcome with no settings surface.

**[RESEARCHED]** T7 recorded that Apple's own **Screen Time passcode** is what upgrades Downtime from
a dismissible notice to a block — i.e. Apple also treats a parent-held secret as the thing that makes
a limit real. Same principle, and it is a point in favour.

---

## 4. Recommended design — concrete enough to implement

### 4.1 Policy document addition (inside the signed JWS payload)

Additive only, per T4 **R2**. Old agents ignore it; new agents against an old server default it off.

```json
"override": {
  "enabled": true,
  "allowed_minutes": [15, 30, 60],
  "max_minutes_per_day": 120,
  "max_grants_per_day": 3,
  "offline_codes": {
    "enabled": true,
    "key_id": "ovk_01JB9C4D6E8F0G2H4J6K8M",
    "alg": "HMAC-SHA256",
    "digits": 6,
    "day_window": 1,
    "max_seq_per_bucket": 3,
    "attempts_per_window": 5,
    "attempt_window_s": 900
  },
  "prompt": {
    "show_on_warning_lead_minutes": [15, 5, 1],
    "show_at_boundary": true,
    "grace_s": 90,
    "timeout_s": 120,
    "mask_input": false
  }
}
```

### 4.2 The grant itself — T4's existing `policy.overrides[]`, one new field

`granted_via` is the **only** addition to T4's shape. Everything else is already in the contract.

```json
{
  "id": "ovr_01JB8DFG2H4J6K8M0N2P4R",
  "type": "extend",
  "window_id": "win_school_night",
  "minutes": 30,
  "effective_date": "2026-09-18",
  "expires_at": "2026-09-19T06:00:00Z",
  "granted_by": "usr_01JB7X9A1B2C3D4E5F6G7H",
  "granted_via": "ui",
  "reason": "finishing history essay"
}
```

`granted_via` ∈ `"ui" | "offline_code"`. Per T4 **R5**, an unknown value degrades to `"ui"` and logs.

**`type`** ∈ `"extend" | "suspend" | "grant_minutes"` — see §7.

### 4.3 Key delivery — `desired[]`, never the policy cache

T4 §4.6 is explicit that `desired[]` (b) exists for intent that must not be persisted into the
policy cache "because it is transient, **or because it carries a secret**". `K_ovr` is a secret.
It therefore travels exactly like the credential rotation in T4-D11:

```json
{
  "desired_id": "des_01JB8B9X2Y4Z6A8C0E2G4M",
  "kind": "override_key",
  "spec": {
    "key_id": "ovk_01JB9C4D6E8F0G2H4J6K8M",
    "secret": "base64url:9f2c7a1e…",
    "alg": "HMAC-SHA256",
    "not_after": "2026-10-18T00:00:00Z"
  }
}
```

**Convergence** (T4 §4.6 rule 3): the server removes the item when it observes the agent reporting
`override.active_key_id == key_id` on a tick. Overlap: the agent accepts **both** the outgoing and
incoming key for 24 h, so a rotation racing a reboot cannot strand an outstanding code — the same
overlap discipline T3 §3.3 uses for the credential.

**At rest:** `/var/db/homeparentcontrol/override.key`, mode `0600`, `root:wheel`, inside the `0700`
directory (T4 §6.7). **Never** in the plist, never on a command line, never logged. Add
`ovk_[A-Za-z0-9_-]+` and the raw secret to the redaction list alongside `hpc_dk_`.

### 4.4 Sync request addition

```json
"override": {
  "active_key_id": "ovk_01JB9C4D6E8F0G2H4J6K8M",
  "pending_key_id": null,
  "active_grants": [
    { "id": "lov_01JB8E7F9G1H3J5K7M9N1P", "granted_via": "offline_code",
      "minutes": 30, "expires_at": "2026-09-19T06:00:00Z" }
  ],
  "minutes_granted_today": 30,
  "grants_today": 1,
  "failed_attempts_today": 0,
  "prompt_locked_until": null
}
```

This makes an offline redemption visible on the **very next tick** even before the audit event
drains — which is what lets the parent UI say "Applied ✓" quickly (§6.2).

### 4.5 Audit events (`class: "audit"` → flush immediately, T4-D19)

```json
{
  "event_id": "01JB8C3QD5F7H9K1M3P5R7TA1",
  "type": "override.redeemed",
  "v": 1,
  "class": "audit",
  "ts": "2026-09-18T21:34:12.881Z",
  "boot_id": "b_01JB8A2N4C6E8G0J2L4N6Q",
  "seq": 41310,
  "data": {
    "local_grant_id": "lov_01JB8E7F9G1H3J5K7M9N1P",
    "granted_via": "offline_code",
    "key_id": "ovk_01JB9C4D6E8F0G2H4J6K8M",
    "bucket": { "day": "2026-09-18", "minutes": 30, "seq": 0 },
    "window_id": "win_school_night",
    "expires_at": "2026-09-19T06:00:00Z",
    "prompt_source": "warning_modal_t5",
    "clock_trusted": true,
    "policy_age_s": 181795,
    "server_reachable": false
  }
}
```

Also emitted: `override.attempt_failed` (with `attempts_in_window`, `locked`),
`override.prompt_shown`, `override.expired`, `override.key_rotated`,
`override.rejected { reason: "daily_cap" | "replay" | "disabled" }`.

### 4.6 Agent state on disk

```
/var/db/homeparentcontrol/
├── override.key            0600 root:wheel   # K_ovr + key_id + not_after (+ previous, 24h overlap)
├── override.redeemed.json  0600 root:wheel   # [{day,minutes,seq,redeemed_at}], pruned >7d
└── override.grants.json    0600 root:wheel   # live local grants (id, minutes, expires_at, window_id)
```

`override.redeemed.json` is the replay defence. It is written with the same
write-temp-then-`rename(2)` discipline as the policy cache (T3 §2.2), **before** the grant takes
effect — so a crash between redeem and apply costs the child a code, never the parent a duplicate.

### 4.7 The merge rule — the bug this design would otherwise ship

**[INFERENCE, and it is the easiest thing here to get wrong]**

> The agent's effective override set is
> **`policy.overrides[]` ∪ `override.grants.json`** — a **union**, each element carrying its own
> `expires_at`. A policy refresh **never** clears a locally-redeemed grant.

Without this rule: the child redeems an offline code at 21:34, the LAN comes back at 21:36, the next
tick delivers a policy whose `overrides[]` does not mention the offline grant (the server does not
know about it yet), the agent replaces its override set, and **the grant the parent just gave
silently evaporates.** Worse, it would evaporate *only when the network recovers*, making it
maddening to reproduce.

Local grants age out on their own `expires_at` and are then removed. The server never retroactively
injects a redeemed offline grant into `policy.overrides[]` (§6.3).

---

## 5. T8.4 — The honest security limit

### 5.1 State it plainly

> **The child has admin. `K_ovr` sits in a root-owned file on her Mac. She can run
> `sudo cat /var/db/homeparentcontrol/override.key`, and from that moment she can generate valid
> override codes for herself, for any allowed duration, indefinitely, offline, undetected by the
> cryptography.**

There is no version of this design in which that is false, because the agent must verify offline and
therefore must hold a verification secret. Scheme E (§3.5) moves the problem rather than solving it,
at a cost of ~10 characters per night. **No amount of engineering fixes this. Do not let anyone
believe otherwise.**

### 5.2 But it is not the weakest link — and that is the load-bearing point

Everything below is available to the same admin, tonight, with **no cryptography and no research**:

| Bypass | Command | Effort | Result |
|---|---|---|---|
| **Kill-switch file** (T3 §5.6 Tier 1) | `sudo touch /var/db/homeparentcontrol/DISABLE` | **1 command** | **Enforcement off entirely.** No code needed, no duration cap, no expiry |
| Unload the daemon | `sudo launchctl bootout system/com.homeparentcontrol.enforcer` | 1 command | Agent gone (until `KeepAlive`/reboot) |
| Delete the policy | `sudo rm /var/db/homeparentcontrol/policy.cache.json policy.lkg.json` | 1 command | **Fail-open class B/C** → no enforcement, loudly (T4 §8.2) |
| Forge override codes | read key, implement HMAC, mint 6 digits | **an afternoon** | +60 min, capped, expiring, and **logged** |

> **Forging override codes is the single most expensive and least rewarding attack on this list.**
> It is the only one that is rate-limited, duration-capped, day-capped, auto-expiring, and reported.
> A child who would build it has three cheaper, unlimited alternatives she would find first.

**The override key does not widen the attack surface. It sits behind a door that is already open.**

### 5.3 Does AR.1 cover it? — Yes, precisely, and here is the reasoning

AR.1: *"my kids is not capable to stop a terminal app which auto start even with admin account."*

If that assessment holds, she cannot find and exploit an HMAC key either — the key attack is
strictly harder than the daemon attack AR.1 already assumes she cannot do. If the assessment fails,
**it fails at `launchctl bootout` first**, which AR.1 nominates as the tell. So T8 introduces **no
new assumption**; it inherits AR.1 exactly.

⚠️ **One genuinely new cost, which I will not hide.** The override feature adds a *user-facing prompt
that says "type a code here."* That is an invitation to investigate, and it makes the existence of a
local secret **discoverable** in a way the current design is not. This is a real (small) increase in
the probability that AR.1's assumption gets tested. It argues for two cheap things: keep the prompt's
wording unremarkable, and make §5.4's detection genuinely good — because the first sign of trouble
will now more likely be a forged code than a dead daemon.

### 5.4 Cheapest mitigations that are not theatre

Ordered by value per line of code. **The philosophy is the owner's own, from T4 §6.4: *make it
boring to steal rather than hard to steal.***

| # | Mitigation | Cost | What it actually buys |
|---|---|---|---|
| **1** | **Server-side reconciliation of every redemption.** The server matches each `override.redeemed` to an issued `(day, minutes, seq)`. **No match → `override.unmatched` alert: "Lucy used a 30-minute code you never issued."** | ~40 lines | ⭐ **The one that works.** Converts forgery from "free hour" into "a notification to the parent." Misuse becomes **visible**, not prevented. This is the whole philosophy in one feature |
| **2** | **Bound the maximum.** ≤60 min per grant, ≤120 min/day, ≤3 grants/day — enforced **in the agent**, so the caps hold offline | ~20 lines | A forged code cannot buy an all-nighter. To get one she must forge repeatedly → more alerts |
| **3** | **Mandatory `expires_at`** (T4-D7, already in the contract) | 0 — free | Even a forged grant dies. There is no reachable permanent bypass |
| **4** | **Rate limit + non-punitive lockout** (§3.4) | ~15 lines | Kills guessing; every failure is an audit event |
| **5** | **Server-only key rotation, 30 days** (T3 §3.3 discipline) | reuses existing | A stolen key has a bounded life. She must re-steal monthly, and each theft needs `sudo` |
| **6** | **The `asuser` privilege split** (§1.5) | ~0 — a design choice | The secret is behind `sudo`, not behind nothing |
| **7** | **Make the kill-switch file loud** — alert on *appearance*, not just report it in the heartbeat; default it time-boxed | ~10 lines | Closes the *actually* weakest link (§9 C2) |

**Explicitly rejected as theatre:**

- Obfuscating or XOR-ing the key file. An admin with `strings` and 20 minutes wins; it only makes
  *debugging* harder for the owner.
- White-box crypto, anti-debugging, SIP games. Wildly disproportionate.
- **Secure Enclave.** Tempting, and worth one sentence: macOS SE keys (`kSecAttrTokenIDSecureEnclave`)
  are **P-256 ECC only** — no HMAC — and even then a root process can still *use* the key. She could
  not copy it to another machine, but she could still mint codes on this one, which is the whole
  attack. Real complexity, restricted entitlements this ad-hoc-signed binary cannot have (T2), for a
  partial mitigation. **No.**
- Longer codes. §3.4 shows 6 digits already gives 2.5 years against guessing; 8 digits defends
  against nothing that 6 does not, and costs real usability every night.

### 5.5 The documented upgrade path, if AR.1 is ever revoked

Per T4 §6.9's convention. If the child's capability changes, in order:

1. Move the child to a **non-admin account** (defence-in-depth again, per AR.1's consequences). This
   alone restores the whole design, cheaply — and it is where to start.
2. Switch offline codes to **scheme E** (§3.5): device holds Argon2id hashes only, 10-char codes,
   parent holds the plaintext list. The agent then holds **no minting secret at all**.
3. Only then consider MDM/DDM — which §Descoped already prices as unjustifiable.

### 5.6 Two further limits, for completeness

- **The offline card puts `K_ovr` on the parent's phone in plaintext** (§3.6). An unlocked parent
  phone is a full compromise. This is a social boundary, not a technical one, and it is the correct
  trade for a system that must work with the server down.
- **The `hpc-prompt` helper runs as the child's uid** (§1.5). She can attach a debugger to it and
  read what she types — which she already knows. She **cannot** read `K_ovr` through it, because the
  helper never holds it. Verify this in code review; it is the kind of thing a refactor breaks.

---

## 6. T8.5 — The online path, and how the two compose

### 6.1 Mechanism (b) against T4's existing contract — no new primitives

1. Parent opens the device page → server sets the sticky `attended` flag (T4 §10.3) →
   `next_poll_after_ms: 5000`.
2. Parent clicks **+30 min** → server appends to `policy.overrides[]`, bumps `policy_version`,
   recomputes the ETag.
3. Next tick (≤5 s) returns `policy.unchanged: false` with the new JWS.
4. Agent verifies the signature, parses, merges (§4.7), recomputes the boundary. Done.

**Latency, honestly:** worst case 60 s in base cadence, 15 s in `boundary` mode, **≤5 s in
`attended` mode — which is always the case here**, because granting *requires* the parent to be in
the UI. T4's adaptive cadence already solves this; T8 adds nothing.

⚠️ **One contract refinement required — see §9 C3.** T4-D17 makes `confirm_immediate_effect`
mandatory for any policy taking effect within 15 minutes. **Every override grant is exactly that**,
so as written, every single grant would pop a confirmation dialog. That would train the parent to
click through it and **destroy the guard for the fat-fingered-bedtime case it was built for.**
The guard must apply only to changes that make enforcement **stricter** sooner. Relaxations are
exempt; **early revocations of a grant are not** (they tighten).

### 6.2 What the parent sees — confirm on convergence, not on write

Applying T4-D24 (reconciliation) to the UI:

```
+30 min for Lucy                    Sent ✓ 21:29:58 → Applied ✓ 21:30:03  (5 s)
Bedtime tonight: 21:30 → 22:00 · expires 06:00
```

"Applied" is driven by the agent's own next tick reporting the new `policy_version` **and** an
`enforcement.next_boundary_at` that reflects the shift. If it does not land within 30 s the card
shows `Sent ✓ — not yet applied` plus the device's health state. **Never** claim success on the
server write; that is the "the server thinks it delivered" failure mode T4 §10.3 rejects push to
avoid.

If the device is offline when the parent clicks: the UI must say so immediately and offer the
alternative in the same breath —

> ⚠️ *Lucy's Mac hasn't checked in for 14 minutes. This grant will apply when it reconnects.
> **To give her the time now, read her this code: 481 906.***

That sentence is where (a) and (b) become one feature rather than two.

### 6.3 Reconciling an offline code back to the server

1. On redemption the agent writes `override.grants.json`, then enqueues `override.redeemed`
   (`class: "audit"`). Offline, it queues on disk — T4 §7 gives ~29 days of headroom.
2. It also appears in `sync.override.active_grants[]` on **every** tick until it expires, so the
   server learns of it on the first successful tick even if the event queue is still draining.
3. On arrival the server matches `(key_id, day, minutes, seq)` against issued codes →
   marks it `redeemed`, or raises **`override.unmatched`** (§5.4 #1).
4. The parent's report shows `21:34 — +30 min override redeemed (code, offline)` instead of an
   unexplained gap in enforcement.

⚠️ **The server must NOT convert a redeemed offline grant into a `policy.overrides[]` entry.** By
reconciliation time it has usually expired, and re-issuing it would silently *extend* it. It is
**history**, recorded in the audit log and shown in reports — never fed back into desired state.
Combined with §4.7's union rule, this keeps the two mechanisms from fighting.

### 6.4 Build both. Ship (b) first.

| | (b) online grant | (a) offline code |
|---|---|---|
| New contract primitives | **none** — `policy.overrides[]` exists | one `desired[]` kind, one policy block |
| Agent work | merge + boundary recompute | prompt, HMAC verify, replay store, rate limit, reconcile |
| UI work | one button + duration picker | + offline card page |
| Depends on an unverified fact | no | ⚠️ **yes** — `CFUserNotification` text entry from a daemon (§1.8) |
| Estimate | **~1 day** | ~3–4 days |
| Covers the requirement | the ~95 % case (LAN up) | the case that destroys trust |

**Recommendation:** ship **(b) first** — it is a day's work, it delivers the owner's stated need for
the common case, and it **exercises `policy.overrides[]`, the boundary-recompute and the merge rule
end-to-end**, all of which (a) depends on. Then ship (a).

**But ship them in the same release train, and do not let (a) slip.** The offline case is rare and
is exactly the one that produces a *"this thing doesn't work"* judgement from both child and parent
in the same evening. A parental control is trusted or uninstalled; there is no middle state (T4 §8.2).

**Sequencing has a second, risk-shaped justification:** (a) rests on an empirical claim nobody in
this project has observed (§1.8). Building (b) first means ⚠️ V-T8.1 can be run in parallel, and a
negative result costs a redesign of the *prompt surface* only — not of the grant model.

---

## 7. T8.6 — Semantics

### 7.1 What a grant does

**A grant moves the start boundary of one named window later by N minutes, for one date.** It is not
a suspension and not a budget top-up.

```
type: "extend", window_id: "win_school_night", minutes: 30, effective_date: "2026-09-18"
→ tonight only, restricted_from 21:30 becomes 22:00. restricted_until (07:00) is UNCHANGED.
```

**Why not "suspend enforcement until timestamp T"?** Because an overshooting `T` would also disable
the **morning** boundary. "+30 minutes tonight" must not be able to mean "and no re-lock at 07:00".
Extending only the start boundary makes that unrepresentable — the same style of argument as T4-D26
(make the dangerous thing unexpressible in the schema, rather than forbidding it by discipline).

**Three types, all specified now so D.4 cannot reopen this design:**

| `type` | Meaning | `expires_at` clamp |
|---|---|---|
| `extend` | Start boundary +N min, one date. **The default; the only one an offline code can produce** | ≤ that window's `restricted_until` |
| `suspend` | No enforcement of this window tonight (sleepover). Rare, UI-only, separate confirmation | ≤ that window's `restricted_until` |
| `grant_minutes` | +N minutes to today's budget — **for D.4, if rules become budget-based** | ≤ end of the local day |

Note `grant_minutes` would meter against `active_s`, which T4-D27 already puts on the wire.

### 7.2 Granted **after** enforcement already fired — does the Mac unlock?

> **No. The Mac does not unlock, and this must be described to the parent in exactly those words.**

Three independent reasons, only one of which is a choice:

1. **[RESEARCHED]** Nothing third-party can draw or act over the lock screen (§2.1, Apple DTS).
2. **"Unlock" is not even the right verb.** `lock` is a screen lock the child clears with **her own
   password**. The enforcement is not the lock; it is the enforcer **re-locking every tick** while
   the predicate holds (T4-D13).
3. Under `action: "shutdown"` the Mac is **off**. Nothing helps.

**What actually happens, and it is good enough:** the grant moves the boundary, the predicate
evaluates to "outside window", **the enforcer stops re-locking**, and she logs back in herself. With
`attended` cadence that is **≤5 s**.

The parent UI must say:

> *"She'll be able to log back in within about 5 seconds. This won't wake the Mac for her."*

And §2.4's once-per-window grace prompt is what makes the **offline** version of this path work.

### 7.3 Stacking, revocation, caps

| Question | Answer |
|---|---|
| **Do grants stack?** | ✅ Yes, additively. Two +30s = +60 min. Capped by `max_minutes_per_day` (120) and `max_grants_per_day` (3), enforced **in the agent** so the caps survive offline |
| **Revoke early — online?** | ✅ Yes. Remove from `policy.overrides[]`; gone next tick. ⚠️ This **tightens** enforcement, so `confirm_immediate_effect` **does** apply (§6.1) |
| **Revoke early — an offline-redeemed grant, while still offline?** | ❌ No — there is no channel. It expires. This is correct and bounded: ≤60 min, `expires_at` mandatory. Once connectivity returns, revocation works normally |
| **Maximum single grant** | **60 min** (`allowed_minutes: [15, 30, 60]`) |
| **Per-day cap** | **120 min total, 3 grants** |
| **Hard ceiling** | `expires_at` is clamped to ≤ the affected window's `restricted_until`. **You cannot extend past morning.** Enforced on both ends |
| **`suspend` vs the cap** | `suspend` bypasses `max_minutes_per_day` by construction, so it is UI-only, never code-redeemable, and gets its own confirmation |

---

## 8. Failure matrix — the override path specifically

Complements T4 §11. "Bedtime still correct?" means the baseline schedule is enforced as written.

| # | Failure | Override works? | Bedtime still correct? | What the parent sees | Recovery |
|---|---|---|---|---|---|
| **1** | **Server down** (k3s/Postgres/LAN) at grant time | ⚠️ **(b) NO, (a) YES** — this is why (a) exists | ✅ Yes — cached policy enforces (O.1) | UI unreachable, or device card shows offline **and prints the code to read aloud** (§6.2) | Redemption reconciles on the next successful tick (§6.3) |
| **2** | Server down **after** an online grant landed | ✅ Grant already in the cached policy | ✅ Yes | `UNEXPECTED_SILENCE` + "still enforcing; +30 min grant active until 22:00" | Automatic |
| **3** | **Clock wrong** — skew < 5 min | ✅ Yes — 24 h bucket absorbs it | ✅ Yes | `clock.skew` audit event | Automatic on next sync |
| **4** | **Clock wrong** — set back 3 h at 21:29 to dodge bedtime | ✅ Yes — ±1 day window still matches | ✅ **Yes** — agent evaluates on `server_time + mach_continuous_time()` (T4 §8.4.3) | ⚠️ `clock.stepped` + `clock.untrusted` banner. **The evasion becomes a notification** | Automatic; tripwire raised |
| **5** | **Clock wrong** — offline for 8 days *and* reset, no trusted basis | ⚠️ Degraded: the ±1 day window may miss → code rejected | ✅ Yes — baseline still enforced | `override.rejected{reason:"no_match"}` + `clock.untrusted` | Parent can read a code for the *adjacent* day from the card's date picker (§3.6). Ugly but recoverable |
| **6** | **Code leaked** — child sees/overhears a code intended for later | ⚠️ She redeems it once, early | ✅ Yes — capped, expiring | `override.redeemed` at an odd hour; matches an issued code, so **no** `unmatched` alert. Visible in the report | Parent re-reads the timeline; `seq` means the next code is different |
| **7** | **Key stolen** — child reads `override.key`, mints her own | ❌ Cryptography does not stop her (§5.1) | ⚠️ Relaxed by up to the caps: **≤120 min/day** | ⭐ **`override.unmatched` alert** — "Lucy used a code you never issued" (§5.4 #1). This is the designed response | Rotate the key from the UI; reassess AR.1 (§5.5) |
| **8** | **Agent restarted mid-grant** (crash, `KeepAlive`, reboot) | ✅ Yes | ✅ Yes | nothing unusual | `override.grants.json` is on disk with `expires_at`; reloaded at start. **Grants survive restarts by construction** — they are state, not timers (T4-D6) |
| **9** | **Agent restarted between HMAC match and grant write** | ⚠️ Code is burned, grant lost | ✅ Yes | `override.redeemed` may be missing | The redeemed record is written **before** the grant applies (§4.6), so the failure costs the child a code and never the parent a duplicate. Parent reads the next `seq`. **Deliberate direction** |
| **10** | `launchctl asuser` fails / nobody at the console | ❌ No prompt can be shown | ✅ Yes | `override.prompt_failed` audit event | **A failed prompt is never a failed attempt** — the rate limiter is untouched (§1.5) |
| **11** | `CFUserNotification` does not render (§1.8 risk) | ❌ **(a) is dead** | ✅ Yes | `override.prompt_failed` every time | ⚠️ **No fallback surface exists.** This is why ⚠️ V-T8.1 is the top blocking test |
| **12** | Policy cache corrupt → fail-open (class C) | N/A — nothing to override | ⚠️ **Not enforcing**, loudly (T4 §8.2) | `agent.degraded` + banner | Next good policy |
| **13** | Key rotation races a redemption | ✅ Yes — 24 h dual-key overlap (§4.3) | ✅ Yes | nothing | By design |
| **14** | Child brute-forces the prompt | ❌ Locked out after 5 in 900 s | ✅ Yes — **lockout is never punitive** (§3.4) | `override.attempt_failed` ×N → tripwire banner | Auto-clears |
| **15** | Duplicate redemption (same code twice) | ❌ Rejected — replay store | ✅ Yes | `override.rejected{reason:"replay"}` | By design |
| **16** | Server reconciles a grant that has already expired | N/A | ✅ Yes | Report shows it as history | Server records history only, **never** re-issues (§6.3) |

---

## 9. Conflicts with T1–T7, stated rather than smoothed

### ⚠️ C1 — **T4 §10.5 must be withdrawn.** It designs the thing P1.5 forbids.

T4 §10.5 ("A product answer that removes most of the complaint") recommends:

> "The warning modal itself should carry an **'Ask for more time'** button. It writes a
> `request.extension` audit event, the parent's phone buzzes, the parent taps Grant…"

**That is a child→parent request flow.** The owner ruled it out the same day T4 was written:

> *"she doesn't need send request from her end since nothing UI from her end, she can just ask for
> approve personally"* — and `needs.md` P1.5 codifies it: *"The override is **parent-initiated
> only**. There is **no request flow from the child**."*

**Resolution:** delete the "Ask for more time" button and the `request.extension` event type.
Replace with T8.2's "Parent override" button, which sends nothing and requires a secret (§2.5).
**T4's H2/polling verdict is unaffected** — §10.5 was supporting colour, not load-bearing. The
argument *"perceived latency is dominated by the parent's thumb, not the poll interval"* still holds;
the ask is now in person, which makes it *more* true, not less.

This is a timing artefact, not an error of reasoning: P1.5 was added to `needs.md` on 2026-09-18,
the same day T4 was produced.

### ⚠️ C2 — **T3 §5.6's Tier-1 rationale contradicts AR.1**, and this matters for T8.4

T3 §5.6 says of the kill-switch file:

> "Root-only writable (`/var/db/...`), so **a non-admin child account cannot create it** — which is
> why this remains a parent's tool under AR.1."

But **AR.1 states the child has admin.** So Tier 1 is not a parent-only tool; it is a
**one-command total bypass available to the child**, with no cap, no expiry and no cryptography.

**Consequences:** (i) §5.2's conclusion — the override key is not the weakest link — is *founded on
this*; (ii) T3's Tier 1 needs hardening that costs ~10 lines: **alert on the file's appearance**
(not merely report it in the heartbeat), and **default it to time-boxed** rather than indefinite;
(iii) T3's Tier-1 paragraph should be corrected so a later reader does not inherit the wrong premise.

### ⚠️ C3 — **T4-D17 as written fires on every override grant**

`confirm_immediate_effect` is mandatory for any policy taking effect within 15 minutes (T3.5 blast
radius). **Every grant is by definition immediate.** As written, every grant pops a confirmation —
which trains the parent to click through it and **destroys the guard for the fat-fingered-bedtime
case it exists for.**

**Resolution (§6.1):** the guard applies to changes that make enforcement **stricter** sooner.
Relaxations are exempt. **Early revocation of a grant is a tightening and remains guarded.** This is
a refinement of T4-D17, not a repeal.

### ⚠️ C4 — **A new argument for D.3 (lock vs shutdown) that no prior track made**

> **A parent override granted at or after the boundary is only meaningful under `action: "lock"`.**
> Under `shutdown` the Mac is off: mechanism (b) cannot reach it, mechanism (a) has no screen to
> prompt on, and §2.4's grace prompt cannot exist.

T7 argued against `shutdown` because it destroys remote recovery; T4-D25 mitigated with
`shutdown_grace_s`. **T8 adds that `shutdown` also destroys the override feature itself** for the
late-grant case — which is the most common real case, since the child asks when she notices the
warning. This is an argument from *product function*, not from operability, and it points the same
way. **D.3 should resolve to `lock`.**

### ⚠️ C5 — **The whole T8.2 surface rests on an unverified mechanism**

T2's open test #3 ("Is `CFUserNotification` genuinely un-suppressed by Focus?") is still open, and
§1.8 adds an unanswered Apple forum report of `CFUserNotificationDisplayAlert` not rendering on
Big Sur. **This is the same evidence pattern T2 used to doubt `osascript display notification`** —
and T2 also flagged that POC 1 claimed to have *visually confirmed* banners on this same build one
day earlier. Two contradictory data points on the notification path, still unresolved.

T8 raises this from "worth checking" to **the top blocking test**, because unlike the warning path,
the override path has **no fallback surface** (§2.2 eliminates every alternative).

### ✅ No conflict — worth recording

- **T4-D6/D7/D18** (grants are state; mandatory `expires_at`; no stop verb): T8 uses all three
  unchanged. §4.7's union rule is an *addition*, not an exception.
- **T4 §4.6(b)**: `K_ovr` travels in `desired[]` precisely because that channel exists for intent
  that "carries a secret". No new mechanism.
- **T2's Swift recommendation**: unaffected. Text entry is plain C bridged into Swift (§1.6), and it
  needs no `.app` bundle — so it does not disturb the BTM/Mach-O constraint from T1/T3.
- **T4 §8.4.3** (trusted time basis): reused wholesale. T8 introduces **no new time machinery**.

---

## 10. Decisions register

| # | Decision | Rationale |
|---|---|---|
| T8-D1 | Text entry via `CFUserNotificationCreate` (dictionary), never `DisplayAlert` | `DisplayAlert` has no dictionary parameter — text fields are unreachable through it (§1.2) |
| T8-D2 | **Two-stage prompt**: a button on the warning, then a separate code dialog | Preserves the 3-button budget, keeps input off the nightly furniture, allows independent timeouts (§2.3) |
| T8-D3 | **Masking OFF** by default, though supported | The parent reads it aloud in person; masking causes typos that burn the rate limit and raise false tripwires (§1.7) |
| T8-D4 | Prompt also raised **once per window on first unlock after the lock fires**, with a 90 s grace | Otherwise the code the parent just gave has nowhere to be typed (§2.4) |
| T8-D5 | **No affordance that the child can invoke unprompted** | P0.3. Rules out hotkeys, menu items, CLI (§2.2) |
| T8-D6 | Offline code = **HMAC-SHA256 → RFC 4226 truncation → 6 digits**, over `(device, day, minutes, seq)` | Duration binding, single-use, 24 h clock tolerance, verbally transmissible (§3.3) |
| T8-D7 | **The duration is inside the code**; the agent infers it from which candidate matched | Nothing extra to type, and a 15-min code cannot be replayed as a 60-min one (§3.3) |
| T8-D8 | **Reject TOTP** | No duration binding; 30 s step is unusable verbally; worst clock story of any candidate (§3.2) |
| T8-D9 | Accept `day ± 1` | Covers the midnight straddle of a 21:30→07:00 window *exactly*, and ±24 h of skew, for 3× candidates (§3.7) |
| T8-D10 | **Lockout is never punitive** — it suspends the prompt only | A punitive lockout inverts T4 §8.2's harm asymmetry and hands the child a self-DoS (§3.4) |
| T8-D11 | `K_ovr` via `desired[]` kind `override_key`, 30-day rotation, 24 h dual-key overlap | T4 §4.6(b) exists for exactly this; mirrors T4-D11 and T3 §3.3 (§4.3) |
| T8-D12 | **Effective overrides = `policy.overrides[]` ∪ local grants** (union, never replace) | Otherwise a policy refresh silently cancels a just-redeemed offline grant — and only when the network recovers (§4.7) |
| T8-D13 | The server **never** re-issues a redeemed offline grant into `policy.overrides[]` | It has usually expired by reconciliation time; re-issuing would extend it (§6.3) |
| T8-D14 | **`override.unmatched` alert** is the primary defence against a stolen key | Makes misuse *visible* rather than prevented — the owner's stated philosophy (§5.4) |
| T8-D15 | Caps (60/120/3) enforced **in the agent**, not only the server | So they hold offline, which is the only case that matters (§7.3) |
| T8-D16 | The `asuser` helper **never holds `K_ovr`**; it returns the typed string to root over stdout | Puts the secret behind `sudo` instead of behind nothing (§1.5) |
| T8-D17 | A grant **extends the start boundary**; it never touches `restricted_until` | Makes "and no re-lock in the morning" unrepresentable — the T4-D26 style of guarantee (§7.1) |
| T8-D18 | A late grant **does not unlock the Mac**; the enforcer stops re-locking and she logs in | The only buildable behaviour (Apple DTS, §2.1), and honest to describe (§7.2) |
| T8-D19 | **Build both; ship (b) first**, same release train | (b) is ~1 day and de-risks (a); (a) depends on an unverified empirical fact (§6.4) |
| T8-D20 | The offline card is a **static HTML page saved to the parent's phone**, computing codes in WebCrypto | The parent UI is on the cluster that is down — a server-rendered code does not solve the problem (§3.6) |
| T8-D21 | **Reject scheme E** (hashed code list) for v1; document it as the upgrade path | ~10 chars of nightly friction to defeat an attacker who has a 1-command bypass = theatre (§3.5, §5.5) |
| T8-D22 | **Reject Secure Enclave** for `K_ovr` | SE is P-256-only (no HMAC), root can still *use* the key, and it needs entitlements an ad-hoc binary cannot have (§5.4) |

---

## 11. Open questions and things to verify

| # | Item | Blocks | Cost |
|---|---|---|---|
| ⚠️ **V-T8.1** | **Does `CFUserNotificationCreate` with `kCFUserNotificationTextFieldTitlesKey` actually render a usable field, from a root daemon via `launchctl asuser`, on macOS 26.6.2?** Confirm: field appears; `GetResponseValue` returns the typed text; 120 s timeout → `CancelResponse`; masking works. **Top blocking test.** Run with the owner present, in the child's session, once | **All of mechanism (a).** No fallback surface exists (§2.2, §1.8) | 15 min |
| ⚠️ V-T8.2 | Is the dialog genuinely un-suppressed by **Focus**? (= T2's open test #3, inherited) | Both warnings *and* override | 5 min |
| ⚠️ V-T8.3 | Does `kCFUserNotificationAlertTopMostKey` keep the dialog above a full-screen game? | Whether she can miss the prompt entirely | 5 min |
| ⚠️ V-T8.4 | Confirm the child's uid renders the dialog with **no TCC prompt** (T1 says notification-free paths need no grant, but this is a *window*) | Whether first use surprises her with a consent dialog | 5 min, same session |
| ⚠️ V-T8.5 | After an enforced lock, does an `asuser` prompt on first unlock appear **before** the next re-lock tick? | §2.4's grace prompt | 10 min |
| V-T8.6 | WebCrypto HMAC-SHA256 in Mobile Safari from a home-screen-saved file with no network | §3.6's offline card | 10 min |
| O-T8.1 | **Owner decision:** is `suspend` ("no bedtime tonight") wanted in v1, or `extend` only? | UI scope | — |
| O-T8.2 | **Owner decision:** are the caps (60 / 120 / 3) right for this family? | Defaults only; policy-configurable | — |
| O-T8.3 | Does the parent want the **offline card printed** as well as on the phone? | Runbook | — |

---

## 12. Sources

**Apple — primary (headers and documentation)**

- `CFUserNotification.h`, macOS **26.5** SDK — `/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk/System/Library/Frameworks/CoreFoundation.framework/Versions/A/Headers/CFUserNotification.h` **[VERIFIED — read today]**
- `CFUserNotification.h`, macOS **27.0** SDK — same path under `MacOSX27.0.sdk`; **byte-identical** to 26.5 **[VERIFIED — `diff` today]**
- `CFUserNotification` overview — <https://developer.apple.com/documentation/corefoundation/cfusernotification>
- `kCFUserNotificationTextFieldTitlesKey` (index range 0–7) — <https://developer.apple.com/documentation/corefoundation/kcfusernotificationtextfieldtitleskey>
- `kCFUserNotificationTextFieldValuesKey` — <https://developer.apple.com/documentation/corefoundation/kcfusernotificationtextfieldvalueskey>
- `CFUserNotificationSecureTextField(_:)` — <https://developer.apple.com/documentation/corefoundation/cfusernotificationsecuretextfield(_:)>
- CoreFoundation open source, `CFUserNotification.c` — <https://github.com/apple-opensource/CF/blob/master/CFUserNotification.c> · <https://opensource.apple.com/source/CF/CF-550/CFUserNotification.c.auto.html>

**Apple Developer Forums (DTS)**

- **Quinn — no third-party UI over the loginwindow/lock screen; only `SFAuthorizationPluginView`** — <https://developer.apple.com/forums/thread/654383> ⭐ decisive for §2.1
- DTS — `CFUserNotification` "works from launchd agents"; "less suitable for daemons" — <https://developer.apple.com/forums/thread/804854>
- ⚠️ Unanswered: `CFUserNotificationDisplayAlert` not showing on Big Sur — <https://developer.apple.com/forums/thread/682520>
- `launchctl asuser` unreliable at the fast-user-switching login window — <https://developer.apple.com/forums/thread/692749>
- `launchctl asuser` semantics — <https://ss64.com/mac/launchctl.html>

**IETF**

- **RFC 4226 — HOTP** (≥6 digits; dynamic truncation §5.3; throttling parameter `T` §7.3) — <https://www.rfc-editor.org/rfc/rfc4226.txt>
- **RFC 6238 — TOTP** — <https://www.rfc-editor.org/rfc/rfc6238>
- RFC 9457 — Problem Details (T4's error shape) — <https://www.rfc-editor.org/rfc/rfc9457.html>
- RFC 7515 / RFC 8037 — JWS / EdDSA (T4's policy signing) — <https://www.rfc-editor.org/rfc/rfc7515.html> · <https://www.rfc-editor.org/rfc/rfc8037.html>

**Prior art**

- Google Family Link — parent access code, locally generated, ~60-minute step — <https://support.google.com/families/answer/7307262?hl=en>
- Google Family Link overview — <https://en.wikipedia.org/wiki/Google_Family_Link>
- Apple Screen Time passcode as the thing that makes Downtime a block (via T7) — <https://support.apple.com/en-sg/guide/mac-help/mchl69510069/mac>

**This project**

- `research/needs.md` — P0.3, P0.4, P1.5, AR.1, D.3, D.4
- `research/poc2-findings.md` — §1 verdict, §3 track results, "boring to steal" (line 242)
- `research/raw/T4-contract.md` — §4.1, §4.4, §4.6, §6.7, §6.8, §8.2, §8.3, §8.4, §10, §11, §12
- `research/raw/T2-runtime-notifications-signing.md` — §"Constraint 2", §`CFUserNotification`, open test #3
- `research/raw/T3-lifecycle-operability.md` — §3.3 (secret layout, rotation), §5.6 (emergency override tiers), §5.7 (rate limiting)
- `research/raw/T7-prior-art-screentime.md` — `CGSession` staleness, Screen Time passcode, `mac-screentime-enforcer`

**Verified on this host today**

- `sw_vers` → macOS 26.6.2 (25G83), arm64
- `swiftc -version` → Apple Swift 6.3.3, `Target: arm64-apple-macosx26.0`; `swiftc -typecheck` of §1.6 → **OK** (no binary emitted, nothing executed)
- `/System/Library/CoreServices/UserNotificationCenter.app` present; process **running** (pid 85951)
- `/System/Library/LaunchAgents/com.apple.UserNotificationCenterAgent{,-LoginWindow}.plist` present; the latter has `LimitLoadToSessionType = "LoginWindow"`
- `stat -f %u /dev/console` → `501`

# T3 — Agent lifecycle and operability

**Track:** T3 (POC 2) · **Date:** 2026-09-18 · **Method:** 🌐 web research + ✏️ design synthesis
**Input:** [`requirements.md`](../../requirements.md) · [`poc2-plan.md`](../poc2-plan.md)
**Answers:** T3.1–T3.5 · **Feeds:** O.3 (Apple Developer account), O.1 (fail-open/closed), D.3 (shutdown vs lock)

**Evidence key used throughout:**

| Tag | Meaning |
|---|---|
| **[Proven]** | Documented vendor behaviour, or established macadmin practice with a citation |
| **[Verify]** | Believed true, but must be confirmed empirically on the M4 before it is built on |
| **[Synthesis]** | My design reasoning. Not sourced practice — argue with it |

---

## 0. Verdict first

**Build a signed, notarized `.pkg`, publish it to GitHub Releases from a `macos-26` GitHub
Actions runner, and have a small signed *supervisor* daemon on the Mac poll the control
plane for a pinned desired version and converge to it.** The pinned version lives as a
value in the existing GitOps repo, so Argo CD reconciles it into the control plane's
config exactly the way it reconciles a container tag. `git revert` is the rollback.

This is a self-updating agent — with the self-update hazard deliberately engineered down:

- The thing launchd starts is a **small, boring, rarely-changing supervisor**. It contains
  no enforcement logic. It is the only component whose failure is unrecoverable-in-place,
  and it is the component least likely to change.
- The thing that changes every release is the **agent payload**, installed into a
  versioned directory and activated by an atomic symlink flip. Rollback is a symlink
  flip, needs no installer, no network, and no server.
- The supervisor is also the **watchdog** and the **dead-man's switch**. It gets those
  for free by being a supervisor.

**Runner-up: Munki.** It is the genuinely proven answer to "manage Macs without MDM" and
I nearly recommended it. What flips it is in §1.6.

**Three things that will surprise you, up front:**

1. **macOS 26 has quietly made a paid Apple Developer account close to mandatory.**
   Background Task Management now gates LaunchDaemons whose *entry point* carries no
   developer signature — and it identifies the service by `ProgramArguments[0]`, so a
   plist that invokes `/bin/sh` or a bare script is seen as "Item from unidentified
   developer" and can be left disallowed after reboot. This resolves **O.3**: budget the
   $99/yr. **[Proven]** (§1.1)
2. **`.pkg` installers cannot downgrade.** Neither Munki nor `installer` will take you
   from 1.1.0 back to 1.0.0. Every pkg-centric rollback story in the wild is really
   "republish the old version under a higher version number", which is a lie you have to
   maintain forever. This is the single strongest argument for the versioned-directory +
   symlink layout, where rollback is not an install at all. **[Proven]** (§2.1)
3. **If enforcement is `shutdown`, you have no remote recovery path.** A machine that is
   off cannot be SSH'd into. The whole of §2 and §5 assumes the machine is reachable; that
   assumption only holds if the enforcement action is `lock`/`logout`, not `shutdown`.
   This is a hard operability argument feeding **D.3**. **[Synthesis]** (§5.6)

---

## 1. T3.1 — How does v1.1 actually reach the Mac mini?

### 1.0 The constraint that eliminates half the options

Two facts do most of the work here.

**Fact A — BTM now inspects the daemon's entry point. [Proven]**
As of macOS Sonoma 14.6.1 and continuing through Tahoe 26, Background Task Management
extended its scope from LaunchAgents to LaunchDaemons in `/Library/LaunchDaemons`. BTM
identifies a service by its entry point: *"When a plist invokes `/bin/sh -c "..."` rather
than calling a signed binary directly, BTM identifies the service by its entry point — it
sees `/bin/sh`, it sees no developer signature, and it treats it as an untrusted generic
shell script."* The symptoms are nasty because they are intermittent: the plist is present
and correct, `launchctl bootstrap` works by hand, and then it does not come back after a
reboot. System Settings shows a generic `sh` entry labelled *"Item from unidentified
developer"*.
Source: <https://mgaebler.me/en/blog/nix-macos-tahoe-btm-blocks-launchdaemons/>

This is corroborated independently on Apple's forums, where a LaunchDaemon calling a bash
script shows as unidentified and `AssociateBundleIdentifiers` is ignored *because bash has
no Team Identifier*: <https://developer.apple.com/forums/thread/755904>

The clean escape is a Developer-ID-signed compiled binary as `ProgramArguments[0]`. BTM
then has a stable Team Identifier to match on — the same identifier MDM's ServiceManagement
payload matches against, which Apple documents as needing to be *"an exact match"*:
<https://support.apple.com/guide/deployment/manage-login-items-background-tasks-mac-depdca572563/web>

> **[Verify] — T1-adjacent empirical check.** The exact *default disposition* of a
> pkg-installed, Developer-ID-signed LaunchDaemon on macOS 26 (auto-approved vs.
> approved-on-first-admin-consent) is not clearly documented anywhere I could find, and
> the one Apple deployment page that would settle it only covers the MDM path. Check it on
> the M4 with `sudo sfltool dumpbtm` (or <https://github.com/objective-see/DumpBTM>) and
> look at the `Disposition` field, before and after a reboot. Budget for a one-time
> approval in System Settings → General → Login Items & Extensions → *Allow in the
> Background* at install; that toggle writes the BTM disposition and persists across
> reboots, and install is an attended operation so a one-time click is acceptable. What is
> *not* acceptable is needing it again on every update — which is precisely why the
> launchd entry point must be a stable, stably-signed binary (§6.1).

**Fact B — MDM is de-scoped (`needs.md` §5).** So every mechanism that leans on a
configuration profile for auto-approval is out. We have to be well-behaved rather than
privileged.

### 1.1 Signed `.pkg` — delivered how?

The `.pkg` is not really a *delivery* mechanism, it is a *payload format*. The interesting
question is always what fetches it. But the format itself is the right one: reach for
`.pkg` when the product installs daemons, because a pkg runs as root and has pre/postinstall
scripts.

Proven structure (Armin Briegel / scriptingosx, the standard macadmin reference):

```
payload/usr/local/bin/your-daemon                       # mode 755
payload/Library/LaunchDaemons/com.example.daemon.plist  # root-owned, mode 644
scripts/preinstall    # launchctl bootout of the running service
scripts/postinstall   # launchctl bootstrap system/ "$launchdPlist"
```

```sh
pkgbuild --root payload/ --scripts scripts/ --version 1 \
         --identifier com.example.daemon --install-location / Daemon-1.pkg
```

Gotchas Briegel calls out explicitly: plists in `/Library/LaunchDaemons` **must** be
root-owned and not group/other-writable (mode 644) or you get
`Load/Bootstrap failed: 5: Input/output error`; the binary must not carry a quarantine
xattr; and a preinstall should `launchctl bootout` the existing service before an upgrade.
Source: <https://scriptingosx.com/2024/07/building-a-launchd-installer-pkg-for-desktoppr-and-other-tools/>

**Root-owned files:** solved natively. The installer runs as root, so `/usr/local/**` and
`/Library/LaunchDaemons/**` are written with correct ownership without any extra
privilege dance. `/usr/local` is not SIP-protected, so root may write it freely.

**Admin password:** this is the pivot. Double-clicking the pkg prompts. But
`/usr/sbin/installer -pkg X.pkg -target /` invoked *by a process that is already root*
prompts for nothing. So a pkg is unattendable **if and only if** something already-root
fetches and installs it. That something is either Munki, or your own supervisor daemon, or
an SSH-in-as-root push.

**Code signing interaction — and a trap.** *"When you install software using the
`installer` command from the Terminal or a script, it will bypass quarantine and the
Gatekeeper check."*
(<https://scriptingosx.com/2019/10/notarization-for-macadmins/>) That is convenient and
also dangerous: **the OS will not check the signature for you on the unattended path.**
Anything that downloads a pkg and shells out to `installer` must verify the package
itself, before installing:

```sh
pkgutil --check-signature /tmp/hpc-agent-1.1.0.pkg     # Developer ID Installer + notarised
shasum -a 256 /tmp/hpc-agent-1.1.0.pkg                  # must equal the pinned digest
```

`pkgutil --check-signature` reports signing status, notarization status, timestamp and the
full certificate chain, and — usefully for a daemon — has no dependency on Xcode or the
Command Line Tools; it ships with macOS.
Source: <https://derflounder.wordpress.com/2023/01/20/verifying-installer-package-signing-and-notarization-using-pkgutil/>

> Note a live bug: `spctl --type install` has been reported rejecting correctly notarized
> packages on macOS 26.3 (<https://developer.apple.com/forums/thread/817887>). Prefer
> `pkgutil --check-signature` plus a pinned SHA-256 as the gate, and treat `spctl` as
> advisory. **[Proven — bug report]**

### 1.2 Homebrew tap

**Verdict: disqualified, and not merely on ergonomics.**

- **It refuses to be unattended.** `brew upgrade` will pause and prompt for a sudo password
  when a formula needs elevation, blocking the whole run — often long after the operator
  has walked away. There is no supported "upgrade everything you can without prompting"
  mode.
  Sources: <https://github.com/Homebrew/brew/issues/3428>,
  <https://github.com/homebrew/brew/issues/20338>,
  <https://github.com/orgs/Homebrew/discussions/3199>
- **It refuses to run as root at all**, which is the one thing our installer must be.
  <https://docs.brew.sh/FAQ>
- **It is a local privilege escalation in this shape. [Synthesis, but the mechanism is
  plain]** On Apple Silicon `/opt/homebrew` is owned by the installing admin user, not
  root. Putting a binary that *root executes every 60 seconds* into a directory that a
  non-root account can write is handing any admin-account compromise a root shell. You
  would have to copy the binary out of the Cellar into a root-owned path after every
  upgrade, at which point Homebrew is doing nothing for you.
- `sudo brew services` exists to install launchd *daemons*, but Homebrew's own guidance
  flags the security implications, and it does not solve either point above.

A private tap is a fine way to distribute a *developer CLI*. It is the wrong tool for a
root daemon on an unattended machine.

### 1.3 Self-updating agent

**Verdict: recommended — with the hazard engineered down, not waved away.**

This is genuine production practice, not a hobbyist shortcut. Chrome's Keystone /
GoogleUpdater is exactly this: a root LaunchDaemon that wakes roughly hourly and updates
the product beneath it (<https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/updater/mac/>).
Tailscale ships client auto-update in its standalone (non-App-Store) macOS variant, chosen
precisely because it gives more deployment control than the App Store build
(<https://tailscale.com/blog/standalone-macos>, <https://tailscale.com/docs/features/client/update>).
The open-source `tailscaled install-system-daemon` lays a binary in `/usr/local/bin` and a
plist in `/Library/LaunchDaemons` — the same shape proposed here
(<https://github.com/tailscale/tailscale/wiki/Tailscaled-on-macOS>).

**And the hazard is real, with receipts.** Keystone is a cautionary tale in both
directions: it has carried privilege-escalation vulnerabilities
(<https://issues.chromium.org/issues/40075849>,
<https://issues.chromium.org/issues/520494861>) and it once removed the `/var` symlink on
non-SIP Macs, causing boot failures
(<https://mrmacintosh.com/google-chrome-keystone-is-modifying-var-symlink-on-non-sip-macs-causing-boot-issues/>).
A root updater that gets it wrong does not fail politely; it bricks machines.

The mitigations that make this acceptable are the whole of §2 and §6, but the load-bearing
one is structural: **the self-updater must not be the thing being updated.** Split the
launchd entry point (rarely changes) from the payload (changes every release).

**Root-owned files:** native — the updater is already root.
**Admin password:** never, after install.
**Code signing:** the updater must do its own verification (§1.1), because the unattended
`installer` path skips Gatekeeper.

**Sparkle is not the answer here. [Proven]** Sparkle is a GUI-app framework; macOS does
not properly support running GUI applications as root, and the maintainers' own guidance
for daemons is to hand Sparkle a `.pkg` and do the install/restart logic yourself — at
which point Sparkle is contributing an appcast parser and a UI you cannot show.
<https://github.com/sparkle-project/Sparkle/discussions/2423>

### 1.4 Config management (Ansible et al.)

**Verdict: disproportionate in push mode; the pull-mode variant is a worse version of what
I am recommending anyway.**

- **Push mode** (`ansible-playbook` from the k3s box over SSH) needs either root SSH or
  passwordless sudo on the Mac — a standing credential on the control plane that grants
  root on the child's machine, with no rate limit and no audit trail beyond SSH logs. It
  also only converges when *you* run it, so the Mac's state is undefined between runs, and
  a laptop that is asleep at 03:00 simply misses the window. For one machine the
  inventory, vault, and role scaffolding is pure overhead.
- **Pull mode** (`ansible-pull` from a git repo on a cron/launchd timer) is architecturally
  the right idea — it *is* the "device reconciles toward git" pattern — but it drags a
  Python runtime and the whole Ansible dependency tree onto a machine whose entire job is
  to run one small daemon, and it reintroduces Fact A: the launchd entry point becomes
  `python3`/`sh`, not a signed binary.

Keep Ansible (or a shell script) for the **one-time enrolment** of a new Mac if you ever
get a second child. Do not put it in the steady-state update path.

### 1.5 Munki — the real "fleet of Macs without MDM" answer

This is the proven prior art for exactly the stated problem, and it deserves a fair
hearing rather than a dismissal.

**What it is. [Proven]** Munki's client `managedsoftwareupdate` runs from a LaunchDaemon
roughly hourly (triggered at ten past the hour), reads manifests and catalogs over plain
HTTP(S) from a repo, compares desired versions against installed versions, and downloads
and installs what is needed as root. *"The server isn't performing any operation or logic
besides serving items requested over http(s)."* A separate
`managedsoftwareupdate-install` LaunchDaemon provides the root context for system-wide
installs.
Sources: <https://www.munki.org/munki/>,
<https://github.com/munki/munki/wiki/managedsoftwareupdate>,
<https://github.com/munki/munki/wiki/Launchd-Jobs-and-Changing-When-Munki-Runs>

That description should sound familiar: **it is a reconciliation loop against a
declarative desired state served from a dumb static store.** Munki is, structurally,
Argo CD for Macs. It predates the term.

**It is current.** Munki 7 is a full Swift rewrite that dropped Python entirely; build
7.1.1 was compiled on macOS 26.3 and supports 10.15 through 26.
Source: <https://stabilise.io/blog/is-munki-still-relevant-2026>

**It has a real GitOps story.** Keeping the Munki repo in git and building it with AutoPkg
in GitHub Actions is established practice — Gusto has run AutoPkg on GitHub Actions in
production since 2019, explicitly to make the infrastructure version-controlled and
auditable, and it let them retire a physical Mac.
Sources: <https://engineering.gusto.com/running-autopkg-in-github-actions-e9e377f19fe1>,
<https://grahamrpugh.com/2015/12/07/version-control-munki-autopkg.html>,
<https://github.com/joncrain/automunki>

**Its version pinning.** You pin by appending the version to the item name in a manifest's
`managed_installs` — `Firefox-123.0`, or `Firefox--125.0-RC` when the version itself
contains a dash. <https://github.com/munki/munki/wiki/Manifests>

**And its disqualifying limitation. [Proven]** *"Munki generally will not downgrade an
existing install from a newer version to an older version, so specifying an older version
in the managed_installs list will not downgrade existing installations. Munki does not
support downgrades, largely because most Installer packages do not."* The documented
workarounds are to pull the newer version out of the repo, hand-craft
`installs`/md5checksum arrays so Munki mis-detects the installed version, or maintain
parallel catalogs.
Sources: <https://github.com/munki/munki/wiki/Downgrading-Software>,
<https://www.alansiu.net/2020/12/22/rolling-back-versions-in-munki-and-using-blocking-applications-arrays/>,
<https://managingosx.wordpress.com/2018/03/15/using-munki-to-revert-or-downgrade-software/>

Rollback is the second of the four things `needs.md` P3.2 demands ("observable, versioned,
updatable, rollback-able"). A mechanism whose rollback story is "lie about the version
number" fails the brief at the exact point the brief is most explicit.

### 1.6 Comparison table

| Mechanism | Unattended? | Signing needs | Rollback story | Complexity | Fit |
|---|---|---|---|---|---|
| **Manual signed `.pkg`** (download + double-click) | ❌ No — GUI + admin password every time | Developer ID Installer + notarize + staple | Manual: keep old pkgs, reinstall by hand; **no downgrade** | Low | ❌ Fails "unattended". Keep as the break-glass path only |
| **`.pkg` + Munki** | ✅ Yes — hourly root LaunchDaemon, HTTPS repo | Developer ID Installer + notarize (Munki installs via `installer`, so verify yourself) | ⚠️ **Documented as unsupported.** Workarounds are repo surgery | Med-High — repo, catalogs, manifests, AutoPkg, webserver | 🥈 Runner-up. Genuinely proven; loses on rollback and on weight at n=1 |
| **Homebrew tap** | ❌ No — blocks on sudo prompts; `brew` refuses root | Homebrew does not require or verify Developer ID | `brew pin` / reinstall old formula; messy | Low | ❌ Disqualified. Also a privesc: `/opt/homebrew` is user-writable (§1.2) |
| **Self-updating agent** (supervisor polls, verifies, installs pkg) | ✅ Yes — already root, zero prompts | Developer ID Application (BTM entry point) + Developer ID Installer + notarize; **must self-verify** | ✅ Best available: symlink flip to previous version, local, offline, instant | Med — you write the supervisor (~300 lines) | ✅ **Recommended.** Only option that satisfies all four of P3.2 |
| **Ansible push (SSH)** | ⚠️ Only with standing root SSH / passwordless sudo | None enforced | Re-run playbook with older version var; still a pkg install → **no downgrade** | Med — plus a root credential aimed at the child's Mac | ❌ Disproportionate at n=1; new standing privilege |
| **`ansible-pull` + launchd timer** | ✅ Yes | None enforced | Same as above | Med-High — Python runtime on the target | ❌ Right idea, wrong weight; breaks Fact A (entry point = `python3`) |
| **MDM / DDM** | ✅ Yes, and auto-approves BTM | Developer ID Installer, signed distribution pkg | Depends on MDM | High + cost | ❌ De-scoped (`needs.md` §5, AR.1) |
| **Sparkle** | ❌ No — GUI framework, root GUI unsupported | Developer ID + EdDSA appcast signature | Sparkle has no daemon rollback story | Med | ❌ Wrong tool (§1.3) |
| **`git pull` + shell script on a timer** | ✅ Yes | None — and that's the problem | `git checkout <old-sha>` | Very low | ❌ Breaks Fact A. This is literally "a script in a folder" |

---

## 2. T3.2 — Rollback

### 2.1 The constraint everyone discovers too late

**Installers do not go backwards. [Proven]** Munki documents it plainly — *"Munki does not
support downgrades, largely because most Installer packages do not"* — and the underlying
reason is general to `.pkg`: a component package's version is used for "is this already
installed / newer?" decisions, and receipts accumulate rather than revert.
<https://github.com/munki/munki/wiki/Downgrading-Software>

So any design where **rollback == running an installer** has a rollback story that is
either broken or built on version-number fraud. The way out is to make rollback *not an
install*.

### 2.2 The pattern that actually works: versioned directory + atomic symlink

Proven and old. Capistrano/Deployer have shipped it for two decades: *"Each deploy unpacks
code into a brand new numbered directory under `releases/`, prepares it, and only at the
very end repoints `current` to the new directory. Old releases stick around for a few
generations so you can roll back without redeploying."* The atomicity comes from the
kernel: on a single filesystem, replacing a symlink via `rename(2)` (`ln -sfn` into a temp
name then `mv -T`) is indivisible — there is no instant at which `current` does not exist.
Sources: <https://deployer.org/blog/atomic-symlinks>,
<https://blog.moertel.com/posts/2005-08-22-how-to-change-symlinks-atomically.html>,
<https://temochka.com/blog/posts/2017/02/17/atomic-symlinks.html>

The same pattern is now standard for self-updating agents: stage versions under a
`versions/` directory and flip a symlink, *"so a bad download never becomes live"*; copy
the current binary to a sibling backup before the swap and atomically restore it if the
re-exec fails, *"so the on-disk agent is always left runnable."*

Applied here:

```
/usr/local/homeparentcontrol/
├── versions/
│   ├── 1.0.3/bin/hpc-agent          ← previous known-good, retained
│   ├── 1.1.0/bin/hpc-agent          ← newly installed
│   └── 1.1.1/bin/hpc-agent          ← current
├── current     -> versions/1.1.1    ← atomic symlink
└── last-good   -> versions/1.0.3    ← only ever advanced after a soak (§2.4)
```

The `.pkg` therefore installs *into `versions/<v>/`* and its postinstall flips `current`.
Rollback never runs the installer at all — it is `mv -T` plus `launchctl kickstart -k`.
Retain the last 3 versions; that is a few MB.

### 2.3 Three layers of undo, in increasing order of "how bad is it"

**[Synthesis]** — the layering is mine; each layer's mechanism is sourced.

**Layer 1 — Automatic, local, no network: crash-loop rollback.**
The supervisor starts `current`. If the payload exits non-zero **N=3 times inside 5
minutes**, the supervisor flips `current` back to `last-good`, restarts, and records the
bad version in a local `quarantine` file so it will not be reinstalled even if the server
still asks for it. This requires no server, no network, and no human. It is the layer that
saves you when the control plane is also down.

**Layer 2 — Automatic, local, no network: unhealthy rollback.**
Crashing is the easy failure. The POC's bugs did not crash — they were wrong. So the
payload must write a heartbeat (`{ts, version, tick_seq, last_decision}`) every tick, and
the supervisor must roll back on *staleness* as well as on exit code: no heartbeat advance
for 5 minutes ⇒ same rollback path as Layer 1, plus enforcement disabled (§5.3).

**Layer 3 — Deliberate, from the server: version pin.**
The desired-state document served by the control plane carries an explicit version, not
"latest". Setting it back to `1.0.3` is a normal convergence, and because the old version
is still on disk under `versions/`, convergence is a symlink flip, not a download. Median
rollback time = one poll interval. In GitOps terms this is `git revert` (§4.3).

### 2.4 `last-good` is earned, not assumed

**[Synthesis]** The trap in every "known-good fallback" design is promoting the new version
to known-good the moment it starts. A version that starts cleanly and then makes wrong
enforcement decisions gets promoted, and then there is nothing to fall back to.

So: `last-good` only advances when the new version has completed a **soak** — see §5.4 for
the definition, because at n=1 the soak *is* the staged rollout.

### 2.5 "…and the machine is in a child's bedroom, possibly locked out by the agent"

This is the part of the question most designs skip. Ranked by whether it survives the
machine being hostile:

| # | Recovery path | Works when… | Requires |
|---|---|---|---|
| 0 | **Automatic rollback** (Layers 1–2) | Always, including offline | Nothing. This is why Layers 1–2 exist |
| 1 | **Kill-switch file** — `touch /var/db/homeparentcontrol/DISABLE` | Machine is on and you can reach a shell | SSH, or 20 seconds in the bedroom |
| 2 | **SSH + `launchctl bootout system/com.homeparentcontrol.supervisor`** | Machine is on, network up, SSH not blocked | Remote Login enabled and *never* gated by the agent |
| 3 | **Server-side pin revert** | Agent still healthy enough to poll | Control plane reachable |
| 4 | **Physical** — power cycle, or log in as the admin account | Always | Being in the room |

**Two hard rules fall out of this table. [Synthesis]**

- **The agent must never be able to disable Remote Login, block port 22, or lock out the
  parent's admin account.** Path 2 is the workhorse recovery and it must be outside the
  agent's blast radius by construction — not by the agent choosing to be nice.
- **If the enforcement action is `shutdown`, paths 1–3 all evaporate.** You cannot SSH into
  an off machine. That is a real argument for `lock`/`logout` as the default (feeding
  **D.3**), or, if `shutdown` wins on other grounds, for enabling Wake-on-LAN and accepting
  that recovery may require walking upstairs.

---

## 3. T3.3 — Config and secret delivery

### 3.1 Can a root LaunchDaemon reach the keychain without a GUI unlock?

**Yes, the System keychain — and no, not the login keychain, and not the modern one. [Proven]**

- *"Programs that run outside of a user context, like a launchd daemon, must target the
  file-based keychain. The data protection keychain is only available to programs running
  in a user context, like an app or an app extension."*
  <https://developer.apple.com/forums/thread/759976>,
  <https://support.apple.com/guide/security/keychain-data-protection-secb0694df1a/web>
- The System keychain (`/Library/Keychains/System.keychain`) *is* reachable from a daemon,
  and is unlocked at boot without any GUI session. But it is writable only by root: *"If
  you run a daemon as root, you can store and retrieve the password in the system keychain,
  but if you create a dedicated user/group for the daemon… adding the password to the
  keychain fails with -61 (errSecWrPerm)."*
  <https://developer.apple.com/forums/thread/657874>
- The login keychain is unavailable outside the per-user security context — so it is not an
  option for a daemon that must work before and independent of anyone logging in.

So the mechanism works. The question is whether it is worth it.

### 3.2 Why I am *not* recommending the keychain

**[Synthesis], resting on proven facts:**

1. **The security delta over a 0600 root-owned file is approximately zero here.** From the
   same Apple forum thread on daemon secret storage: with the System keychain *"anyone with
   admin credentials can open and read the item, not just the currently logging in user."*
   A file at `0600 root:wheel` has exactly the same property — an admin with `sudo` reads
   it. You pay real complexity for no change in who can read the secret.
   <https://developer.apple.com/forums/thread/725855>
2. **Apple is not enthusiastic and is not investing.** In that thread Quinn's answer is
   essentially *"there's no single definition of 'secure'. There's only 'secure enough',
   where you get to decide what's 'enough'"*, notes that authorization plugins are
   *"definitely old school"*, and points at Local Authentication as *"the direction we're
   heading"* — which is a user-presence framework and therefore useless to a headless
   daemon. The file-based `SecKeychain*` API a daemon must use is the deprecated one.
3. **It is hostile to operations.** A secret in a keychain cannot be diffed, cannot be
   inspected without `security` incantations, does not appear in a backup you can reason
   about, and turns "what credential is this box using?" into a debugging session. For a
   system whose stated goal is *operability*, that is a real cost.
4. **The threat model does not ask for it.** AR.1 states the child is not capable of
   stopping a terminal app. Nobody with a keychain-cracking capability is in this picture.

Where the keychain *would* win — and this is the honest counter-argument — is if the
credential had to survive a full-disk backup being restored elsewhere, or if you wanted ACLs
binding the item to a specific signed binary. Neither is in scope.

### 3.3 Recommended: a short-lived credential in a root-owned file, plus enrolment exchange

**[Synthesis]** The important move is not *where* the secret sits. It is making the
at-rest secret **short-lived and self-renewing**, so that its at-rest security matters less.

```
/usr/local/etc/homeparentcontrol/
├── config.json         0644 root:wheel   # NOT secret: server URL, poll interval, device id
├── credential.json     0600 root:wheel   # agent token + refresh token + expiry
└── enrolment.token     0600 root:wheel   # one-time, deleted on first successful exchange
```

- **Config is not a secret.** The control-plane URL, poll interval, log level and device
  identifier go in a world-readable `config.json`, shipped by the pkg with defaults and
  overridable in place. Treating a hostname as a secret is how people end up unable to
  debug their own system.
- **Policy is never in a file you edit.** Rules come from the control plane each poll and
  are cached locally at `/var/db/homeparentcontrol/policy.cache.json` for offline operation.
  The cache is data, not configuration.
- **Bootstrap:** installation carries a **one-time enrolment token**, valid for e.g. 24
  hours and single-use, generated by the parent UI when they click "add a device". On first
  run the agent POSTs it to `/api/v1/agent/enrol` along with its hardware UUID, receives a
  long-lived-but-rotatable agent credential, writes it `0600`, and **deletes
  `enrolment.token`**. The high-value secret therefore never sits on the disk of the child's
  machine at all, and the pkg itself contains no credential — so the pkg is safe to publish
  on a public GitHub Release.
- **Rotation:** the credential carries an expiry (30 days). On every poll, if the expiry is
  within 7 days, the agent calls `/api/v1/agent/rotate`, writes the new credential to a temp
  file in the same directory and `rename(2)`s it over the old one (atomic — the same trick
  as §2.2, so there is no window where the file is half-written). Server accepts the old
  credential for a 24-hour overlap so a rotation that races a reboot cannot lock the agent
  out. If rotation fails, the agent keeps using the current credential and logs a warning;
  it does not fail enforcement over it.
- **Revocation:** parent UI marks the device revoked → next poll returns 401 → agent
  wipes `credential.json`, **disables enforcement** (fail-open, §5.3), and waits for
  re-enrolment. Revoking must never leave a child locked out by a machine that can no
  longer be told to stop.
- **FileVault** gives you the at-rest encryption story for all of the above for free, and
  should be on regardless. Note it on the install checklist.

### 3.4 The analogy to Sealed Secrets, stated honestly

Sealed Secrets works because the cluster holds a private key that only it can use, so
ciphertext is safe in git. There is **no equivalent on macOS for a headless daemon** — the
Secure Enclave can hold a key, but binding it usefully requires user presence, which is
exactly what a daemon does not have. **[Synthesis]** So do not try to reproduce Sealed
Secrets. The enrolment-token-plus-rotation design above is the honest substitute: instead of
making the at-rest secret unbreakable, make it cheap to lose. The GitOps repo holds the
*desired version* and *policy*, which are not secret; it never holds an agent credential.

---

## 4. T3.4 — What does "release" mean for a non-container artefact?

### 4.1 The build pipeline

**[Proven tooling, standard shape]**

`macos-26` is generally available for GitHub-hosted runners as of 2026-02-26, running
natively on Apple Silicon (arm64), with `macos-26`, `macos-26-intel`, `macos-26-large` and
`macos-26-xlarge` labels.
Sources: <https://github.blog/changelog/2026-02-26-macos-26-is-now-generally-available-for-github-hosted-runners/>,
<https://docs.github.com/en/actions/reference/runners/github-hosted-runners>

So no self-hosted Mac runner is needed — which matters, because the alternative is *"a
standing cost and bottleneck… provisioning, patching and holding signing keys on the
machine."* `pkgbuild`, `productbuild`, `productsign`, `notarytool` and `stapler` are
macOS-only, so the job must run on a macOS runner.

```
on: push tags v*
jobs:
  release:  runs-on: macos-26
    1. build          swift build -c release --arch arm64   (or go build)
    2. codesign       --sign "Developer ID Application: …" --options runtime --timestamp
                      # inside-out: sign the agent payload BEFORE the enclosing container
    3. pkgbuild       --root payload/ --scripts scripts/ --version ${TAG} \
                      --identifier com.homeparentcontrol.agent --install-location /
    4. productbuild   --distribution … --package-path …      # signed distribution pkg
    5. productsign    --sign "Developer ID Installer: …"
    6. notarytool     submit --wait --key … --key-id … --issuer …   # App Store Connect API key
    7. stapler        staple hpc-agent-${TAG}.pkg
    8. verify         pkgutil --check-signature   (fail the build if not "Notarized")
    9. publish        gh release create — pkg + manifest.json + SHA256SUMS
```

Two details worth pinning down now:

- **Sign inside-out.** The embedded agent executable is signed before the enclosing
  container, with Developer ID, a secure timestamp, and hardened runtime enabled — Apple's
  required order for notarization. **[Proven]**
- **Authenticate to notarytool with an App Store Connect API key (`.p8`), not an
  app-specific password.** *"No per-user password, rotatable centrally, and it survives
  team turnover."* Store the `.p8`, key ID and issuer ID as GitHub Actions secrets; import
  the Developer ID certs into a temporary keychain created and destroyed inside the job.
  **[Proven, standard practice]**
  <https://developer.apple.com/forums/thread/121113> confirms the prerequisite: notarization
  requires paid Apple Developer Program membership ($99/yr,
  <https://developer.apple.com/programs/>). Self-signed and ad-hoc identities cannot notarize.

### 4.2 Where artefacts live: GitHub Releases

Yes — GitHub Releases, and it is the right answer rather than a fallback.

- It is the accepted home for signed macOS installers and it is what the `gh` CLI, and
  therefore CI, targets natively.
- It is immutable per tag, gives you a stable download URL, and its asset list doubles as
  your version history.
- It is reachable from the Mac without VPN or cluster credentials, which matters for
  break-glass: you can always download and hand-install the previous pkg.
- GHCR and GitHub Releases are the same account and the same permissions model, so nothing
  new is introduced alongside the existing chain.

Publish alongside the pkg a tiny **`manifest.json`** — the pkg's own metadata, hoisted to
where a daemon can read it without downloading 20 MB:

```json
{
  "version": "1.1.0",
  "pkg_url": "https://github.com/<owner>/homeparentcontrol/releases/download/v1.1.0/hpc-agent-1.1.0.pkg",
  "sha256": "…",
  "min_macos": "26.0",
  "supervisor_version": "1.0.0",
  "released_at": "2026-09-18T00:00:00Z"
}
```

> **Alternative if you would rather not depend on github.com at enforcement time:** mirror
> the pkg into the cluster and serve it from the control plane. The supervisor then only
> ever talks to one host. I would not start there — the extra hop is a second thing that can
> be stale — but it is a clean second step if the LAN-only posture (AR.2) hardens.

### 4.3 The GitOps story — and it is a real one

**This is the answer to "is there a sane GitOps-flavoured story for a Mac agent?": yes, and
it is almost exactly the shape already in use.**

```
  ┌────────────────────────── GitHub ──────────────────────────┐
  │  homeparentcontrol (app repo)                              │
  │    tag v1.1.0 ──► Actions on macos-26 ──► signed+notarized │
  │                                           .pkg + manifest  │
  │                                                │           │
  │                                         GitHub Releases    │
  │                                                            │
  │  home-gitops (GitOps repo)  ← THE SOURCE OF TRUTH          │
  │    apps/homeparentcontrol/values.yaml                      │
  │      controlPlane.image.tag: v1.1.0    ← same gesture      │
  │      agent.desiredVersion:    1.1.0    ← as today          │
  │      agent.enforcementEnabled: true                        │
  └──────────────────────┬─────────────────────────────────────┘
                         │ Argo CD reconciles
                         ▼
            ┌────────────────────────────┐
            │ k3s — control plane        │
            │  ConfigMap: desired state  │
            │  GET /api/v1/agent/desired │
            └──────────┬─────────────────┘
                       │ HTTPS poll, every 5 min, agent-initiated (H2)
                       ▼
            ┌────────────────────────────┐
            │ Mac mini — supervisor      │
            │  reconciles actual→desired │
            └────────────────────────────┘
```

**Why this is not GitOps cosplay. [Synthesis, but the claim is structural]** GitOps is three
properties: declarative desired state, version-controlled and auditable, with an agent that
continuously reconciles actual toward desired. All three hold here. Argo CD reconciles
git → cluster; the supervisor reconciles cluster → device. The chain is unbroken, the audit
trail is `git log`, and rollback is `git revert` for the Mac exactly as it is for the
cluster. Munki independently arrived at the same architecture for Macs years before the
term existed (§1.5) — which is decent evidence the shape is right rather than fashionable.

**One line bumps both halves of the system.** That is the answer to "without being
embarrassing next to it".

### 4.4 Observability — closing the third of P3.2's four words

**Grafana Alloy runs on macOS as a launchd service. [Proven]**
<https://grafana.com/docs/grafana-cloud/observe-and-act/send-data/alloy/set-up/run/macos/>,
<https://grafana.com/docs/alloy/latest/tutorials/send-logs-to-loki/>
(Promtail is feature-complete; Alloy is where log-collection development continues, so start
on Alloy.)

But **[Synthesis]** I would *not* install Alloy for this. Two reasons: it is a second
unattended-update problem on the same machine (and it is Homebrew-installed by default,
which §1.2 just disqualified), and the agent already has an authenticated HTTPS channel to
the control plane. Have the agent emit structured JSON logs to stdout, let launchd capture
them to `/var/log/homeparentcontrol/agent.log`, ship them in the existing poll body as a
bounded batch, and let the control plane — which is already a `home*` app inside the
cluster — forward them to Loki. One channel, one credential, one thing to keep updated, and
store-and-forward for free when the network is down (T4.3).

Revisit if you ever want host-level metrics (disk, CPU, uptime) that the agent has no
business collecting. That is when a real telemetry agent earns its keep. This is T6's call,
not mine.

---

## 5. T3.5 — Blast radius

> **The weighting.** POC 1 found *both* of its bugs in the enforcement path, and the
> dry-run suite caught *neither*; they surfaced only under live repeated ticking. The
> correct inference is not "write better dry-run tests". It is: **assume the enforcement
> path will ship with a bug that only manifests under real time, and build the containment
> that makes that survivable.** Everything below is chosen against that assumption.

### 5.1 What the failure modes actually are

| # | Failure | Symptom for the child | Currently caught by |
|---|---|---|---|
| F1 | Agent crashes on start | Nothing enforced (silent) | launchd `KeepAlive` → restart loop |
| F2 | Agent runs but ticks are wrong | **Locked out at the wrong time** | ❌ nothing |
| F3 | Enforcement fires repeatedly | Machine shuts down / locks in a loop | ❌ nothing |
| F4 | Bad policy pushed from server | Wrong window enforced everywhere | ❌ nothing |
| F5 | Control plane unreachable | Depends entirely on fail-open/closed (O.1) | ❌ undecided |
| F6 | Bad *supervisor* version | Total loss of remote manageability | ❌ nothing |
| F7 | Clock skew / DST | Off-by-an-hour enforcement | ❌ nothing (T4.4) |

F2 and F3 are the POC's bug classes. They are the ones to design against.

### 5.2 launchd is a watchdog, but a shallow one — configure it deliberately

**[Proven]** `KeepAlive` without `ThrottleInterval` crash-loops at the documented 10-second
default with no backoff. With `ThrottleInterval` set very low and `KeepAlive: true`, launchd
can decide the job is thrashing and **stop restarting it permanently** — which for us means
silently no enforcement, forever, with no alert. The recommended combination is
`KeepAlive` with `SuccessfulExit = false` plus a raised `ThrottleInterval`: *"crash recovery
without a costly restart loop."*
Sources: <https://www.launchd.info/>, <https://github.com/tjluoma/launchd-keepalive>

```xml
<key>KeepAlive</key>
<dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>30</integer>
<key>ProcessType</key><string>Background</string>
```

Restart the service after a plist change with `launchctl kickstart -k system/<label>` —
`-k` kills the running instance before starting the new one — and use
`launchctl bootout` / `bootstrap` (not the deprecated `load`/`unload`) when the plist
itself changes. <https://eclecticlight.co/2019/08/27/kickstarting-and-tearing-down-with-launchctl/>

**But note what launchd cannot see: F2.** launchd knows the process is alive. It does not
know the process is *right*. That gap is the supervisor's job.

### 5.3 The dead-man's switch — the single highest-value control here

**[Synthesis], on a proven principle.** The monitoring world's formulation is that *"the
system responsible for detecting that monitoring is down must not depend on the monitoring
stack itself"* — an always-firing heartbeat whose *absence* is the alert
(<https://oneuptime.com/blog/post/2026-02-06-heartbeat-dead-man-switch-opentelemetry-pipeline/view>).
Applied to enforcement:

> **Enforcement is gated on a freshness token that only a healthy agent can refresh.**

- The agent writes `/var/db/homeparentcontrol/health` every tick: `{ts, tick_seq, version}`.
- Before *any* enforcement action, the enforcement path re-reads that file. If `ts` is
  older than `3 × tick_interval`, **the action does not fire.**
- Independently, the supervisor watches the same file. Stale for 5 minutes ⇒ roll back
  (§2.3 Layer 2) and raise a heartbeat-lost alert to the control plane.
- **It fails open.** If the file is missing, unreadable, or malformed, the answer is "do
  not enforce". A bug in the freshness check must never *cause* a lockout.

This is what turns F2 from "child locked out of her homework at 20:00 and nobody knows"
into "enforcement quietly stops and the parent gets an alert". Given AR.1 (the child cannot
exploit the gap) and T4.5 (the parent is told), that trade is clearly correct.

**It also answers O.1, in the only form the question has a defensible answer. [Synthesis]**
Not "fail open" or "fail closed" globally, but:

> **Fail *open* on infrastructure failure. Fail *closed* only on a deliberate, validated,
> current policy.** Server unreachable, agent unhealthy, policy stale beyond its TTL,
> credential revoked, clock unsynchronised ⇒ do not enforce, and alert. Only a policy that
> is schema-valid, freshly fetched or within TTL, and produced by a healthy tick may lock
> a machine.

The asymmetry of harm justifies it: an extra hour of screen time, with the parent notified,
is a small and reversible cost. A child locked out of a machine at 20:00 for homework, with
no parent home and no remote recovery, is not. O.1 is formally T4.4's to settle — this is
T3's input to it.

### 5.4 Staged rollout at n=1: irrelevant as usually meant — but the idea survives

**Say so plainly: population-based staged rollout is meaningless with one machine.** There
is no 1% cohort. Canary-by-percentage, blue/green, and ring deployment all reduce to
"deploy it".

**[Synthesis] But the *purpose* of a staged rollout — earn confidence in production before
committing — has an n=1 form: stage in time, not in population.** And it is precisely the
control the POC's experience calls for, because the bugs *"only appeared under live repeated
ticking"*:

> **Shadow mode.** A newly installed version starts with enforcement disabled. It runs the
> full tick loop, computes every decision it *would* make, and logs it — **alongside the
> decision the outgoing version would have made for the same input.** It is promoted to
> enforcing only after it has completed a **soak**: ≥ 24 hours, ≥ 1 full bedtime window,
> ≥ N ticks, zero crashes, zero heartbeat gaps, and **zero unexplained decision divergences
> from the previous version.** Only then does `last-good` advance (§2.4).

This is differential testing against the previous version, in production, under real time —
which is the one regime the dry-run suite provably did not cover. It costs one day of
latency per release, on a system where nobody is waiting.

Corollaries:

- **The promotion must be automatic**, on the soak criteria, not a manual step. A manual
  gate will be skipped at 23:00 on a Sunday.
- **Divergence is not automatically a failure** — you may have *intended* to change the
  decision. So a release declares its expected divergences (`expect_divergence: true` with a
  reason), and unexpected divergence blocks promotion. Absent that, every intentional fix
  fails its own soak.
- **Shadow mode is also the best test harness you will ever have.** Keep it after the soak,
  as a permanent flag, so you can run a candidate against live time whenever you want.

### 5.5 Config schema validation before apply

**[Synthesis]** Four gates, in order, on every policy fetch:

1. **Schema-valid** — a real schema (JSON Schema / Zod on the server, mirrored in the
   agent). Reject unknown enforcement actions outright; an unrecognised `action` must never
   fall through to a default of "shutdown".
2. **Semantically sane** — bounded by asserted invariants, not just types. Enforced window
   ≤ 12 h/day. At least one contiguous 6-hour unenforced window per day. No window starting
   in the past by more than one tick. Tick interval within [30 s, 300 s]. A policy that
   would lock the machine continuously is a bug, and the agent should say so rather than
   obey it.
3. **Signed or authenticated** — it arrived over the authenticated channel; do not accept
   policy from a file anyone could drop.
4. **Atomic apply with last-known-good retention** — write to a temp file in the same
   directory, `rename(2)` over the live path (§2.2). If any gate fails: keep the previous
   policy, log loudly, alert. **Never fall back to a compiled-in default policy** — an empty
   or default policy that happens to mean "always enforce" is exactly how F4 bricks a
   machine.

Validate on the **server** at write time too, so the parent UI rejects an impossible rule
before it is ever stored. Client-side validation is the backstop, not the gate.

### 5.6 Emergency local override

**[Synthesis]** Layered by how much has to be working:

| Tier | Mechanism | Works when | Latency |
|---|---|---|---|
| 0 | **Automatic dead-man's switch** (§5.3) | Agent unhealthy | ≤ 3 ticks |
| 1 | **Kill-switch file** — `/var/db/homeparentcontrol/DISABLE` | Any shell as root | Next tick |
| 2 | **`launchctl bootout system/com.homeparentcontrol.supervisor`** | SSH reachable | Immediate |
| 3 | **Server-side `enforcementEnabled: false`** | Agent polling | ≤ 1 poll |
| 4 | **Power button / admin account login** | Always | Immediate |

Rules for Tier 1, because it is the one that has to work when everything else is on fire:

- Checked **first, before any other logic**, at the top of the enforcement path — so a bug
  later in the path cannot skip it.
- Read **fresh from disk every tick**. Never cached. Never held in memory across ticks.
- **Fails safe**: if the check itself throws, treat it as present and do not enforce.
- Root-only writable (`/var/db/...`), so a non-admin child account cannot create it — which
  is why this remains a parent's tool under AR.1 even though it is a plain file.
- Optionally time-boxed: a JSON body `{"until": "2026-09-18T23:00:00Z"}` so "one film night"
  does not silently become "permanently off". An empty file = indefinite.
- **Its presence is reported in every heartbeat**, so the parent UI shows "enforcement
  disabled locally since 20:14" rather than the parent discovering it in March.

### 5.7 Rate-limit the enforcement path itself

**[Synthesis], and this is the direct answer to F3.** The most dangerous bug class is not
"fires wrongly once" — it is "fires in a loop". A shutdown loop is indistinguishable from
hardware failure to a child, and it can outrun every remote recovery path in §2.5 because
the machine is never up long enough to be reached.

- Hard cap: **at most 1 enforcement action per 10 minutes**, and **at most 5 per 24 hours**,
  enforced in the agent with a persisted counter (so a restart does not reset it).
- Exceeding the cap is a **health failure**, not a warning: it trips the dead-man's switch,
  disables enforcement, and alerts.
- The enforcement action must be **idempotent** — locking an already-locked screen is a
  no-op, not a second lock.
- Always give the notification a real head start (POC 1 already proved the notification
  path), and treat "notification failed to display" as a reason not to enforce.

### 5.8 Blast-radius summary

| Control | Catches | Cost | Recommend |
|---|---|---|---|
| `KeepAlive`+`ThrottleInterval` (§5.2) | F1 | 4 lines of plist | ✅ Day 1 |
| Supervisor + heartbeat (§2.3, §5.3) | F1, F2, F6 | ~300 lines | ✅ Day 1 |
| Dead-man's switch gating enforcement (§5.3) | F2, F5 | ~20 lines | ✅ Day 1 — highest value/effort |
| Kill-switch file (§5.6 Tier 1) | everything | ~10 lines | ✅ Day 1 |
| Enforcement rate limit (§5.7) | F3 | ~30 lines | ✅ Day 1 |
| Policy schema + invariant validation (§5.5) | F4 | ~100 lines both ends | ✅ Day 1 |
| Automatic crash/health rollback (§2.3) | F1, F2, F6 | in supervisor | ✅ Day 1 |
| Shadow-mode soak + differential (§5.4) | F2, F4 | ~150 lines + 1 day/release | ✅ v1.1 — this is the POC-bug control |
| Population staged rollout | — | — | ❌ Meaningless at n=1 |

---

## 6. Recommended design

Concrete enough to build from. **[Synthesis]** in its assembly; every mechanism cites §1–§5.

### 6.1 On-disk layout and process tree

```
launchd (system domain)
└── com.homeparentcontrol.supervisor          KeepAlive{SuccessfulExit:false}, ThrottleInterval 30
    ProgramArguments[0] =
      /usr/local/libexec/homeparentcontrol/hpc-supervisor      ← Developer ID signed, FIXED PATH
    │                                                            ~300 lines, no enforcement logic,
    │                                                            changes maybe twice a year
    ├── supervises ──► /usr/local/homeparentcontrol/current/bin/hpc-agent
    │                    ← the enforcement payload; changes every release
    └── update loop ──► GET https://<control-plane>/api/v1/agent/desired   every 5 min
```

```
/usr/local/libexec/homeparentcontrol/hpc-supervisor     root:wheel 0755   (signed, stable)
/usr/local/homeparentcontrol/
    versions/{1.0.3,1.1.0,1.1.1}/bin/hpc-agent          root:wheel 0755   (signed, per-version)
    current    -> versions/1.1.1                        atomic symlink
    last-good  -> versions/1.0.3                        advanced only after soak (§2.4)
/usr/local/etc/homeparentcontrol/
    config.json        0644 root:wheel                  server URL, poll interval, device id
    credential.json    0600 root:wheel                  rotating agent token (§3.3)
/var/db/homeparentcontrol/
    health             0600 root:wheel                  heartbeat — the dead-man's switch (§5.3)
    policy.cache.json  0600 root:wheel                  last-known-good policy + TTL
    quarantine         0600 root:wheel                  versions that failed; never re-install
    DISABLE            (absent)                         kill switch (§5.6)
/Library/LaunchDaemons/com.homeparentcontrol.supervisor.plist   root:wheel 0644
/var/log/homeparentcontrol/{agent,supervisor}.log
```

**Why the supervisor is a separate, fixed-path binary — the four reasons, since this is the
one structural decision everything else rests on:**

1. **BTM identity stability.** The launchd entry point is a Developer-ID-signed binary at a
   path that never changes, so §1.0 Fact A cannot bite on an update. Whether BTM would also
   tolerate a symlinked, per-version `ProgramArguments` is **[Verify]**; this design makes
   the question moot.
2. **The self-update hazard shrinks to almost nothing.** The updater is not the thing being
   updated. The component that changes weekly is never the component whose failure is
   unrecoverable.
3. **It is the watchdog launchd cannot be.** launchd sees exit codes; the supervisor sees
   heartbeat staleness — the F2 class, which is where the POC's bugs actually lived.
4. **It contains no enforcement logic**, so it inherits none of the risk concentrated there.
   It cannot lock, shut down, or log anyone out. By construction.

The cost, stated honestly: a second component, and a second thing to sign and version. It is
worth it because it is the *only* component you cannot roll back in place, and keeping it
tiny and static is what makes that acceptable.

### 6.2 Install (one time, attended — a password here is fine)

1. Parent clicks **Add device** in the parent UI → gets a one-time enrolment token (24 h,
   single use).
2. Download the notarized `.pkg` from GitHub Releases. Double-click, authenticate once.
3. pkg lays down supervisor + `versions/1.0.0/` + plist + `config.json`; postinstall writes
   `enrolment.token` (0600) from the pkg's choice argument or a prompt, flips `current`, and
   `launchctl bootstrap system/ /Library/LaunchDaemons/com.homeparentcontrol.supervisor.plist`.
4. **Check `sudo sfltool dumpbtm`.** If disposition is not enabled, approve once in
   System Settings → General → Login Items & Extensions. **Reboot and re-check** — this is
   the step that catches §1.0 Fact A. **[Verify]**
5. Agent enrols, exchanges the token for a credential, deletes `enrolment.token`, starts in
   **shadow mode**.
6. Verify FileVault is on. Verify Remote Login is on and that the parent's admin account can
   SSH in. Write both down; §2.5 depends on them.

### 6.3 Update (every time after that — fully unattended)

```
supervisor, every 5 min:
  GET /api/v1/agent/desired
    → {desiredVersion, pkgUrl, sha256, enforcementEnabled, supervisorVersion}
  if desiredVersion == running: sleep
  if desiredVersion in quarantine: log, alert, sleep          ← never re-install a known-bad
  if versions/<desiredVersion> exists on disk:                ← the rollback fast path
      flip current -> versions/<desiredVersion>;  kickstart -k;  done   (no network, seconds)
  else:
      download pkgUrl to a temp file
      verify sha256 == pinned                                 ← MUST, installer won't (§1.1)
      verify pkgutil --check-signature → Developer ID Installer + Notarized
      /usr/sbin/installer -pkg <tmp> -target /                ← no prompt: already root
        └─ pkg installs into versions/<new>/ ; postinstall flips current
      launchctl kickstart -k system/com.homeparentcontrol.supervisor
      new version starts in SHADOW MODE (§5.4)
  prune versions/ to the newest 3 + last-good
```

**Supervisor updates are deliberately different.** A `supervisorVersion` change does not
self-apply. It raises an alert in the parent UI: *"supervisor update available — run the
pkg."* It is an attended install, a couple of times a year, and that is the price of not
having the updater update itself.

### 6.4 Rollback

| Trigger | Mechanism | Human? | Network? | Time |
|---|---|---|---|---|
| 3 non-zero exits in 5 min | supervisor flips `current` → `last-good`, quarantines the bad version | No | No | < 1 min |
| Heartbeat stale > 5 min | same, **plus enforcement disabled** | No | No | < 5 min |
| Soak failure (§5.4) | version never promoted; `last-good` unchanged; alert | No | No | ≤ 24 h |
| Parent decides | `git revert` the version bump in the GitOps repo → Argo CD → ConfigMap → poll | Yes | Yes | ≤ 5 min |
| Everything is on fire | SSH: `touch /var/db/homeparentcontrol/DISABLE` | Yes | SSH only | Next tick |
| Nothing is reachable | power button; log in as admin | Yes | No | Immediate |

### 6.5 Secrets

As §3.3: one-time enrolment token → exchanged for a rotating agent credential in
`credential.json` at `0600 root:wheel`, rotated at T-7 days with a 24 h server-side overlap,
written atomically via `rename(2)`, revocable from the parent UI with **fail-open on
revocation**. No keychain. No secret in the pkg, so the release can be public. FileVault for
at-rest. The GitOps repo holds versions and policy — never a credential.

### 6.6 What P3.2's four words now map to

| P3.2 requires | Delivered by |
|---|---|
| **Versioned** | Git tag → notarized pkg on GitHub Releases → pinned `desiredVersion` in the GitOps repo (§4) |
| **Observable** | Structured JSON logs via the existing poll channel → control plane → Loki/Grafana; heartbeat + health in the parent UI (§4.4, §5.3) |
| **Updatable** | Supervisor reconciles to the pinned version, unattended, verified, every 5 min (§6.3) |
| **Rollback-able** | Symlink flip. Automatic on crash or unhealth; `git revert` when deliberate; works offline (§6.4) |

Not a script in a folder.

---

## 7. Runner-up, and what would flip it

**Runner-up: Munki (§1.5).**

It is the honest, battle-tested, non-MDM answer, it is actively developed (Munki 7, Swift,
macOS 26), and it has a real git + AutoPkg + GitHub Actions story. If the fleet were 40
Macs I would recommend it without hesitating, and I would not write a supervisor.

**What would flip the recommendation to Munki:**

1. **Fleet growth past ~5 managed Macs.** The supervisor's per-device assumptions
   (n=1 soak, single desired version) stop being free, and Munki's catalogs/manifests start
   paying for themselves. P2.4 says "extensible to more without a rewrite" — worth noting
   that swapping the *delivery* mechanism later is not a rewrite of the agent, because the
   agent's contract with the control plane (T4) is unchanged either way.
2. **The Mac needing to manage software other than this agent** — browsers, editors, OS
   updates. Munki does all of that; the supervisor will never do any of it, and should not
   be extended to try.
3. **Not wanting to own an updater.** This is legitimate. The supervisor is ~300 lines of
   root-privileged code that runs forever, and Chrome's Keystone demonstrates that this
   category of code carries real security weight (§1.3). If the answer to "who reviews the
   updater?" is "nobody", Munki's reviewed code is worth the rollback compromise.

**What would flip it further, to plain manual pkg installs:** if the agent turns out to
change perhaps twice a year. A quarterly attended install is not embarrassing — it is
proportionate, and it is strictly less code. Judge this after the first few months of real
churn; if v1.4 is still the running version in six months, delete the supervisor's update
loop and keep only its watchdog.

**What would *not* flip it:** Homebrew (§1.2, disqualified on security, not taste), Sparkle
(§1.3, wrong tool), or MDM (de-scoped by AR.1).

---

## 8. Open items this track hands on

| # | Item | To |
|---|---|---|
| **O.3 → resolved as "yes"** | Paid Apple Developer Program ($99/yr) is effectively mandatory: BTM gates unsigned daemon entry points (§1.0), and notarization requires paid membership. This is now a gating dependency, not an option | Owner decision — but the technical answer is settled |
| **O.1 → recommendation offered** | Fail *open* on infrastructure failure; fail *closed* only on a deliberate, validated, fresh policy (§5.3) | T4.4 to ratify |
| **D.3 → new argument** | `lock` preserves every remote recovery path; `shutdown` destroys all of them (§2.5). Strong operability argument for `lock` | T4 / owner |
| **[Verify] BTM disposition** | Confirm on the M4 that a pkg-installed, Developer-ID-signed LaunchDaemon is enabled after reboot without manual approval, and that it *stays* enabled across a version update. `sudo sfltool dumpbtm` | T1 — add as T1.8 |
| **[Verify] symlinked ProgramArguments** | Not needed by this design (§6.1), but worth 10 minutes: does BTM tolerate a symlinked entry point? | T1 |
| **Contract additions** | `/api/v1/agent/desired`, `/enrol`, `/rotate`; heartbeat fields `{version, tick_seq, shadow_mode, kill_switch_active, enforcement_count_24h}` | T4.1, T4.5 |
| **Observability decision** | Log shipping via the agent's own channel vs. Grafana Alloy on the Mac (§4.4). I recommend the former | T6.1 |
| **Language** | The agent must compile to a Developer-ID-signable binary. Swift or Go. **Shell and Python are eliminated** as the launchd entry point by §1.0 Fact A | T2.1 — this is a hard constraint on T2, not a preference |

---

## 9. Sources

**macOS daemon lifecycle, BTM, signing**
- BTM gating unsigned LaunchDaemons (Sonoma 14.6.1 → Tahoe): <https://mgaebler.me/en/blog/nix-macos-tahoe-btm-blocks-launchdaemons/>
- Apple — Manage login items and background tasks (ServiceManagement payload, Team Identifier exact match, MDM): <https://support.apple.com/guide/deployment/manage-login-items-background-tasks-mac-depdca572563/web>
- Apple Dev Forums — LaunchDaemon running bash shows as unidentified developer; bash has no Team Identifier: <https://developer.apple.com/forums/thread/755904>
- Apple Dev Forums — LaunchDaemon not loading after Sonoma: <https://developer.apple.com/forums/thread/768324>
- Apple — What's new for enterprise in macOS Tahoe 26: <https://support.apple.com/en-us/124963>
- Eclectic Light — Manage Login and Background items (2025-12): <https://eclecticlight.co/2025/12/03/manage-login-and-background-items/>
- Eclectic Light — Kickstarting and tearing down with launchctl: <https://eclecticlight.co/2019/08/27/kickstarting-and-tearing-down-with-launchctl/>
- Objective-See DumpBTM: <https://github.com/objective-see/DumpBTM>
- launchd.info (KeepAlive, ThrottleInterval, SuccessfulExit): <https://www.launchd.info/>
- launchd KeepAlive examples: <https://github.com/tjluoma/launchd-keepalive>

**Packaging, signing, notarization**
- scriptingosx — Building a LaunchDaemon installer pkg (structure, permissions, bootstrap/bootout, pkgbuild): <https://scriptingosx.com/2024/07/building-a-launchd-installer-pkg-for-desktoppr-and-other-tools/>
- scriptingosx — Notarization for MacAdmins (`installer` CLI bypasses quarantine/Gatekeeper): <https://scriptingosx.com/2019/10/notarization-for-macadmins/>
- Der Flounder — Verifying pkg signing and notarization with pkgutil: <https://derflounder.wordpress.com/2023/01/20/verifying-installer-package-signing-and-notarization-using-pkgutil/>
- Eclectic Light — How to check signatures on apps, installers, packages: <https://eclecticlight.co/2019/10/25/how-to-check-signatures-on-apps-installers-and-packages/>
- Apple Dev Forums — notarization requires paid Developer Program: <https://developer.apple.com/forums/thread/121113>
- Apple Developer Program ($99/yr): <https://developer.apple.com/programs/>
- Apple Dev Forums — `spctl --type install` rejecting notarized pkg on macOS 26.3: <https://developer.apple.com/forums/thread/817887>
- munki-pkg / munkipkg: <https://github.com/munki/munki-pkg>

**CI**
- macos-26 GA for GitHub-hosted runners (2026-02-26): <https://github.blog/changelog/2026-02-26-macos-26-is-now-generally-available-for-github-hosted-runners/>
- GitHub-hosted runners reference: <https://docs.github.com/en/actions/reference/runners/github-hosted-runners>
- Gusto Engineering — Running AutoPkg in GitHub Actions: <https://engineering.gusto.com/running-autopkg-in-github-actions-e9e377f19fe1>
- Version controlling Munki and AutoPkg: <https://grahamrpugh.com/2015/12/07/version-control-munki-autopkg.html>
- automunki: <https://github.com/joncrain/automunki>

**Munki**
- Munki project: <https://www.munki.org/munki/>
- managedsoftwareupdate: <https://github.com/munki/munki/wiki/managedsoftwareupdate>
- launchd jobs / schedule: <https://github.com/munki/munki/wiki/Launchd-Jobs-and-Changing-When-Munki-Runs>
- Manifests (version pinning syntax): <https://github.com/munki/munki/wiki/Manifests>
- Downgrading Software (downgrades unsupported): <https://github.com/munki/munki/wiki/Downgrading-Software>
- Rolling back versions in Munki: <https://www.alansiu.net/2020/12/22/rolling-back-versions-in-munki-and-using-blocking-applications-arrays/>
- Using Munki to revert or downgrade software: <https://managingosx.wordpress.com/2018/03/15/using-munki-to-revert-or-downgrade-software/>
- Is Munki still relevant in 2026 (Munki 7, Swift, macOS 26 support): <https://stabilise.io/blog/is-munki-still-relevant-2026>

**Homebrew**
- brew without sudo for unattended upgrades: <https://github.com/Homebrew/brew/issues/3428>
- brew upgrade sudo password prompts: <https://github.com/homebrew/brew/issues/20338>
- Unattended/silent install discussion: <https://github.com/orgs/Homebrew/discussions/3199>
- Homebrew FAQ: <https://docs.brew.sh/FAQ>

**Self-updating agents — prior art and hazards**
- Chromium updater (mac): <https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/updater/mac/>
- Keystone elevation-of-privilege: <https://issues.chromium.org/issues/40075849>
- Chrome updater root-privileged net-worker privesc: <https://issues.chromium.org/issues/520494861>
- Keystone removing /var symlink, causing boot issues: <https://mrmacintosh.com/google-chrome-keystone-is-modifying-var-symlink-on-non-sip-macs-causing-boot-issues/>
- Tailscale standalone macOS variant: <https://tailscale.com/blog/standalone-macos>
- Tailscale client auto-update: <https://tailscale.com/docs/features/client/update>
- tailscaled on macOS (`install-system-daemon` → /usr/local/bin + /Library/LaunchDaemons): <https://github.com/tailscale/tailscale/wiki/Tailscaled-on-macOS>
- Sparkle + launch daemons (not supported; root GUI unsupported): <https://github.com/sparkle-project/Sparkle/discussions/2423>
- Sparkle — relaunch daemon after update: <https://github.com/sparkle-project/Sparkle/discussions/2572>

**Atomic swap / rollback pattern**
- Deployer — The atomic symlink swap: <https://deployer.org/blog/atomic-symlinks>
- Tom Moertel — How to change symlinks atomically: <https://blog.moertel.com/posts/2005-08-22-how-to-change-symlinks-atomically.html>
- Artem Chistyakov — Atomic symlinks: <https://temochka.com/blog/posts/2017/02/17/atomic-symlinks.html>

**Secrets on macOS**
- Apple Dev Forums — System keychain from daemon requires root (errSecWrPerm for non-root): <https://developer.apple.com/forums/thread/657874>
- Apple Dev Forums — Secure secret storage in launch daemons via Keychain (Quinn): <https://developer.apple.com/forums/thread/725855>
- Apple Dev Forums — System Keychain not available from a Daemon (data-protection keychain is user-context only): <https://developer.apple.com/forums/thread/759976>
- Apple — Keychain data protection: <https://support.apple.com/guide/security/keychain-data-protection-secb0694df1a/web>

**Observability / dead-man's switch**
- Grafana Alloy on macOS (launchd service): <https://grafana.com/docs/grafana-cloud/observe-and-act/send-data/alloy/set-up/run/macos/>
- Alloy → Loki tutorial: <https://grafana.com/docs/alloy/latest/tutorials/send-logs-to-loki/>
- Heartbeat / dead-man's-switch alerting: <https://oneuptime.com/blog/post/2026-02-06-heartbeat-dead-man-switch-opentelemetry-pipeline/view>
- Dead man's switch for a monitoring stack: <https://seifrajhi.github.io/blog/securing-monitoring-stack-dead-man-switch/>

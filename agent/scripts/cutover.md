# Production cutover — putting it on her Mac and trusting it

Milestone 06. Everything here needs the Mac mini, sudo, and — for the last
two steps — an actual evening.

⚠️ **Do this on the mini, not on the machine you work on.** Step 3 powers a
computer off on purpose.

---

## 0. The abort, before anything else

```sh
sudo killall shutdown
```

⚠️ **Have this typed into a second terminal before the first real run.** A
scheduled `shutdown -h +N` is cancellable right up until it fires, and this
is what made POC 1's power-off testing safe. Learn it now, not while a
countdown is running.

Also confirm you can get back in:

```sh
sudo systemsetup -getremotelogin     # must say: Remote Login: On
```

⚠️ Under `shutdown` there is **no remote recovery path** — you cannot SSH
into a machine that is off. Remote Login is what makes the 300-second grace
a real recovery budget instead of a walk upstairs. `install.sh` refuses to
run without it, and the schema deliberately cannot express turning it off
(A.34).

---

## 1. Pin macOS, and do not accept 27

```sh
sudo softwareupdate --list
sudo softwareupdate --ignore "macOS Tahoe"        # or whatever 27 is called here
defaults read /Library/Preferences/com.apple.SoftwareUpdate AutomaticallyInstallMacOSUpdates
# expect 0; if not:
sudo defaults write /Library/Preferences/com.apple.SoftwareUpdate \
  AutomaticallyInstallMacOSUpdates -bool false
```

⚠️ **macOS 27 shipped 2026-09-14 and is entirely untested here.** Every
empirical finding in this project is 26.6.2, and the version-fragile ones —
TCC reach, `CGWindowList` redaction, BTM disposition, the `CGSession` lock
path — are exactly the ones carrying the main conclusions. A Hammerspoon
issue filed on 27's release day already reports the `CGSession` path gone,
which is why the agent ships two lock paths and self-tests both at boot.

**Do not accept the upgrade before re-running the V-series on 27.**

---

## 2. Install

```sh
sudo agent/scripts/install.sh
```

It builds a release pkg (⚠️ **without** `-DDEV_ENFORCEMENT` — the real
shutdown, not the log line), installs it, and then refuses to finish unless:

- the pkg and the whole installed tree carry **no `com.apple.quarantine`**;
- launchd actually knows all three daemons;
- Remote Login is on.

⚠️ **Every one of those failures is silent.** A quarantined non-notarized
Mach-O is SIGKILLed with no dialog, and macOS 27 will not load a quarantined
`.plist` at all. Under D.7 there is no Developer ID certificate, so nothing
clears the flag for you.

### If you ship the pkg from another machine

**Use `tar` or `rsync`. Never `.zip`.** Re-verified on this hardware
2026-09-20 by quarantining an archive and extracting it three ways:

| Extracted with | Result |
|---|---|
| `tar xzf` | ✅ clean |
| `unzip` | ❌ **quarantined** |
| `ditto -x -k` | ❌ **quarantined** |

### Then reboot

```sh
sudo reboot
# after it comes back:
sfltool dumpbtm | grep -A4 -i 'com\.hpc\.'     # expect: enabled, allowed
launchctl print system/com.hpc.enforcerd | head -20
```

⚠️ Surviving a reboot is its own exit criterion, and BTM disposition is only
meaningful after one. Research claimed BTM leaves script and ad-hoc
LaunchDaemons `disallowed` after a reboot — three tracks agreed, one citing
Apple DTS — and direct testing refuted it. Check, do not assume, in either
direction.

---

## 3. ⚠️ The one test development could not do: a real power-off

This is the single line the whole build deferred. **Everything else in this
project has been exercised; this has not.**

```sh
# Second terminal, ready:  sudo killall shutdown

# A window that opens in two minutes, with a SHORT grace so you are not
# waiting five minutes to learn anything.
sudo agent/scripts/make-test-policy.sh
sudo launchctl kickstart -k system/com.hpc.enforcerd
sudo log stream --predicate 'process == "hpc-enforcerd"' --info
```

Watch for, in order: the warnings at their lead times, `action_taken
{action: lock}` at the boundary, then — 300 s later, if the predicate still
holds — `action_taken {action: shutdown}` and the machine powering off.

**Pass:** the Mac is off, and `/var/db/homeparentcontrol/spool/` records the
ladder in order after it comes back.

**Fail, and what each means:**

- *Locks, never shuts down* — check `escalate_after_failures` and the grace.
  ⚠️ Also check the binary: a pkg built with `-DDEV_ENFORCEMENT` logs
  "would shut down" and returns success, which looks like a working ladder.
- *Shuts down without locking first* — the ladder is inverted. Stop; this is
  the one ordering that destroys unsaved work without warning.
- *Shuts down while the predicate no longer holds* — a late grant did not
  cancel the escalation. That is X10's territory and is release-blocking.

---

## 4. The shadow soak (§6.5)

The supervisor puts a newly installed version into shadow automatically:
the full tick loop runs, every decision is computed, **none is applied**,
and each is reported as `enforcement.shadow_decision`.

```sh
cat /var/db/homeparentcontrol/soak.json      # version, started_at, deadline
sudo log stream --predicate 'process == "hpc-enforcerd"' --info | grep -i shadow
```

⚠️ **The Mac is NOT enforcing bedtime during the soak.** That is the point,
it is bounded, and the parent UI says so in those words on the device card.
If the card does not say it, stop — a silent soak is a Mac that quietly
stopped locking.

Watch the soak from the control plane:

```
GET /api/parent/v1/devices/<id>/soak
```

It reports elapsed time, completed bedtime windows, crashes, heartbeat gaps
and any decision divergences against the last 14 days of `enforcement_log`.
**The divergence that matters is `would_stop_enforcing`** — the new version
would not have locked where the old one did.

Promotion is automatic on §6.5's criteria (≥24 h, ≥1 full bedtime window,
zero crashes, zero gaps, zero unexplained divergences).

⚠️ **And the soak ends at its deadline whether or not those are met.** The
deadline is baked into `soak.json` at install and nothing can move it —
criteria can only end a soak *early*. A soak that silently never finished
would be a Mac that silently never locks again, and that failure looks
exactly like everything working.

---

## 5. A real bedtime, observed

Put the real schedule back, let a normal evening happen, and afterwards read
`/devices/<id>` and `/reports`. You are checking that what the parent sees
matches what the child experienced — not that the log has rows in it.

---

## 6. A real override, on a real evening

Someone asks for more time. Open `/` on a phone, press **+30 min**, and
watch it go `Sent ✓` → `Applied ✓`.

⚠️ Expect **~5 seconds** only if the device page has been open — that is
what sets the attended flag and drops the poll from 60 s to 5 s. From the
home page alone it is up to a minute, and that is correct, not a bug.

⚠️ **If enforcement has already fired, the grant does not unlock the Mac.**
Nothing third-party can draw over the macOS lock screen. What happens is
that the boundary moves, the predicate goes false, the enforcer stops
re-locking, and she logs back in herself in about five seconds. The UI says
this in those words; make sure the person watching reads it, because a
parent who thinks the Mac is now open will walk away.

---

## 7. Tell her, or don't

**Not a technical decision.** Protection comes from account privileges, not
from secrecy (POC 1 §6) — she has admin, and the design assumes she could
find everything if she looked. A visible countdown costs nothing
technically.

That is a parenting call. The system works either way.

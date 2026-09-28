# The smoke test

**Goal: get one Mac enrolled against the deployed cluster, watch it lock at a
boundary, and have nothing power off.** Roughly 30 minutes.

This is the rehearsal before the cutover. It deliberately uses the **safe
variant** of the agent — the real power-off is
[`cutover.md`](./cutover.md) §3, afterwards, once everything else is known
good.

⚠️ **Use a spare Mac if you have one.** If it has to be the machine you work
on, it is safe — nothing here can power it off, and the test window closes by
itself — but turn on Remote Login and keep a shell open from another machine
(the Arch box works): a locked screen does not touch an SSH session.

The control plane is already up:

| | |
|---|---|
| UI | `http://homeparentcontrol.arch.internal` |
| API | `http://homeparentcontrol-api.arch.internal` |
| Agent base URL | `http://homeparentcontrol-api.arch.internal/api/agent/v1/` |

> **What the first run taught this document** (2026-09-22). It stalled for
> two days on eleven problems, none of them in the enforcement code, all of
> them between "the code is correct" and "it runs on a Mac under launchd".
> Every step below says what went wrong at it. See ADR 0010.

---

## 1. Create your account — 2 min 🧑

Only you can do this; it needs a password.

Open **`http://homeparentcontrol.arch.internal/sign-in`** → *First time
here?* → your email and a password.

⚠️ **The first account claims the household.** Make that you.

**Verify:** you land on Today, and it says *"No Macs yet"*.

---

## 2. Prepare the Mac — 5 min

On the test Mac, from a clone of this repo. Do all of this **before**
creating the enrolment code in step 3 — the code expires in 60 minutes, and
the first run lost its code to install problems while the clock ran.

**Remote Login on** — *System Settings → General → Sharing → Remote Login*.

⚠️ Not `sudo systemsetup -setremotelogin on`: that needs Full Disk Access for
the terminal even under sudo, and fails with a message that reads like a sudo
problem. The installer only *warns* without Remote Login for the safe build
(it cannot power off), but you want SSH to get back in while the screen is
locked.

**The screen lock must actually lock:**

```sh
sysadminctl -screenLock status     # run as the user who will be locked
```

⚠️ **It must say `immediate`.** The agent's primary lock is `pmset
displaysleepnow`, which only turns the display off; whether waking it needs a
password is this setting. The first run found `14400 seconds` — four hours —
at which the "lock" is a black screen that a mouse wiggle undoes, while the
agent logs `action_taken {action: lock}` and looks perfectly healthy. The
agent does not check this yet (see `docs/PUNCHLIST.md`). To set it:

```sh
sysadminctl -screenLock immediate -password -     # prompts for the password
```

Note the old value so you can put it back afterwards.

**Build the safe variant:**

```sh
./agent/scripts/build-pkg.sh 0.1.0 --dev
```

It refuses to finish unless all four binaries report `0.1.0-dev` — the
suffix comes from the same compile flag that removes the power-off, so the
version cannot lie about the variant.

---

## 3. Add the child and the Mac — 2 min 🧑

**Settings › Children & devices** (`/settings/children`) → add a child (name, timezone `America/New_York`) → add a device
(pick the child, label it e.g. *Lucy's Mac mini*) → **Add it and get a
code**.

⚠️ **Copy the code and go straight to step 4.** It is shown once, nothing
stores it, and the 60 minutes start now.

---

## 4. Install and enrol — one command

```sh
sudo agent/scripts/install.sh \
  agent/.build/pkg/homeparentcontrol-0.1.0-dev.pkg --allow-dev \
  --base-url http://homeparentcontrol-api.arch.internal/api/agent/v1/ \
  --code HPC-XXXX-XXXX-XXXX
```

The installer asks the packaged enforcer which variant it is and refuses a pkg
whose name disagrees; checks quarantine, launchd and Remote Login; loads all
three daemons; and writes the base URL and the code where sync reads them
every tick. Nothing needs restarting.

⚠️ **The base URL is a file, `/var/db/homeparentcontrol/base_url`.** Not
`launchctl setenv` — SIP refuses it — and not an edit to the installed plist,
which the next pkg upgrade silently reinstalls.

If you copied the pkg from another machine: **`tar` or `rsync`, never
`.zip`.** `unzip` and `ditto -x -k` propagate quarantine; `tar` does not.

**Verify — in the UI, not in a log.** Within about a minute the Mac appears on
Today; within three ticks its health reads *"checking in normally"*; the
device's own page (click its name on Today) shows **Agent `0.1.0-dev`** — the
Today card does not show a version.

If it does not appear:

```sh
sudo cat /var/db/homeparentcontrol/sync.health
```

| `last_decision` | Means |
|---|---|
| `no_base_url` | `--base-url` was missing or not http(s) |
| `awaiting_enrolment_code` | no code staged — `printf 'HPC-…' \| sudo tee /var/db/homeparentcontrol/enrolment_code` |
| `enrol_rejected:410` | the code **expired**. Make a new one in Settings › Children & devices (**New code**) and stage it. The dead code was moved to `enrolment_code.rejected` and is never retried |
| `enrol_rejected:409` / `:404` | already used / mistyped. Same fix |
| `enrol_failed:429` | the `/enroll` limiter (5/min, 20/hour for the household). Waits as told |
| `enrol_failed:unreachable` | DNS or network — `dig +short homeparentcontrol-api.arch.internal` |

⚠️ The first run's agent retried an expired code every second until the
server burned it, then exhausted the household's 20-per-hour enrolment
budget. A rejected code is now terminal after one attempt.

---

## 5. Set a test window and publish it — 3 min 🧑

**`/rules`** → **Add a window** → set it to start **5 minutes from now** and
end **8 minutes after that**. Make sure **today** is among its days (the
default is Mon–Thu).

Action: **Lock, then shut down** — *only* once the device page has shown
Agent `0.1.0-dev`. ⚠️ That is the only action that reaches the last rung: the ladder
escalates to shutdown only for a `shutdown` window, so with **Lock the
screen** the `DEV_ENFORCEMENT` line in step 6 can never appear. On the safe
build the power-off is a log line. If the card does NOT say `-dev`, choose
**Lock the screen** and skip that check.

**Save draft**, then read the **"What the Mac will obey"** panel — the
compiled document, not your edit — and **Publish**. The C3 guard fires
because it bites within 15 minutes; that is correct, confirm it.

The page says which Mac it publishes to. ⚠️ If you have a leftover `pending`
device from an expired code, it is skipped: the first run's page published to
it — 200, nothing reached anything. Delete stale ones in Settings › Children & devices anyway.

**Verify:** within a minute the tick reports `policy: "sent"`, and
`enforcer.health` (next step) shows the new version.

---

## 6. Watch it lock — the actual test

```sh
sudo agent/scripts/watch.sh
```

⚠️ **Not `log stream`** — the agent never writes to os_log, so that shows
nothing and looks like a dead agent. `watch.sh` shows which build is
installed, the base URL, sync's health, then every spool line and every
change to `enforcer.health`.

Expect, in order: the warnings at their lead times (compressed if the window
is close), then `enforcement.action_taken {action: lock}` at the boundary,
and the screen locks.

⚠️ Then it **re-locks every tick** while the window holds. That is not a
bug: *"enforcement is the re-locking, not the lock."*

Five minutes after the lock (the default grace) you will see
`DEV_ENFORCEMENT: shutdown suppressed (would have powered off)` from the
enforcer's stderr instead of the machine turning off. **That line is the
whole point of this run** — it proves the escalation fired and reached the
last rung, without exercising it. It needs the `Lock, then shut down`
action, a warning actually delivered (someone logged in), and the window
still open when the grace runs out — hence 8 minutes.

**Get out early:** `sudo touch /var/db/homeparentcontrol/DISABLE` stops both
the enforcer and the deadfall on their next tick. Booting out only
`com.hpc.enforcerd` does not — the deadfall is a separate job that re-checks
the schedule and locks by itself. Remove `DISABLE` afterwards.

---

## 7. Grant an override — the product moment

While the screen is locked, on your phone: open **`/`**, press **+30 min**.

Watch it go `Sent ✓` → `Applied ✓`.

⚠️ **~5 seconds only if you had the device page open** — that is what sets
the attended flag and drops the poll from 60 s to 5 s. From the home page
alone it can take up to a minute, and that is correct.

⚠️ **The grant does not unlock the Mac**, and the UI says so in those words.
The boundary moves, the predicate goes false, the enforcer stops re-locking,
and she logs back in herself.

---

## 8. Check the reports — 2 min

**`/reports`**: an hour the Mac was not reporting must be **hatched**, not
drawn as a zero. **`/devices/<id>`** shows the 7-day timeline and what
actually happened.

---

## What "passed" means

- [ ] The Mac enrolled, reached *checking in normally*, and shows `0.1.0-dev`
- [ ] A rule published from `/rules` reached it (`policy: "sent"`)
- [ ] It locked at the boundary, and kept re-locking
- [ ] The shutdown was **suppressed**, with the DEV line in the log
- [ ] A grant went `Sent ✓ → Applied ✓` and the boundary moved
- [ ] The UI never claimed the grant unlocked the Mac
- [ ] Reports distinguish "no data" from "no usage"

---

## When you are done

```sh
# Remove the safe variant before installing the real one.
for j in deadfall enforcerd sync supervisor; do
  sudo launchctl bootout "system/com.hpc.$j" 2>/dev/null
done
sudo rm -f /usr/local/libexec/hpc-* /Library/LaunchDaemons/com.hpc.*.plist
sudo rm -rf /var/db/homeparentcontrol

# If this was your own Mac, put the screen-lock delay back:
sysadminctl -screenLock <old value> -password -
```

⚠️ **Do not leave the `-dev` build installed.** It logs "would shut down"
for ever and looks completely healthy. The device page shows `0.1.0-dev`,
which is the tell.

Then decommission the test device in the UI (`/devices/<id>` →
Decommission, typed confirmation) so it is not left enrolled.

---

## If something goes wrong

| Symptom | Look at |
|---|---|
| Never appears in the UI | `sudo cat /var/db/homeparentcontrol/sync.health` — the table in step 4 |
| Appears, health stays `UNENROLLED` | the liveness job runs every 60 s — wait a minute |
| Enrolled, rules "published", policy never changes | which Mac did `/rules` say it published to? |
| Enrolled but never locks | is the window **today**? Is `DISABLE` absent? `watch.sh` shows both |
| "Locks" but a mouse wiggle brings the desktop back | `sysadminctl -screenLock status` is not `immediate` — step 2 |
| Locks but no warnings | warnings need a console user; check you are logged in |
| `NOT ENFORCING: shadow mode` | a soak marker is present. `sudo rm /var/db/homeparentcontrol/soak.json` — this is V-SHADOW-1 territory |
| Card says *is NOT enforcing* | either DEGRADED (it cannot read its rules) or shadow mode. Both are honest; read which |
| Device page shows Agent `0.1.0`, not `0.1.0-dev` | you installed the production pkg — it CAN power off. Have `sudo killall shutdown` ready |

⚠️ **Nothing in this run should ever power the Mac off.** If it does, you
installed the production pkg — check the device page for a `-dev` suffix,
and have `sudo killall shutdown` ready next time.

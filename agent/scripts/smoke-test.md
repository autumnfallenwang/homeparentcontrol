# The smoke test

**Goal: get one Mac enrolled against the deployed cluster, watch it lock at a
boundary, and have nothing power off.** Roughly 40 minutes, most of it
waiting for a two-minute window to arrive.

This is the rehearsal before the cutover. It deliberately uses the **safe
variant** of the agent — the real power-off is
[`cutover.md`](./cutover.md) §3, afterwards, once everything else is known
good.

⚠️ **Use a spare Mac if you have one.** If not, the mini is fine for this
run: nothing here powers it off, and the worst case is a locked screen you
clear with her password. Do NOT use the machine you are working on — step 5
locks the screen.

The control plane is already up:

| | |
|---|---|
| UI | `http://homeparentcontrol.arch.internal` |
| API | `http://homeparentcontrol-api.arch.internal` |
| Agent base URL | `http://homeparentcontrol-api.arch.internal/api/agent/v1/` |

---

## 1. Create your account — 2 min 🧑

Only you can do this; it needs a password.

Open **`http://homeparentcontrol.arch.internal/sign-in`** → *First time
here?* → your email and a password.

⚠️ **The first account claims the household.** The database is empty (I
removed the nine E2E households from the deploy verification), so whoever
signs up first owns it. Make that you.

**Verify:** you land on Today, and it says *"No Macs yet"*.

---

## 2. Add the child and the Mac — 2 min 🧑

**`/setup`** → add a child (name, timezone `America/New_York`) → add a Mac
(pick the child, label it e.g. *Lucy's Mac mini*) → **Add it and get a
code**.

⚠️ **Copy the code now.** It is shown once and nothing stores it — the
server keeps only a SHA-256 and a four-character hint. It expires in 60
minutes.

**Verify:** `/setup` lists the Mac as `pending` with a code hint.

---

## 3. Set the bedtime window — 1 min 🧑

**`/rules`** → set a window a couple of minutes ahead of when you expect to
finish step 4, every day, action **Lock the screen**. Save, then **Publish**.

⚠️ If the window is within 15 minutes, the C3 guard fires and asks you to
confirm. That is correct — it only ever fires on a *tightening* that bites
soon. Confirm it.

**Verify:** the diff pane shows the compiled document with your
`restricted_from`, and publishing succeeds.

---

## 4. Install the agent — 5 min

On the test Mac, from a clone of this repo:

```sh
# The SAFE variant: the real power-off is replaced by a log line.
./agent/scripts/build-pkg.sh 0.1.0 --dev

sudo agent/scripts/install.sh \
  agent/.build/pkg/homeparentcontrol-0.1.0-dev.pkg --allow-dev
```

⚠️ `--allow-dev` is required on purpose. A safe build reports its version as
`0.1.0-dev`, which shows on the device card, so you can never wonder later
which one is running.

The installer refuses to finish unless Remote Login is on, the pkg and the
whole installed tree are free of `com.apple.quarantine`, and launchd
actually accepted all three daemons. **Each of those fails silently
otherwise** — a quarantined non-notarized binary is SIGKILLed with no
dialog.

If you copied the pkg from another machine: **`tar` or `rsync`, never
`.zip`.** Re-verified on this hardware — `unzip` and `ditto -x -k` propagate
quarantine, `tar` does not.

Point it at the cluster and enrol:

```sh
sudo launchctl setenv HPC_BASE_URL \
  http://homeparentcontrol-api.arch.internal/api/agent/v1/
echo 'HPC-XXXX-XXXX-XXXX' | sudo tee /var/db/homeparentcontrol/enrolment_code
sudo launchctl kickstart -k system/com.hpc.sync
```

**Verify — in the UI, not in a log.** Within about a minute the Mac appears
on Today. Within three ticks its health reads *"checking in normally"*.

---

## 5. Watch it lock — the actual test

```sh
sudo log stream --predicate 'process == "hpc-enforcerd"' --info
```

Expect, in order: the warnings at their lead times (banner at T-30/-15,
modal at T-5/-1 — compressed if your window is close), then
`enforcement.action_taken {action: lock}` at the boundary, and the screen
locks.

⚠️ Then it **re-locks every tick** while the window holds. That is not a
bug: *"enforcement is the re-locking, not the lock."*

Five minutes later you will see
`DEV_ENFORCEMENT: shutdown suppressed (would have powered off)` on stderr
instead of the machine turning off. **That line is the whole point of this
run** — it proves the escalation fired and reached the last rung, without
exercising it.

---

## 6. Grant an override — the product moment

While the screen is locked, on your phone: open **`/`**, press **+30 min**.

Watch it go `Sent ✓` → `Applied ✓`.

⚠️ **~5 seconds only if you had the device page open** — that is what sets
the attended flag and drops the poll from 60 s to 5 s. From the home page
alone it can take up to a minute, and that is correct.

⚠️ **The grant does not unlock the Mac**, and the UI says so in those words.
The boundary moves, the predicate goes false, the enforcer stops re-locking,
and she logs back in herself. Read the sentence on screen — if you walk away
believing the Mac is now open, the wording failed and I want to know.

---

## 7. Check the reports — 2 min

**`/reports`**. There will be little data after 40 minutes, and that is the
thing to look at: an hour the Mac was not reporting must be **hatched**, not
drawn as a zero. Zero usage and no data mean opposite things.

**`/devices/<id>`** shows the 7-day timeline, the clock posture, and what
actually happened.

---

## What "passed" means

- [ ] The Mac enrolled and reached *checking in normally*
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
```

⚠️ **Do not leave the `-dev` build installed.** It logs "would shut down"
for ever and looks completely healthy. The device card shows `0.1.0-dev`,
which is the tell.

Then decommission the test device in the UI (`/devices/<id>` → Decommission,
typed confirmation) so it is not left enrolled.

---

## If something goes wrong

| Symptom | Look at |
|---|---|
| Never appears in the UI | `sudo log show --last 5m --predicate 'process == "hpc-sync"'`. Wrong base URL, or the code expired (60 min) |
| Appears, health stays `UNENROLLED` | the liveness job runs every 60 s — wait a minute |
| Enrolled but never locks | is the window today? `cat /var/db/homeparentcontrol/policy.current.json`. Check `DISABLE` is absent |
| Locks but no warnings | warnings need a console user; check you are logged in |
| `NOT ENFORCING: shadow mode` | a soak marker is present. `sudo rm /var/db/homeparentcontrol/soak.json` — this is V-SHADOW-1 territory |
| Card says *is NOT enforcing* | either DEGRADED (it cannot read its rules) or shadow mode. Both are honest; read which |

⚠️ **Nothing in this run should ever power the Mac off.** If it does, you
installed the production pkg — check the device card for a `-dev` suffix,
and have `sudo killall shutdown` ready next time.

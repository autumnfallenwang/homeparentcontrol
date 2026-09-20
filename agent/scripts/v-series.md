# V1–V9 — the verification matrix

**These cannot be automated from a coding session, and the reason is not
tooling.** They need a LaunchDaemon running as root (`sudo`), and several of
them deliberately lock the screen or power the machine off. Run them on a Mac
you are willing to have locked and shut down — **not** the one you are working
on.

The claim being tested is the contract's central unproven one: **enforcement is
independent of the network.** Everything else in this project assumes it.

---

## Before you start

```sh
# 1. Build the SAFE variant. DEV_ENFORCEMENT replaces the real shutdown with a
#    log line, so V-series runs cannot power the machine off.
#    ⚠️ It is compile-time only — there is no env var or plist key to flip,
#    because a runtime switch for this is lever #7 on a machine where the child
#    has admin.
swift build -c release --package-path agent -Xswiftc -DDEV_ENFORCEMENT

# 2. Install. Every daemon must be root-owned or launchd refuses to load it.
sudo mkdir -p /var/db/homeparentcontrol/spool /var/db/homeparentcontrol/pkgs
sudo mkdir -p /var/log/homeparentcontrol
sudo chmod 700 /var/db/homeparentcontrol

install_one() {                       # $1 = build product, $2 = installed name
  sudo cp "agent/.build/release/$1" "/usr/local/libexec/$2"
  sudo chown root:wheel "/usr/local/libexec/$2"
  sudo chmod 755 "/usr/local/libexec/$2"
}
install_one HPCEnforcer  hpc-enforcerd
install_one HPCDeadfall  hpc-deadfall
install_one HPCSupervisor hpc-supervisor
install_one HPCSync      hpc-sync

# ⚠️ com.hpc.deadfall.plist is NOT copied. Sync GENERATES it from the active
# policy (§4.6), because a hand-written one would carry a bedtime that never
# follows the schedule it is supposed to back up.
for job in enforcerd sync supervisor; do
  sudo cp "agent/scripts/com.hpc.$job.plist" /Library/LaunchDaemons/
  sudo chown root:wheel "/Library/LaunchDaemons/com.hpc.$job.plist"
  sudo chmod 644 "/Library/LaunchDaemons/com.hpc.$job.plist"
done

# 3. A policy it will actually act on. Set the window to a couple of minutes
#    from now so you are not waiting until 21:30 to learn anything.
#    See `make-test-policy.sh` in this directory.
sudo agent/scripts/make-test-policy.sh

# 4. Load. The enforcer alone for V1-V4 and V7-V8; add sync for V5 and V6.
sudo launchctl bootstrap system /Library/LaunchDaemons/com.hpc.enforcerd.plist
```

**To stop at any point:**

```sh
for job in enforcerd sync supervisor deadfall; do
  sudo launchctl bootout "system/com.hpc.$job" 2>/dev/null
done
sudo touch /var/db/homeparentcontrol/DISABLE     # the emergency control
```

⚠️ `DISABLE` stops the enforcer **and** the deadfall, deliberately — an
emergency control that one component ignores is not an emergency control.

---

## The matrix

Each row: what to break, and what must still happen. **The expected result is
always "it still locks"** — that is the whole point.

| # | Break this | Must still happen | How |
|---|---|---|---|
| **V1** | Cluster off | Locks at the boundary | `kubectl scale --replicas=0` the api deployment, or just never start it |
| **V2** | Cable out | Locks at the boundary | Turn off Wi-Fi and unplug Ethernet before the window opens |
| **V3** | DNS blackholed | Locks at the boundary | `sudo dscacheutil -flushcache`; point `/etc/hosts` for the API host at `127.0.0.1` |
| **V4** | Server returns 500 forever | Locks at the boundary | Point `HPC_BASE_URL` at a stub returning 500 |
| **V5** | Server accepts then hangs 120 s | Locks at the boundary — **proves total sync timeout < one tick** | Below |
| **V6** | `launchctl bootout system/com.hpc.sync` | **Byte-identical enforcer logs** with and without sync — the direct proof | Below |
| **V7** | Disk full | Locks at the boundary; telemetry is lost, enforcement is not | `mkfile` a large file, or fill the spool volume |
| **V8** | `sudo chmod 000 /var/db/homeparentcontrol/policy.current.json` | Falls back to `policy.lkg.json` and **still locks at 21:30** | Below |
| **V9** | `sudo kill -9` the enforcer | The deadfall re-locks | Below |

V5, V6 and V9 moved here from milestone 02 on 2026-09-20: they test the
enforcer against the sync daemon and the deadfall, which M2's own scope
deferred, so they could never have passed there.

---

## V8, worked end to end

The one that most directly exercises the LKG path.

```sh
# Confirm it is enforcing normally first, or you prove nothing.
sudo log stream --predicate 'process == "hpc-enforcerd"' --info &
cat /var/db/homeparentcontrol/enforcer.health          # last_decision should change at the boundary

# Break the current policy.
sudo chmod 000 /var/db/homeparentcontrol/policy.current.json

# Within one tick (60 s) the spool must show the fallback, and the lock must
# still fire at the boundary.
tail -f /var/db/homeparentcontrol/spool/enforcer.ndjson | grep -E 'using_lkg|action_taken'
```

**Pass:** an `agent.degraded {reason: using_lkg}` line, followed by
`enforcement.action_taken {action: lock}` at the boundary.

**Fail:** no lock, or an `agent.degraded {reason: policy_corrupt}` with no
lock — that would mean the LKG fallback did not engage and the machine is
usable past bedtime.

```sh
sudo chmod 600 /var/db/homeparentcontrol/policy.current.json   # restore
```

---

## V6, worked end to end — **the headline**

*Byte-identical enforcer logs with and without sync running.* Everything else
in this project assumes enforcement is independent of the network; V6 is the
only thing that checks it directly.

The comparison must ignore what is *expected* to differ — wall-clock stamps
and the tick counter — and compare what must not: the sequence of decisions.

```sh
# --- Run A: sync is NOT running.
sudo launchctl bootout system/com.hpc.sync 2>/dev/null
sudo rm -f /var/db/homeparentcontrol/spool/*.ndjson
sudo agent/scripts/make-test-policy.sh          # window opens in ~2 minutes
sudo launchctl kickstart -k system/com.hpc.enforcerd
sleep 420                                        # through the boundary
sudo cp /var/db/homeparentcontrol/spool/enforcer.ndjson /tmp/run-a.ndjson

# --- Run B: identical, with sync running.
sudo rm -f /var/db/homeparentcontrol/spool/*.ndjson
sudo launchctl bootstrap system /Library/LaunchDaemons/com.hpc.sync.plist
sudo agent/scripts/make-test-policy.sh
sudo launchctl kickstart -k system/com.hpc.enforcerd
sleep 420
```

⚠️ **Sync ROTATES the spool as it drains**, so run B's record is spread across
the live file and any `enforcer.<stamp>.ndjson` segments. Concatenate them in
order, or you will "prove" that sync ate the log:

```sh
sudo sh -c 'cat /var/db/homeparentcontrol/spool/enforcer.*.ndjson \
                /var/db/homeparentcontrol/spool/enforcer.ndjson 2>/dev/null' \
  > /tmp/run-b.ndjson

# Compare the DECISIONS. `ts` and `seq` are expected to differ.
norm() { jq -c '{event, detail: (.detail // {})}' "$1"; }
diff <(norm /tmp/run-a.ndjson) <(norm /tmp/run-b.ndjson) && echo "V6 PASS"
```

**Pass:** empty diff. The enforcer took the same decisions in the same order.

**Fail, and what each means:**

- *Lines missing from B* — sync's rotation is losing appends. `SpoolReader`
  must `rename(2)`, never copy-truncate.
- *Different decisions* — the two daemons are coupled. Find out how. This is
  the finding the whole milestone exists to surface.
- *Extra lines in B* — expect `policy.applied` and
  `agent.deadfall_rescheduled`, which sync legitimately writes to the shared
  spool. Filter them, and **record that you did** in the milestone notes:
  narrowing the comparison is exactly how a failing V6 becomes a passing one.

---

## V5, worked end to end

*Total sync timeout < one tick.* The client's 20 s resource timeout plus its
5 s semaphore backstop is the worst case one request can occupy; the
enforcer's tick is 60 s, in another process.

Start a server that accepts the connection and then says nothing — put this
in `/tmp/hang.py` and run it with `python3 /tmp/hang.py &`:

```python
import socket, time
s = socket.socket()
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("127.0.0.1", 8088))
s.listen(8)
while True:
    conn, _ = s.accept()
    time.sleep(120)          # accept, then hang
    conn.close()
```

```sh
sudo launchctl setenv HPC_BASE_URL http://127.0.0.1:8088/api/agent/v1/
sudo launchctl kickstart -k system/com.hpc.sync
sudo agent/scripts/make-test-policy.sh
sleep 420

# The enforcer must have locked, on time, while sync was hung.
grep -c action_taken /var/db/homeparentcontrol/spool/enforcer*.ndjson
# And sync must have given up long before 120 s.
cat /var/db/homeparentcontrol/sync.health
```

**Pass:** `enforcement.action_taken {action: lock}` at the boundary, and a
`sync.health` whose `last_decision` is `unreachable` — not a daemon still
waiting.

---

## V9, worked end to end

*The deadfall re-locks when the enforcer is dead.*

```sh
# The deadfall's plist is GENERATED by sync from the active policy, so make
# the policy first and give sync a tick to write it.
sudo agent/scripts/make-test-policy.sh
sleep 90
plutil -p /Library/LaunchDaemons/com.hpc.deadfall.plist | head -20
#   -> StartCalendarInterval entries at the boundary, +5 and +20 minutes

# Kill the enforcer AND stop launchd bringing it back, or you are testing
# KeepAlive rather than the deadfall.
sudo launchctl bootout system/com.hpc.enforcerd
sudo pkill -9 hpc-enforcerd

tail -f /var/log/homeparentcontrol/deadfall.log
```

**Pass:** the screen locks, and the spool carries
`enforcement.action_taken` with `source: deadfall` and `seq: -1`.

**Fail modes worth distinguishing:**

- *Nothing fires at all* — the plist was never loaded.
  `launchctl print system/com.hpc.deadfall`.
- *It fires and declines to lock* — check `enforcement.evaluated`. If
  `action: deferred_to_enforcer`, the enforcer's health file was still under
  five minutes old. Wait longer, or delete it.
- *It fires outside a window and locks anyway* — a predicate bug, and a
  serious one. The deadfall must be a no-op outside a restricted window.

⚠️ **Also check the override clause**, the part the design document singles
out: "without it, a holiday night with both daemons dead would lock at the
baseline time." Grant a `suspend` override for tonight, kill the enforcer, and
confirm the deadfall fires and does **nothing**:

```sh
grep 'restricted' /var/db/homeparentcontrol/spool/enforcer*.ndjson
```

A deadfall that locks through a holiday grant is worse than no deadfall — it
is the one failure a parent cannot explain to a child.

---

## V-PKG-1 and the supervisor's rollback — **the one thing still unproven**

⚠️ **The whole offline-recovery story rests on a claim nobody has checked.**
`.pkg` downgrade was observed only in the *user* domain; `installer -target /`
as root is untested, and §6.4's entire rollback path is
`installer -pkg pkgs/<last-good>.pkg -target /`. If root-domain `installer`
refuses to go backwards, the supervisor's recovery path does not exist and
every table entry claiming "No human? No network? < 1 min" is wrong.

Everything else in this file can be checked in an evening. This one changes
the design if it fails, so run it first.

```sh
# Two packages, a version apart.
./agent/scripts/build-pkg.sh 0.1.0
./agent/scripts/build-pkg.sh 0.2.0

sudo mkdir -p /var/db/homeparentcontrol/pkgs
for v in 0.1.0 0.2.0; do
  sudo cp "agent/.build/pkg/homeparentcontrol-$v.pkg"        \
          "/var/db/homeparentcontrol/pkgs/$v.pkg"
  sudo cp "agent/.build/pkg/homeparentcontrol-$v.pkg.sha256" \
          "/var/db/homeparentcontrol/pkgs/$v.pkg.sha256"
done

# ── V-PKG-1 itself: forward, then BACKWARD, both as root.
sudo /usr/sbin/installer -pkg /var/db/homeparentcontrol/pkgs/0.2.0.pkg -target /
pkgutil --pkg-info com.hpc.agent           # expect version: 0.2.0

sudo /usr/sbin/installer -pkg /var/db/homeparentcontrol/pkgs/0.1.0.pkg -target /
pkgutil --pkg-info com.hpc.agent           # ← THE QUESTION. 0.1.0, or refused?
```

**Pass:** `pkgutil` reports 0.1.0, and `/usr/local/libexec/hpc-enforcerd` is
the older binary. Record it in the milestone and the rollback design stands.

**Fail** — `installer` refuses the downgrade, or reports success and leaves
the newer files: **stop and say so.** Do not work around it locally. The
options then are a versioned-directory layout with a symlink swap (which E.2
simplified away), or `--dominion`-style forced install, and choosing between
those is an ADR, not a patch.

### Then the supervisor's own rollback, unattended and offline

```sh
# Running 0.2.0, with 0.1.0 cached as last-good.
sudo /usr/sbin/installer -pkg /var/db/homeparentcontrol/pkgs/0.2.0.pkg -target /
echo 0.1.0 | sudo tee /var/db/homeparentcontrol/last_good
sudo launchctl bootstrap system /Library/LaunchDaemons/com.hpc.supervisor.plist

# ⚠️ Pull the network FIRST. §6.4's claim is "No network", and a rollback
# that quietly downloads is not the thing being tested.
sudo ifconfig en0 down

# Break the enforcer so the supervisor sees a stale heartbeat.
sudo launchctl bootout system/com.hpc.enforcerd
sudo rm -f /var/db/homeparentcontrol/enforcer.health

# The supervisor needs `staleConfirmations` (2) ticks past its cooldown.
# ⚠️ The cooldown is 10 MINUTES from boot, deliberately — without it every
# reboot would be a rollback. Wait it out; this is not hung.
sleep 720
tail -f /var/log/homeparentcontrol/supervisor.log
```

**Pass:** `pkgutil --pkg-info com.hpc.agent` reports 0.1.0, `quarantine.json`
contains `0.2.0`, and the spool has `supervisor.rollback` — all with `en0`
down.

**Fail modes worth distinguishing:**

- *Nothing happens for 20 minutes* — check `supervisor.deferred`'s reason.
  `unhealthy_but_in_cooldown` means keep waiting;
  `unhealthy_no_rollback_target` means `last_good` names a version that is
  not in `pkgs/`.
- *It rolls back repeatedly* — the cooldown is not holding. That is the loop
  `SupervisorPolicyTests.cooldownStopsTheRollbackLoop` exists to prevent, so
  it would mean the daemon is not carrying state across ticks.
- *It rolls back and then installs 0.2.0 again* — quarantine is not being
  read. This is the infinite install/crash/rollback loop; treat it as
  release-blocking.

⚠️ **Restore the network and reinstall the current version afterwards.** A
machine left on a quarantined old build will not accept the new one.

---

## V-SAMPLE-1 — does the sampler work from a root daemon?

⚠️ **The one sampler claim that could not be checked without root.**

Two of the sampler's probes have to run inside the console user's GUI
session, and the daemon reaches it with `launchctl asuser` — the same
mechanism the warning banners use, which M2 verified for `osascript`.
**Verified for `osascript`, ASSUMED for these two.** If the assumption is
wrong the sampler reports no frontmost app and never sees a lock, which
presents as a report page that renders perfectly with no data in it.

```sh
UID_NOW="$(stat -f %u /dev/console)"

# 1. The frontmost app, from root.
sudo launchctl asuser "$UID_NOW" /usr/bin/lsappinfo front
sudo launchctl asuser "$UID_NOW" /usr/bin/lsappinfo info -only bundleid -only pid \
  "$(sudo launchctl asuser "$UID_NOW" /usr/bin/lsappinfo front)"

# 2. The lock state, from root, via the daemon's own re-exec.
sudo launchctl asuser "$UID_NOW" /usr/local/libexec/hpc-sync --session-probe
```

**Pass:** the first prints `"CFBundleIdentifier"="…"` and a pid; the second
prints `locked=0 onconsole=1`. Then lock the screen (⌃⌘Q) and re-run the
second from another machine over SSH — it must print `locked=1`.

**Fail:** empty output, or `locked=unknown`. That means `asuser` does not
carry the session for these calls the way it does for `osascript`. The
fallback is a LaunchAgent in the user domain feeding the daemon — which is a
new job, a new plist and a new trust boundary, so it is an ADR rather than a
patch.

⚠️ **Neither failure touches enforcement.** The sampler is in the sync daemon
and writes only to `queue.sqlite`. A broken sampler costs reporting, and V6
is what proves it costs nothing else.

### V-SAMPLE-2 — does the monotonic clock stop during sleep?

The sampler measures intervals with `ProcessInfo.systemUptime` precisely so a
clock step cannot inject usage, and it infers sleep from wall-clock time
advancing further than monotonic time. **That second part assumes
`systemUptime` does not tick while the Mac is asleep**, which is standard for
`mach_absolute_time` but is untested on this hardware.

```sh
# Note the two clocks, sleep the Mac for five minutes, wake it, note again.
date +%s; sysctl -n kern.boottime
sudo pmset sleepnow
# …wake it…
date +%s; sysctl -n kern.boottime
grep session.state /var/db/homeparentcontrol/spool/enforcer*.ndjson | tail -3
```

**Pass:** a `session.state` with `state: asleep` covering the gap.

**Fail:** no `asleep` transition. Then the monotonic clock ran through sleep,
and the *detector* is wrong — but the *meter* is still right, because
`maxIntervalS` clamps any interval to 300 s regardless. Sleep would simply be
reported as idle time rather than as sleep. Losing that distinction is a
reporting gap, not an over-count.

---

## V-SHADOW-1 — does shadow mode actually not enforce, and then actually enforce?

⚠️ **The only deliberate non-enforcing path in the project.** Its pure logic
has 17 tests and its marker has 12, but the 20 lines that wire it into the
enforcer's tick cannot be exercised without root — and those 20 lines are
the ones that decide whether a Mac locks tonight.

Two halves, and **the second matters more than the first**. A shadow that
does not enforce is the feature; a shadow that never *stops* is a Mac that
silently never locks again, and it looks identical to everything working.

```sh
# ── Half 1: it does NOT enforce while soaking.
sudo agent/scripts/make-test-policy.sh          # window opens in ~2 minutes

# Enter shadow by hand, the way the supervisor would.
VERSION=$(/usr/local/libexec/hpc-enforcerd --version 2>/dev/null \
          || sed -n 's/.*version = "\(.*\)"/\1/p' agent/Sources/HPCEnforcer/main.swift | head -1)
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
DEADLINE=$(date -u -v+1H +%Y-%m-%dT%H:%M:%SZ)
printf '{"version":"%s","started_at":"%s","deadline":"%s"}\n' "$VERSION" "$NOW" "$DEADLINE" \
  | sudo tee /var/db/homeparentcontrol/soak.json

sudo launchctl kickstart -k system/com.hpc.enforcerd
sleep 240                                        # through the boundary
```

**Pass:** the screen does **not** lock, and the spool carries
`enforcement.shadow_decision` with `would` containing `lock`. stderr in
`/var/log/hpc-enforcerd.log` says `NOT ENFORCING: shadow mode until …` every
tick.

**Fail:** it locks anyway (the wiring is wrong, or the marker was rejected —
check the version string matches exactly), or there are no shadow decisions
(it is not in shadow at all, which the log line will say).

```sh
# ── Half 2: ★ it DOES enforce once the deadline passes.
DEADLINE=$(date -u -v-1M +%Y-%m-%dT%H:%M:%SZ)    # already expired
printf '{"version":"%s","started_at":"%s","deadline":"%s"}\n' "$VERSION" "$NOW" "$DEADLINE" \
  | sudo tee /var/db/homeparentcontrol/soak.json
sudo agent/scripts/make-test-policy.sh
sleep 240
```

**Pass:** it locks, normally, and no shadow decisions appear.

### And the three tamper cases

Each should lock. They are the properties that keep this from being lever #1
([[enforcement-invariant]]) — a runtime "do not enforce" switch on a machine
where the child has admin.

```sh
# Wrong version — a stale marker, or a rollback to an already-soaked build.
printf '{"version":"9.9.9","started_at":"%s","deadline":"%s"}\n' "$NOW" "$DEADLINE_FUTURE" | sudo tee …
# A hand-edited year-long deadline.
printf '{"version":"%s","started_at":"%s","deadline":"2027-01-01T00:00:00Z"}\n' "$VERSION" "$NOW" | sudo tee …
# Corrupt.
echo 'not json' | sudo tee /var/db/homeparentcontrol/soak.json
```

⚠️ **Remove the marker when you are done**, or the next run soaks:

```sh
sudo rm -f /var/db/homeparentcontrol/soak.json
```

---

## What is already proven without you

These ran in CI and locally, and need no hardware:

- **`otool -L` shows no networking symbols** in the enforcer, the deadfall
  *and* the supervisor — `agent/scripts/check-no-networking.sh`. Falsified:
  adding a real `NWPathMonitor()` makes it fail. (A *dead* `import Network`
  passes, because Swift does not link an unused framework — so this proves no
  network *capability*, which is the property that matters.) The script also
  asserts `HPCSync` **fails** the same test: three vacuous passes read exactly
  like three real ones.
- **The predicate**, including the midnight crossing and both 2026 DST
  transitions — 28 tests.
- **The ladder**, including an exhaustive sweep proving that no combination of
  warning failure, absent console user, tripped breaker or delivery history
  can prevent the lock — 25 tests.
- **JWS verification**, including a tampered payload, a foreign key, `alg:none`
  and an unknown `kid` — 11 tests.
- **Decoding**, including the rule that tolerance never defaults toward less
  enforcement — 9 tests.
- **The deadfall's schedule**, including the timezone trap: a system timezone
  different from the policy's does not move bedtime — 11 tests.
- **The queue**, including a four-hour outage drained event by event with no
  loss and no duplication — 12 tests.
- **The supervisor's judgement**, including that it never kickstarts the
  enforcer into a loop and never downgrades a healthy agent to the cached
  last-good — 19 tests.
- **The sampler**, including that a clock step cannot inject usage, that an
  interval spent idle reports zero `active_s`, and that a locked screen is
  credited to nothing — 19 tests, plus 7 live probes against this Mac's real
  `lsappinfo`, `ioreg` and window-server session.
- **Shadow mode's judgement** — 17 tests, including an exhaustive sweep
  proving the window can never outlive its maximum under any input, and that
  a soak which can never promote still ends at its deadline.
- **The soak marker**, 12 tests: every unreadable, truncated, wrong-shaped,
  wrong-versioned or hand-edited state resolves to ENFORCING, with a control
  test proving a well-formed one really does shadow.
- **Swift→TypeScript interop for telemetry**: the sampler's output is
  committed as a fixture, the Swift suite fails if the emitter drifts from
  it, and the TypeScript suite fails if it stops satisfying the projector.
  Falsified by renaming one field — note that `unprojectable` stayed **0**,
  because zod's `.optional()` accepts absence. The assertion that caught it
  was "the field is actually present and greater than zero".

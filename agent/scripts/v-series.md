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

# 2. Install. The daemon must be root-owned or launchd refuses to load it.
sudo mkdir -p /var/db/homeparentcontrol/spool
sudo cp agent/.build/release/HPCEnforcer /usr/local/libexec/hpc-enforcerd
sudo chown root:wheel /usr/local/libexec/hpc-enforcerd
sudo chmod 755 /usr/local/libexec/hpc-enforcerd

# 3. A policy it will actually act on. Set the window to a couple of minutes
#    from now so you are not waiting until 21:30 to learn anything.
#    See `make-test-policy.sh` in this directory.
sudo agent/scripts/make-test-policy.sh

# 4. Load it.
sudo launchctl bootstrap system /Library/LaunchDaemons/com.hpc.enforcerd.plist
```

**To stop at any point:**

```sh
sudo launchctl bootout system/com.hpc.enforcerd
sudo touch /var/db/homeparentcontrol/DISABLE     # the emergency control
```

---

## The matrix

Each row: what to break, and what must still happen. **The expected result is
always "it still locks"** — that is the whole point.

| # | Break this | Must still happen | How |
|---|---|---|---|
| **V1** | Cluster off | Locks at the boundary | `kubectl scale --replicas=0` the api deployment, or just never start it |
| **V2** | Cable out | Locks at the boundary | Turn off Wi-Fi and unplug Ethernet before the window opens |
| **V3** | DNS blackholed | Locks at the boundary | `sudo dscacheutil -flushcache`; point `/etc/hosts` for the API host at `127.0.0.1` |
| **V4** | Server returns 500 forever | Locks at the boundary | Any stub returning 500; there is no sync daemon yet, so this is a no-op until M3 |
| **V5** | Server accepts then hangs 120 s | Locks at the boundary — **proves total sync timeout < one tick** | Needs the sync daemon. **Deferred to M3** |
| **V6** | `launchctl bootout system/com.hpc.sync` | **Byte-identical enforcer logs** with and without sync — the direct proof | Needs the sync daemon. **Deferred to M3** |
| **V7** | Disk full | Locks at the boundary; telemetry is lost, enforcement is not | `mkfile` a large file, or fill the spool volume |
| **V8** | `sudo chmod 000 /var/db/homeparentcontrol/policy.current.json` | Falls back to `policy.lkg.json` and **still locks at 21:30** | Below |
| **V9** | `sudo kill -9` the enforcer | The deadfall re-locks | Needs the deadfall. **Deferred to M3** |

### ⚠️ V5, V6 and V9 cannot pass in this milestone

They test the *interaction* between the enforcer and components that do not
exist yet — the sync daemon and the deadfall, both M3. **This is a scope error
in the milestone as written**, not a gap in the work: M2's own scope says "no
network code at all" and "sync, supervisor, deadfall (milestone 03)".

V6 in particular is the milestone's headline — "byte-identical logs with and
without sync running" — and it is unrunnable until there is a sync daemon to
boot out. Recommend moving V5, V6 and V9 to M3's exit criteria.

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

## What is already proven without you

These ran in CI and locally, and need no hardware:

- **`otool -L` shows no networking symbols** — `agent/scripts/check-no-networking.sh`.
  Falsified: adding a real `NWPathMonitor()` makes it fail. (A *dead*
  `import Network` passes, because Swift does not link an unused framework —
  so this proves no network *capability*, which is the property that matters.)
- **The predicate**, including the midnight crossing and both 2026 DST
  transitions — 28 tests.
- **The ladder**, including an exhaustive sweep proving that no combination of
  warning failure, absent console user, tripped breaker or delivery history
  can prevent the lock — 25 tests.
- **JWS verification**, including a tampered payload, a foreign key, `alg:none`
  and an unknown `kid` — 11 tests.
- **Decoding**, including the rule that tolerance never defaults toward less
  enforcement — 9 tests.

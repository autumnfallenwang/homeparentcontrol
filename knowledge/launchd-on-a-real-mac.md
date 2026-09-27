---
name: launchd-on-a-real-mac
description: Seven macOS/launchd facts the first on-hardware run hit — setenv, systemsetup, bootstrap EIO, payload plists, screen lock, os_log
metadata:
  type: reference
---

Verified on the parent's MacBook Air, macOS 26.6.2, 2026-09-22 — the first time the agent ran under
launchd. Each one cost a round trip, and none is visible to a test that calls the API directly
([[walk-the-flow-not-the-endpoints]]). Decisions that followed are in ADR 0010.

1. **`sudo launchctl setenv X Y` fails in the system domain:** `Could not set environment: 150:
   Operation not permitted while System Integrity Protection is engaged`. Configuration for a
   LaunchDaemon cannot come from `setenv`.
2. **A plist in the pkg payload is reinstalled on every upgrade.** Anything edited into
   `/Library/LaunchDaemons/*.plist` after install is silently reset by the next `installer -pkg`.
   Mutable configuration belongs under `/var/db/homeparentcontrol` (e.g. `base_url`).
3. **`sudo systemsetup -setremotelogin on` needs Full Disk Access** for the *terminal app*, even under
   sudo: `Turning Remote Login on or off requires Full Disk Access privileges`. Use System Settings →
   General → Sharing → Remote Login. (`-getremotelogin` works under sudo; unprivileged it says
   `You need administrator access`.)
4. **`launchctl bootout` returns before the process has exited.** Bootstrapping straight after gives
   `Bootstrap failed: 5: Input/output error`. Poll `launchctl print system/<label>` until it fails,
   then bootstrap. `kickstart -k` restarts the process but does **not** re-read the plist.
   ⚠️ **The pkg's own `postinstall` had this race** behind `|| true`: a first install worked
   (nothing loaded), and every reinstall — including every supervisor-driven upgrade — left the
   enforcer and sync unloaded, silently. Caught 2026-09-26 by installing twice in a row, which is
   the only way to exercise the upgrade path on purpose.
5. **`pmset displaysleepnow` only locks if the user's screen-lock delay is `immediate`.** Check with
   `sysadminctl -screenLock status` as that user; it was `14400 seconds` on this Mac, at which a
   mouse wiggle brings the desktop straight back. Setting it needs `-password -` (a bare
   `sysadminctl -screenLock immediate` answers `Password is required!`). Open decision: PUNCHLIST.
6. **This agent writes nothing to os_log** — no `os_log`, no `Logger`. `log stream --predicate
   'process == "hpc-enforcerd"'` shows nothing and looks like a dead agent. The record is the spool
   (`spool/enforcer.ndjson`, renamed every tick — use `tail -F`), `enforcer.health`, `sync.health`
   and each job's `StandardErrorPath`. `agent/scripts/watch.sh` shows all of them.
7. **Before enrolment the daemon has no other voice.** Nothing reaches the control plane without a
   credential, so every pre-enrolment state must land in `sync.health` and stderr — a missing
   `sync.health` is also what the supervisor reads as a dead sync daemon.

**How to apply:** before writing an on-Mac procedure, check each command against this list; and
when a command "succeeds" silently on a Mac, confirm the effect rather than the exit status.

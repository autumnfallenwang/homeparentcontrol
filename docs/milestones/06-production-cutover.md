---
name: 06-production-cutover
status: planned
opened: 2026-09-18
---

# Milestone 06 — Production cutover

Put it on her Mac and trust it. Covers **phase 6** of
[`../design-decisions.md`](../design-decisions.md) §9 plus the one test that development
deliberately deferred.

## Scope

The single real end-to-end shutdown run · pinning the mini to macOS 26.x · the real install ·
shadow mode and the soak (§6.5) · tripwire surfacing · `away_until` · the D.2 adapter once the owner
picks a sink.

## Exit criteria

- [ ] ⚠️ **One scheduled end-to-end on the Mac mini with the real enforcement backend** — warn, lock,
      grace, actual power-off. This is the one line development could not exercise
- [ ] Mini pinned to 26.x with automatic major updates off
- [ ] Agent installed via the real `.pkg` path, surviving a reboot, verified in `sfltool dumpbtm`
- [ ] `xattr -r` on the install tree shows **no `com.apple.quarantine`** (a quarantined non-notarized
      Mach-O is SIGKILLed silently, and macOS 27 will not load a quarantined `.plist`)
- [ ] Shadow mode soak: ≥24 h and ≥1 bedtime window with zero unexplained divergence
- [ ] A real bedtime enforced correctly, observed
- [ ] The parent can grant an override on a real evening and it lands

## Traps to clear deliberately

- ⚠️ **`sudo killall shutdown` aborts a scheduled `shutdown -h +N`.** Have it ready before the first
  real run — that is what made POC 1's power-off testing safe.
- ⚠️ **macOS 27 shipped 2026-09-14 and is entirely untested.** Every empirical finding in this project
  is 26.6.2, and the version-fragile ones — TCC reach, `CGWindowList` redaction, BTM disposition — are
  exactly the ones carrying the main conclusions. **Do not accept the upgrade before re-verifying.**
- ⚠️ **Remote Login must stay enabled on the mini**, and the schema must remain unable to express
  disabling it. Under `shutdown` there is no remote recovery path at all.
- **Ship via tarball or rsync, never `.zip`** — `unzip` and `ditto -x -k` propagate quarantine;
  `tar` and `rsync` do not. Verified on this hardware.
- **Tell her it exists, or don't — but not for technical reasons.** Protection comes from account
  privileges, not secrecy (POC 1 §6). A visible countdown costs nothing technically. That is a
  parenting call, not an engineering one.

## Out of scope

The offline override card (deferred — ADR 0007) · richer monitoring tiers (ADR 0005) · anything
requiring the paid Apple Developer Program.

## Progress

- 2026-09-18: Opened.

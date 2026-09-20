---
name: 06-production-cutover
status: awaiting-verification
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

⛔ **Every one of these is an observation on hardware, and none can be made
from a coding session.** What could be built for them has been: shadow mode,
the real install path, and a worked procedure for each.
[`../../agent/scripts/cutover.md`](../../agent/scripts/cutover.md).

- [ ] ⚠️ **One scheduled end-to-end on the Mac mini with the real enforcement backend** — warn,
      lock, grace, actual power-off. **The one line development could not exercise**, and still
      the only untested claim in the ladder. Procedure, expected output and three named failure
      modes in `cutover.md` §3, with `sudo killall shutdown` as the abort.
- [ ] **Mini pinned to 26.x with automatic major updates off** — `cutover.md` §1. ⚠️ macOS 27
      shipped 2026-09-14 and every finding in this project is 26.6.2.
- [ ] **Agent installed via the real `.pkg` path, surviving a reboot, verified in
      `sfltool dumpbtm`** — `agent/scripts/install.sh` does the install and checks; the reboot and
      the BTM reading are the owner's.
- [x] **`xattr -r` shows no `com.apple.quarantine`** — ✅ *mechanised*, and it now blocks the
      install rather than being a thing to remember. `install.sh` refuses to proceed if the pkg
      or any installed file carries the flag. Re-verified on this hardware 2026-09-20 that `tar`
      does **not** propagate quarantine while `unzip` and `ditto -x -k` **do**. The observation on
      the real tree still belongs to the install run.
- [ ] **Shadow mode soak: ≥24 h and ≥1 bedtime window with zero unexplained divergence** — the
      mechanism now exists on both sides (it did not before): the agent shadows, the control plane
      diffs, `GET /devices/:id/soak` reports. Running one needs a day and a Mac.
- [ ] **A real bedtime enforced correctly, observed**
- [ ] **The parent can grant an override on a real evening and it lands**

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

## ★ What was actually built here

**Shadow mode (§6.5)** was the last unbuilt code in the project, and it is
the only path that deliberately does not enforce. The spec describes it in a
paragraph; implementing it safely took four properties, and the first is not
in the spec:

1. ⏰ **A hard deadline, baked in at entry.** §6.5 makes promotion automatic
   on soak criteria. Criteria can only end a soak EARLY — nothing extends
   one. If the promotion logic breaks, or the criteria can never be met (a
   child away for a week means no bedtime window ever completes), shadow
   expires anyway and the agent enforces. **A soak that silently never
   finishes is a Mac that silently never locks, and it looks exactly like
   everything working.**
2. 🔒 **Entered only by the supervisor, at install, keyed to a version.** A
   runtime "do not enforce" switch on a machine where the child has admin is
   lever #1 wearing a lab coat ([[enforcement-invariant]]).
3. 🔁 **Never re-entered for a version that already soaked**, or reinstalling
   the agent buys another unenforced day, every time.
4. 📣 **Loud every tick**, and the UI says "is NOT enforcing bedtime" in
   those words — above the health line, because a device can be perfectly
   HEALTHY and still not be enforcing tonight.

Every unreadable, truncated, wrong-shaped, wrong-versioned or hand-edited
marker resolves to ENFORCING. 29 tests, including an exhaustive sweep
proving the window cannot outlive its maximum under any input, and a control
test proving a well-formed marker really does shadow — without which the
other twelve would pass vacuously.

⚠️ **Shadow decisions are stored but deliberately NOT projected into
`enforcement_log`.** That table is "what actually happened" — the thing a
parent reads when they ask *but what actually happened?* A decision that was
deliberately not carried out is a different kind of fact, and mixing the two
would corrupt the one record the product is built on.

⚠️ **The 20 lines that wire shadow into the enforcer's tick cannot be tested
without root**, and they are the lines that decide whether a Mac locks
tonight. **V-SHADOW-1** covers them, and its second half — *does it start
enforcing again?* — matters more than its first.

## Out of scope

The offline override card (deferred — ADR 0007) · richer monitoring tiers (ADR 0005) · anything
requiring the paid Apple Developer Program.

## Progress

- 2026-09-18: Opened.
- 2026-09-20: **Shadow mode**, both halves, plus `install.sh` and
  `agent/scripts/cutover.md`. New verification: **V-SHADOW-1**.
- 2026-09-20: **`awaiting-verification`.** No code left. Every remaining exit criterion is an
  observation on the Mac mini — including the one the whole build deferred, a real power-off.

## ⛔ What is left

One session on the mini, in the order `cutover.md` gives:

| | Needs |
|---|---|
| Pin macOS 26.x | the mini |
| `install.sh`, then reboot, then `sfltool dumpbtm` | the mini + sudo |
| ⚠️ The real power-off run | the mini, and a willingness to power it off |
| V-SHADOW-1 | the mini + sudo |
| A 24 h soak | a day |
| A real bedtime, and a real override | an evening, and someone to ask |

Plus, still open from earlier milestones and unchanged by this one: the
V-series (M2/M3), V-PKG-1, V-SAMPLE-1/2, the four cluster steps (M5), and
**C6** — which is the only item in the whole project blocked on a decision
rather than on time.

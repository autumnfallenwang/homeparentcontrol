# homeparentcontrol — Needs

**Date:** 2026-09-18
**Status:** agreed with owner. This supersedes the requirement assumptions carried inside
POC 1's `findings.md`, which were the *PoC author's* reading and were never confirmed.

**Source tags used throughout:**

| Tag | Meaning |
|---|---|
| **[Owner]** | Stated directly by the owner |
| **[POC1]** | From POC 1 findings — **not owner-confirmed**, listed only where relevant |
| **[Inferred]** | Inferred from the owner's existing repos and conventions; unconfirmed |

---

## 1. Purpose

A self-hosted parental control system for managing a child's screen time at home:
enforce rules on the child's Mac, and give the parent a UI to set those rules and see
what happened. **[Owner]**

---

## 2. Settled needs

### P0 — Core

| # | Need | Source |
|---|---|---|
| P0.1 | Enforce screen-time rules on the child's Mac mini (Apple Silicon M4) | **[Owner]** |
| P0.2 | Runs in the background; auto-starts at boot | **[Owner]** |
| P0.3 | **No kid-facing UI on the target.** No management or viewing surface for the child. *This is about denying an interaction surface, not about secrecy* | **[Owner]** |
| P0.4 | **Parent UI** to edit rules, monitor, and view reports, from the parent's own device | **[Owner]** |

> **P0.3 note.** POC 1 read "no UI" as "she shouldn't know it exists" and then spent §6
> disproving that obscurity helps. That was a misreading — secrecy was never the goal, so
> §6's conclusion costs nothing here.

### P1 — The four pillars

The owner's own framing, in the owner's order. **[Owner]**

| # | Pillar | State |
|---|---|---|
| P1.1 | **Rules** | Undefined beyond a single bedtime window. Depth deferred — see §3 |
| P1.2 | **Notification** — warn before enforcement | ✅ Solved in POC 1 (banner + modal, DND-proof) |
| P1.3 | **Enforcement** — "finally shutdown" | ✅ Mechanism proven. Default action **deferred** — see §3 |
| P1.4 | **Auto monitoring and reporting** | ❌ Unexplored. Payload deliberately deferred; **transport is a need now** |
| P1.5 | **Parent override** — grant extra time for a situation | ⚠️ **Added 2026-09-18.** Mechanism open — see below |

#### P1.5 — Parent override *(added 2026-09-18)* **[Owner]**

> "parents should have a code or something to break some of the rules like give extra
> sometime based on certain situation … either a temporary code to her to let her fill in,
> or an easy one time permission from parent end … she doesn't need send request from her
> end since nothing UI from her end, she can just ask for approve personally"

**Settled by this statement:**

- The override is **parent-initiated only**. There is **no request flow from the child** — she
  asks in person, out of band. This keeps **P0.3** intact.
- Two acceptable mechanisms, not yet chosen:
  **(a)** a **temporary code** the parent gives her verbally, which she types on the target;
  **(b)** a **one-click grant** from the parent UI that the agent picks up.
- An override is a **time-bounded relaxation**, never a stop. T4's contract already carries the
  right primitive: every relaxation requires a mandatory `expires_at`, and the protocol has no
  "stop enforcing" verb.

**Open design questions** — carried to research track **T8**:

1. **Mechanism (b) needs the network; mechanism (a) need not.** Given **O.1** (fail-closed on
   knowledge — a cached policy enforces indefinitely while the server is unreachable), a
   network-only override fails exactly when the network does. **An offline path is likely
   required**, which favours (a) or both.
2. **Where does the code prompt appear**, given she has no UI and cannot request one? Candidate:
   ride on the warning dialog that already appears at T-30/15/5/1 — zero new surface.
3. **She has admin (AR.1).** Any locally-held override secret is readable by her. What is the
   honest limit, and does AR.1 cover it?

This also resolves POC 1 §9.1, which raised parent override as an open question and argued a
system with no legitimate escape hatch is the kind people work around.

### P2 — Architecture and transport

| # | Need | Source |
|---|---|---|
| P2.1 | Agent on the target sends information to an inner server (k3s on `aaron-desktop-arch`) | **[Owner]** |
| P2.2 | Both ends are on the inner network with mutual reachability — no NAT traversal, no relay | **[Owner]** |
| P2.3 | Enforcement stays **native macOS** (LaunchDaemon, `osascript`, `asuser` bridge). Architecture choice must not disturb this | **[Owner]** |
| P2.4 | **One child, one Mac now — extensible to more without a rewrite.** Chiefly: do not hardcode identity | **[Owner]** |
| P2.5 | Define the **channel and contract** now; let the reported schema evolve later | **[Owner]** |
| P2.6 | **No separate mobile app. Ever.** Every parent-facing surface is the internal web UI reached through a browser on the home network — including from a phone | **[Owner]** — added 2026-09-18 |

> **P2.6 clarification.** Two research outputs referred to "the parent's phone" and neither implies
> an app: (a) **T6** assumed Grafana alerts arrive as a push notification — that was an assumption,
> not a requirement, and a contact point can equally be email, a webhook, or nothing; (b) **T8's
> offline override card** is a **static HTML page in a browser**. Its only real constraint is that
> it must be **saved locally rather than served by the cluster**, since it exists precisely for the
> case where the cluster is unreachable.
>
> ⚠️ **Open question this exposes, folded into D.2:** if the agent dies, does the owner learn about
> it by *pull* (it shows on the dashboard next time they look) or by *push* (email/webhook — still
> no app)? Pull-only is simplest and free, but the heartbeat is then only as reliable as the habit
> of checking.

### P3 — Qualities

| # | Need | Source |
|---|---|---|
| P3.1 | Easy, elegant, consistent | **[Owner]** |
| P3.2 | **Production-shaped ("PRO")** — to the standard set by the owner's k3s-deployed `home*` apps. Observable, versioned, updatable, rollback-able | **[Owner]** |
| P3.3 | Self-hosted. No cloud, no third-party SaaS | **[Inferred]** — every `home*` app is; `teacherease-parent-companion` states "local-only, no accounts, no cloud" |
| P3.4 | Consistent with `home*` conventions: pnpm/turbo → GHCR → Argo CD → k3s | **[Inferred]** from the owner invoking k3s as the standard |

> **On "PRO".** The owner was explicit that k3s is *the standard, not the requirement* —
> a standalone design is not ruled out, but it would have to be standalone **done
> properly**: versioned, observable, updatable. Not a script in a folder.

---

## 3. Deliberately deferred

Not gaps. Decided-to-decide-later, with the trigger recorded.

| # | Decision | Decide when |
|---|---|---|
| D.1 | **Monitoring depth** — time only / + per-app / + window titles and URLs | After Probe T1.1 establishes the permission ceiling |
| D.2 | **Reporting delivery** — dashboard / digest / alerts / on-demand, **and pull-vs-push for agent-death alerts** (see P2.6) | After the transport exists |
| D.3 | **Shutdown vs. lock** as default enforcement | After POC 2 |
| D.4 | **Bedtime window vs. daily budget** rules semantics | After POC 2 |

> D.1 and D.2 are safe to defer **because P2.5 holds**: get the channel right and adding
> fields later is a migration, not a redesign. D.3 and D.4 are genuinely open.

---

## 4. Still open — nobody has decided these

| # | Question | Why it matters |
|---|---|---|
| O.1 | **Fail-open or fail-closed?** Agent crashes or policy is unreadable at 21:30 — does she keep using it, or does it lock? | Safety-critical. Undecided in every document so far |
| O.2 | Does "from my end" ever mean **away from home**? | Both candidate shapes are LAN-scoped as described |
| O.3 | Paid **Apple Developer account**? | Gates the Swift notification bundle and signed installers |
| O.4 | Timeline — term deadline or evenings-and-weekends? | Sets how much of the PRO surface is worth building up front |

---

## 5. De-scoped

| Item | Why |
|---|---|
| **MDM / Declarative Device Management** | Exists to defeat capable adversaries. See §6 — not this threat model. Cost/benefit, not feasibility |
| **Reinstall survivability** | Someone who cannot stop an auto-starting terminal app is not reinstalling macOS |
| **Heavy tamper resistance** | Nice-to-have. See §6 |
| **Config-file-only architecture** (no UI, SSH-edited) | Eliminated by P0.4 |
| **Non-Mac devices** (her phone, iPad) | Out of scope, per POC 1 §6 and unchallenged since. ⚠️ *Does mean the control is evadable by switching device* |
| **Apple Screen Time as the primary mechanism** | Cannot power off, cannot report the way the owner wants, no parent UI of the owner's own. **Retained as an optional complementary layer** — POC 1 §9.3 |

---

## 6. Assumptions and accepted risks

### AR.1 — Low adversarial threat *(owner's risk acceptance)*

> "would be best to if not shutable, but this can be tolerable since my kids is not
> capable to stop a terminal app which auto start even with admin account" — **[Owner]**

**This overturns POC 1's central claim.** POC 1 §6 concluded the daemon is "exactly as
strong as her account privileges, and not one bit stronger", and built its entire tamper
analysis on a non-admin account. The owner's assessment is that the child cannot defeat
it regardless.

**Consequences:** tamper resistance → nice-to-have. Non-admin account → defence-in-depth
rather than load-bearing. Reinstall survivability → non-need. MDM → unjustifiable.

**This is a judgement about capability, not a technical fact.** Re-open if the child's
capability changes — the tell would be any attempt to interfere with the agent at all.

### AR.2 — Both hosts share a trusted LAN

Mutual reachability assumed. Revisit if the target ever moves off the home network.

### AR.3 — Transparency is not a requirement either way

POC 1 §6 established that protection comes from privileges, not secrecy, so a visible
countdown costs nothing technically. Whether to tell the child is the owner's call as a
parent, and is **not** a technical constraint in either direction.

---

## 7. What changed versus POC 1

| POC 1 assumed | Now |
|---|---|
| "Terminal-only with no UI so she won't learn to shut it down" | Wrong reading. No-UI means **no interaction surface for the child**; secrecy was never the goal |
| Protection rests on a non-admin account | Superseded by **AR.1** — owner assesses the threat as low regardless |
| `ACTION=lock` recommended over `shutdown` | **Still open (D.3).** POC 1's reasoning stands on its merits, owner has not ruled |
| Single bedtime window | Insufficient. Rules depth open (D.4) |
| Standalone daemon, no server | **Superseded.** Agent + inner-network control plane, with a parent UI |
| Monitoring and reporting untouched | Now a first-class pillar (P1.4) |

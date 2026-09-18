# POC 2 — Research plan

**Date:** 2026-09-18
**Input:** [`requirements.md`](../requirements.md) · POC 1 findings at `~/Deloitte/SSO_SLO_TEST/POC_091726_2/findings.md`
**Output:** [`poc2-findings.md`](./poc2-findings.md) → then unblock `devkit-init`

---

## 1. Goal

POC 1 proved we can **enforce**. POC 2 must settle **how the system is built and
operated** — the contract between agent and control plane, the agent's runtime and
lifecycle, and the ceiling on what can be observed.

**The architecture question is largely closed before this round starts.** The owner
described it directly: an agent on the target sending to an inner server on k3s, agent-
initiated, over a trusted LAN. What remains is not *which shape* but *how that shape is
built properly*.

### Scope narrowing versus the earlier draft

An earlier version of this plan enumerated seven candidate architectures and planned an
elimination tournament. That is no longer the work. Needs-gathering closed it:

- P0.4 (parent UI) eliminated the config-file-only design
- AR.1 (low adversarial threat) eliminated MDM on cost/benefit
- P2.1 and P2.2 selected the agent + inner-server shape outright

**What survives as a real question** is whether the agent should care where its control
plane lives. See H1 below.

---

## 2. Working hypotheses

Stated so they can be falsified rather than assumed.

**H1 — Location transparency.** *The agent should not care whether its control plane is
on `localhost` or in the cluster.* If true, "on-box UI" and "k3s control plane" stop
being rival architectures and become one architecture with a config value — buildable
today without cluster access, deployable to k3s later with no rewrite. Scores on every
owner criterion at once, so it deserves a real attempt to break it.

**H2 — Polling beats pushing here.** POC 1's daemon already ticks every 60s and re-reads
config each tick. Polling rides on tested machinery and needs no inbound listener on the
child's Mac. Pushing buys ≤60s of latency for a new component, a stable address, and an
open port on the one machine least suited to it. *Falsify by finding a requirement that
genuinely needs sub-minute latency.*

**H3 — Telemetry splits at the TCC line.** App-level usage is obtainable permission-free;
window titles and URLs are gated behind Screen Recording / Accessibility. If true, the
honest product is **time governance, not activity surveillance** — a smaller and cleaner
thing to build.

**H4 — 80/20 risk.** The control plane is a standard `home*` app; essentially all novel
risk sits in the agent and the contract. Effort should follow the risk, not the volume.

---

## 3. Tracks

Each probe states a falsifiable question, a method, and an exit criterion.
**Method key:** 🖥️ empirical on the M4 · 🌐 web research · ✏️ design

### T1 — Target capability ceiling ⚠️ critical path

*The only track that can invalidate the others. Gates D.1 (monitoring depth).*

| # | Question | Method |
|---|---|---|
| T1.1 | Foreground app identity without a TCC prompt? `lsappinfo`, System Events, `NSWorkspace` — tested **as the user and from the root daemon via the `asuser` bridge** | 🖥️ |
| T1.2 | Does root bypass TCC? (expect **no** — verify, do not assume) | 🖥️ |
| T1.3 | Apple's own Screen Time data — readable, at what permission cost? `knowledgeC.db` | 🖥️🌐 |
| T1.4 | Window titles / browser URLs — which permission tier? | 🖥️🌐 |
| T1.5 | Idle vs. merely-logged-in — `ioreg -c IOHIDSystem` → `HIDIdleTime` | 🖥️ |
| T1.6 | Power / session / login events — `pmset -g log`, `log show`, `last` | 🖥️ |
| T1.7 | Can a TCC grant be given **once at install** and survive, for a headless daemon? | 🖥️🌐 |

**Exit:** a table of *(signal → permission required → grantable at install → verified command)*. Settles **H3** and unblocks **D.1**.

### T2 — Agent runtime and language

| # | Question | Method |
|---|---|---|
| T2.1 | bash vs. Swift vs. Go vs. Python for the agent — against maintainability, the `home*` conventions, and T3's update story | 🌐✏️ |
| T2.2 | Does a signed Swift bundle with `UNUserNotificationCenter` deliver **Time Sensitive** through Focus modes? (POC 1 §4's loose end) | 🌐🖥️ |
| T2.3 | Signing and notarization — ad-hoc vs. Developer ID, for a bundle *and* a `.pkg`. **Concrete cost.** | 🌐 |

**Exit:** language recommendation with rationale; go/no-go on the Swift bundle with its price attached. Feeds open question **O.3**.

### T3 — Agent lifecycle and operability *(the real "PRO" test)*

*"Production-shaped" mostly means **operable**. This is where an agent on a Mac is weakest by default and can be made strong deliberately.*

| # | Question | Method |
|---|---|---|
| T3.1 | **How does v1.1 reach the mini?** Signed `.pkg`, Homebrew tap, self-updater, or something else | 🌐 |
| T3.2 | Rollback — how does a bad agent version get undone remotely? | 🌐✏️ |
| T3.3 | Config and secret delivery and rotation to the target. Sealed Secrets covers the cluster; the Mac has no equivalent | 🌐✏️ |
| T3.4 | What does "release" mean for something that isn't a container? CI/CD shape alongside the GHCR → Argo CD chain | ✏️ |
| T3.5 | **Blast radius** — a bad policy push must not brick her machine. POC 1 §5.3: the enforcement path is where both bugs were | ✏️ |

**Exit:** a deployment and update design that stands next to the `home*` GitOps chain without embarrassment.

### T4 — Agent ↔ control plane contract

*The highest-value design artefact of this round (**H4**).*

| # | Question | Method |
|---|---|---|
| T4.1 | Protocol and endpoints — poll cadence, payload shape, **designed for schema evolution** (P2.5) | ✏️ |
| T4.2 | Agent identity and authentication. `homecal` already has service accounts and `better-auth` — reuse or not? | 🌐✏️ |
| T4.3 | Store-and-forward when the server is unreachable — **and proof enforcement is unaffected** | ✏️🖥️ |
| T4.4 | **Fail-open or fail-closed** (open question **O.1**) — plus clock skew, timezone, DST | ✏️ |
| T4.5 | Heartbeat — how does the parent learn the agent has gone silent? | ✏️ |

**Exit:** a written contract with endpoints, auth, cadence, and a **failure matrix**: every link down, one row each, stating what still works and what the parent sees. Settles **H1** and **H2**.

### T5 — Control plane design

| # | Question | Method |
|---|---|---|
| T5.1 | What is genuinely different from a stock `home*` app? Deltas only — do not redesign the 80% | ✏️ |
| T5.2 | Rules data model, extensible to N children and N devices without a rewrite (P2.4) | ✏️ |
| T5.3 | Telemetry storage, retention, and aggregation for reporting | ✏️ |

**Exit:** a delta list against the `home*` template, not a from-scratch design.

### T6 — Observability

| # | Question | Method |
|---|---|---|
| T6.1 | Can the agent ship structured logs into the existing Loki/Grafana? Does Grafana Alloy run on macOS? | 🌐 |
| T6.2 | What does the parent see when the agent is unhealthy, as opposed to when the child is simply asleep? | ✏️ |

**Exit:** an observability design. ⚠️ **Deferred verification** — needs cluster access to confirm.

### T7 — Prior art and the native layer

| # | Question | Method |
|---|---|---|
| T7.1 | Open-source parental-control and macOS device agents — what to borrow, what failed | 🌐 |
| T7.2 | Screen Time / Family Sharing in 2026 — capability ceiling, and any conflict with our lock/shutdown path | 🌐🖥️ |

**Exit:** a borrow/avoid list, and a recommendation on whether to run Screen Time as a complementary layer (POC 1 §9.3).

---

## 4. Parallelisation

**T1 runs first and alone.** It is the only track whose outcome can force a rewrite of
the others, and T2/T5 depend on its result.

Once T1 reports, these are mutually independent and parallelisable:

```
T1 (gate) ──┬── T2  agent runtime + signing
            ├── T3  lifecycle + update path
            ├── T4  contract + failure semantics
            ├── T6  observability
            └── T7  prior art + Screen Time

                    T5 (control plane) — after T1 and T4
```

---

## 5. Non-goals

- Productionising POC 1's `bedtime.sh`
- Building the parent UI
- Anything needing live k3s access — design and research only, marked for later verification
- MDM, kernel extensions, Intel Mac support
- Re-litigating the architecture shape (§1) or the de-scoped items (`needs.md` §5)

---

## 6. Deliverable

`poc2-findings.md`, in POC 1's style: verdict first, a table of what was verified and
how, ASCII diagrams for workflow and traffic, honest limits, and open questions. Then
re-run `devkit-init` with real answers.

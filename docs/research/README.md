# Research record

How this project's design was arrived at. **This is history, not instruction** — for what to build,
read [`../design-decisions.md`](../design-decisions.md).

## Reading order

| File | What it is |
|---|---|
| [`../requirements.md`](../requirements.md) | The agreed needs, every line tagged **[Owner]** / **[POC1]** / **[Inferred]** so it is always clear who asserted what |
| [`poc2-plan.md`](./poc2-plan.md) | The research plan — 8 tracks, 4 falsifiable hypotheses, method and exit criterion per probe |
| [`poc2-findings.md`](./poc2-findings.md) | **The authoritative empirical record.** Verified-vs-inferred table, the audit, hypothesis outcomes, cross-track conflicts |
| [`tracks/`](./tracks/) | Full detail per research track — ~8,800 lines |
| [`../design-decisions.md`](../design-decisions.md) | The corrected, buildable spec. **Supersedes the tracks wherever they disagree** |

## Prior work

**POC 1** (2026-09-17) lives outside this repo at `~/Deloitte/SSO_SLO_TEST/POC_091726_2/` —
`findings.md` plus a working bash daemon. It proved enforcement is achievable on macOS 26 with a root
LaunchDaemon and `osascript`, no MDM or kernel extension. Its design survives; its conclusions about
*why* were corrected by POC 2 in several places.

## The tracks

| Track | Subject |
|---|---|
| [T1](./tracks/T1-telemetry-ceiling.md) | What can be observed on the target, and at what permission cost |
| [T2](./tracks/T2-runtime-notifications-signing.md) | Agent runtime, notifications, code signing, the $99 question |
| [T3](./tracks/T3-lifecycle-operability.md) | Install, update, rollback, secrets — the "production-shaped" gap |
| [T4](./tracks/T4-contract.md) | The agent↔server contract, failure semantics, fail-open vs fail-closed |
| [T5](./tracks/T5-control-plane.md) | Schema, retention, enrolment, deltas against the `home*` template |
| [T6](./tracks/T6-observability.md) | Logging path and the health/heartbeat design |
| [T7](./tracks/T7-prior-art-screentime.md) | Prior art, and Screen Time's real capability ceiling |
| [T8](./tracks/T8-parent-override.md) | Parent override mechanism |

## Two things this round cost real effort to learn

**1. Documentation is a hypothesis.** Six load-bearing claims were audited against direct testing;
**five were wrong, partly wrong, or unverifiable.** One had three-track agreement and cited Apple DTS:
that macOS 26's Background Task Management would leave a bash-entry LaunchDaemon `disallowed` after
reboot. It does not — both a bash and an ad-hoc Mach-O daemon returned `[enabled, allowed]` and ran.
That single test reversed the round's central conclusion and put bash back on the table.

> **Standing rule:** a claim about observable macOS behaviour is not settled until it has been observed.
> Cross-agent agreement is not evidence.

**2. Every track independently invented a way to turn enforcement off.** Five separate "stop enforcing"
levers appeared across four tracks — a GitOps flag, credential revocation, policy TTL expiry, a
dead-man's switch that failed open, and a rate breaker whose penalty was disabling enforcement (it would
have tripped on the first ordinary bedtime). Each was locally reasonable. All were rejected. See
**Invariant E** in [`../design-decisions.md`](../design-decisions.md).

## Verification scripts

[`../../tools/verify/`](../../tools/verify/) holds the throwaway LaunchDaemon probes used to settle the
BTM, SIGTERM-at-shutdown and `CFUserNotification`-from-daemon questions. `uninstall.sh` removes them.

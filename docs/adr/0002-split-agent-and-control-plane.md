# 0002 — Autonomous agent on the target, control plane on k3s

- **Status:** accepted
- **Date:** 2026-09-18
- **Deciders:** project owner (captured during POC 2)

## Context

The system has to do two things that pull against each other. It must **enforce** rules on a child's
Mac mini using native macOS mechanisms (**P0.1**, **P0.2**, **P2.3**), and it must give the parent a
UI on their own device to author those rules and read reports (**P0.4**, **P1.4**, **P2.6**) — while
giving the child no management or viewing surface whatsoever (**P0.3**). Both ends sit on a trusted
LAN with mutual reachability, so no relay and no NAT traversal (**P2.2**, **AR.2**), and the owner
already runs four `home*` apps on a single-node k3s cluster he wants this to match (**P3.2**, **P3.4**).

Three findings from POC 2 narrow the shape more than any preference does:

- ✅ **There is no supported macOS API for this.** FamilyControls / ManagedSettings / DeviceActivity
  are iOS and iPadOS only; Catalyst fails at runtime. The custom daemon is not a workaround — it is
  the only mechanism ([T7](../research/tracks/T7-prior-art-screentime.md)).
- ✅ **Screen Time cannot power off a Mac.** Apple put `ShutDownDevice` in the *MDM* protocol, not in
  Screen Time, which also cannot lock, log out, export data, or run a custom action on limit-hit.
- ⚖️ **Bedtime cannot depend on the cluster being up.** A k3s node reboot at 21:29 must not buy an
  extra evening. This is the constraint that decides the topology.

## Decision

**An autonomous agent on the child's Mac, and a control plane in k3s. The agent decides and acts;
the server only publishes what the rules are and listens to what happened.** Traffic is
agent-initiated and outbound only — the Mac never listens on a port (**P2.1**, A.1).

Inside the agent, the load-bearing split is between the component that enforces and the component
that talks to the network: **`enforcerd` opens no socket, ever, and links no HTTP client** (A.3).
`syncd` is the only component that touches the API (A.4). The shipped process model adds two more
launchd jobs that carry no enforcement decision and no network traffic — a `supervisor` that installs
and rolls back agent packages, and a periodic `deadfall` one-shot that re-evaluates the full
predicate if both main daemons are dead.

| Rejected | Why |
|---|---|
| **Config-file-only, SSH-edited, no UI** | Eliminated outright by **P0.4** — the parent wants a UI on her own device, not a text editor over SSH ([requirements §5](../requirements.md)) |
| **Thin agent that asks the server what to do each tick** | ⚖️ Enforcement would then be exactly as available as the cluster. The single hardest requirement is that bedtime survives the server being down |
| **Server push (the server tells the Mac to lock)** | ⚖️ Needs an inbound listener, a stable address and a TLS server cert **on the one machine least suited to having one**, and inverts the dependency the offline requirement exists to protect. See [0003](./0003-polling-and-desired-state.md) |
| **Self-hosted MDM (NanoMDM / MicroMDM)** | It exists to defeat capable adversaries, which is not this threat model (**AR.1**, [requirements §5](../requirements.md)). 📄 T7 adds a second, independent barrier: an APNs MDM push certificate needs the ~$300/yr Enterprise Program, which requires a legal entity with a D-U-N-S number, and the community workaround is called *"of questionable legality"* by MicroMDM's own docs. **Recorded honestly: the owner's reason is cost/benefit; T7's reason is procedural reach. Both hold** |
| **Apple Screen Time as the primary mechanism** | ✅ Cannot power off; ✅ no supported macOS API to drive it; no custom reporting and no parent UI of the owner's own. **Retained as an optional complementary layer only** — Screen Time takes web filtering and Ask-to-Buy, the daemon owns the clock |

## Consequences

**Positive**

- **"Works with the server down" becomes a structural property, not a promise in a comment.** It is
  assertable in CI and at runtime: `lsof` on the enforcer must report zero TCP/UDP, and `otool -L`
  must show no HTTP client linked. A careless change cannot regress it without failing a test.
- The control plane is the fifth app in an established pattern. POC 2's schema track found the
  deltas against the `home*` template fit a single 28-row table, and the existing `5Gi` PVC, the
  in-process scheduler pattern and the GHCR→Argo chain all carry over unchanged.
- No inbound port, no relay, no NAT traversal, no mTLS tax, and nothing about the design changes if
  the control plane later runs on `localhost` instead of in the cluster — the base URL is config.
- A failing `syncd` degrades reporting and rule updates. It never degrades enforcement.

**Negative**

- **Two deployment vehicles.** The control plane rides pnpm/turbo → GHCR → Argo CD; the agent needs
  its own `.pkg`, its own GitHub Releases path, and is bolted to the GitOps chain by a version pin
  rather than reconciled directly.
- **Four launchd jobs is more moving parts than one script.** POC 1 shipped a single daemon. This is
  a supervisor, a sync daemon, an enforcer and a periodic deadfall, each with its own failure mode.
- **The supervisor is the one component that cannot be rolled back in place.** If a bad supervisor
  ships, remote manageability is lost and recovery is physical. Mitigated by keeping it small,
  enforcement-logic-free, and never self-updating — supervisor bumps are attended.
- Duplicating logic: the deadfall re-implements the window predicate *including overrides*, so a
  holiday night with both daemons dead does not lock at the baseline time. Two places to get right.
- Choosing a custom daemon means owning the maintenance. ⚖️ T7's survey found **no maintained,
  popular open-source macOS parental-control daemon** — every candidate is a 0-star weekend project.

**Open risks**

- ⚠️ **The enforcement-isolation matrix (V1–V9) is unbuilt**, and it is this ADR's central unproven
  claim. Nine injected failures — cluster off, cable out, DNS blackholed, 500s, a 120 s hang,
  `bootout` of `syncd`, a full disk, an unreadable policy, a killed enforcer — must all still lock
  at 21:30. Run it before the sync daemon exists to confuse the result.
- 📄 The MDM procedural barrier is documented, not tested. T7 itself budgets 30 minutes to confirm
  whether an APNs cert is obtainable before the door is treated as closed.
- ⚠️ All macOS findings are 26.6.2. macOS 27 shipped four days before this ADR, with a rewritten
  Screen Time and a Hammerspoon report that the `CGSession` lock path is gone. Pin the Mac to 26.x.

## Notes

- Siblings: [0003](./0003-polling-and-desired-state.md) (why polling, not push) ·
  [0004](./0004-enforcement-invariant.md) (why the enforcer has no off switch) ·
  [0005](./0005-free-tier-telemetry.md) (what the agent is allowed to observe) ·
  [0006](./0006-enforcement-action.md) (what the enforcer actually does).
- Sources: [`poc2-findings.md`](../research/poc2-findings.md) §2 #5/#6, §3 (T4, T7), §4 ·
  [`T4-contract.md`](../research/tracks/T4-contract.md) §3, §3.1 ·
  [`T7-prior-art-screentime.md`](../research/tracks/T7-prior-art-screentime.md) §2.6 ·
  [`requirements.md`](../requirements.md) P0.3–P0.4, P2.1–P2.3, §5 · [`design-decisions.md`](../design-decisions.md) A.1–A.4, §2, §3.1.

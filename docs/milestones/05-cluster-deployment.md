---
name: 05-cluster-deployment
status: planned
opened: 2026-09-18
---

# Milestone 05 — Cluster deployment

⚠️ **Gated on k3s access.** Covers **phase 5** of
[`../design-decisions.md`](../design-decisions.md) §9, plus the 11 cluster verifications owed since
research (§8.3).

Nothing in milestones 01–04 depends on this. When the cluster returns, the agent moves from local to
cluster by changing **one environment variable** — which is hypothesis H1 paying off.

## Scope

Helm chart · `create-cluster-secret.sh` for `POLICY_SIGNING_KEY` · Argo CD Application CR ·
`ARCH_INFRA_TOKEN` · **`bump-arch-infra` made to fail hard** · then the Loki decision, the dashboard,
and the five alert rules provisioned as code.

## Exit criteria

- [ ] Argo CD reconciles the app from the GitOps repo; a tag bump rolls it
- [ ] Agent switches from `localhost` to the cluster by changing one env var, with **no code change**
- [ ] Migrations apply via the Helm pre-upgrade hook
- [ ] **C6 — a test alert demonstrably reaches the parent.** Until this passes, the entire
      observability design is decoration
- [ ] `git revert` rolls back both the app and the pinned agent version

## Traps to clear deliberately

- ⚠️ **`bump-arch-infra` soft-skips with `exit 0`** when the PAT or Application CR is missing — so an
  unwired GitOps chain **looks like a green build**. Make it fail hard (B3, A.22).
- ⚠️ **C2 and C8 before writing a line of Loki code.** If the existing Alloy DaemonSet already scrapes
  pod stdout cluster-wide, there is **no Loki code to write**.
- ⚠️ **C6 last and loudest.** An alert nobody receives is worse than no alert, because it is trusted.
- **X4 — the house ships plain HTTP** on Traefik `.arch.internal`, no `tls:` block. Accepted under
  AR.2, but the agent credential travels in clear on the LAN. Decide deliberately, don't inherit it.
- **Grafana "No Data" is a synthetic alert** that does not inherit notification policies or silences.
  Alert on a presence (`agent_status`), never an absence.
- **Loki's out-of-order window** is `max_chunk_age/2`, default 1 h — the forwarder must rewrite
  timestamps after a long outage rather than dropping lines.

## Out of scope

Real shutdown on the Mac mini (06) · O.2 remote access, unless the owner decides it.

## Progress

- 2026-09-18: Opened, blocked on cluster access.

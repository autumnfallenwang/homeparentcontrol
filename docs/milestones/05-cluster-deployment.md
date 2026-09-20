---
name: 05-cluster-deployment
status: planned
opened: 2026-09-18
---

# Milestone 05 — Cluster deployment

🟢 **No longer blocked — cluster access obtained 2026-09-20.** Covers **phase 5** of
[`../design-decisions.md`](../design-decisions.md) §9, plus the 11 cluster verifications owed since
research (§8.3).

Nothing in milestones 01–04 depends on this. The agent moves from local to cluster by changing
**one environment variable** — hypothesis H1 paying off.

## 🛑 Nothing deploys until this milestone — by decision, not by accident

**Verified 2026-09-20: four independent things block deployment today.** None may be removed before
the app is actually ready.

| Block | State |
|---|---|
| CI has **only a `test` job** — no image build, no GHCR push, no arch-infra bump | ✅ |
| **No `apps/homeparentcontrol.yaml` in `arch-infra`** — Argo does not know the app exists | ✅ |
| **No GHCR packages** | ✅ |
| **No `ARCH_INFRA_TOKEN`** secret on the repo | ✅ |

⚠️ **The Application CR is the LAST thing committed, never the first.** The `root` app-of-apps
recurses `arch-infra/apps/` with **automated sync and prune**, so the CR appearing *is* the deploy.
There is no staging step between "commit the file" and "Argo applies it". Do not add it early to
"get ready".

⚠️ **Commit it with manual sync first.** Omit the `syncPolicy.automated` block on the first commit:
Argo will show the diff and apply nothing. Inspect it, sync once by hand, confirm the pods come up,
*then* add `automated: {prune, selfHeal}` in a second commit. `homework`'s CR has `automated` from
the outset — fine for an app that already worked, wrong for a first deploy. This turns the first
sync from "hope" into "look, then leap".

## First-deploy bootstrap — five one-time steps

**Ongoing deploys are fully automatic** and the chain is proven: `git push` → GHA → GHCR →
`bump-arch-infra` rewrites the tag → the `root` app-of-apps (which recurses `arch-infra/apps/` with
automated sync) reconciles. **`kubectl apply` is never needed, not even for the Application CR.**

But a *new* app needs these once, in order. ⚠️ **Steps 1 and 2 both fail silently and green** — CI
succeeds, nothing reaches the cluster.

- [ ] **1. Commit `apps/homeparentcontrol.yaml` to `arch-infra`.** CI **cannot** create it —
      `bump-arch-infra` only rewrites tags in an existing file and `exit 0`s when it is absent.
      Model it on `apps/homework.yaml`; keep a reviewable copy at `deploy/arch-infra/` in this repo
      (the `homework` convention).
- [ ] **2. Set `ARCH_INFRA_TOKEN`** in this repo's GitHub secrets. Without it the bump job
      soft-skips with `exit 0`.
- [ ] **3. Create the `homeparentcontrol-secrets` cluster Secret** — `DATABASE_URL`,
      `BETTER_AUTH_SECRET`, `POLICY_SIGNING_KEY`. (`homework` has 2 keys, `homecal` 5.)
- [ ] **4. Flip both GHCR packages to public.** Verified 2026-09-20: `homework-api` has **no
      `imagePullSecrets`**, so the cluster pulls anonymously — public is load-bearing. New packages
      default to private, so expect `ImagePullBackOff` on first sync until this is done.
- [ ] **5. Flip `migrate.enabled` false → true** in the Application CR, once step 3 exists.

After these, it is `git push` forever.

> **`arch-infra` must be cloned on the Mac** — step 1 is a commit to a second repo.
> ⚠️ **Always `git pull` before touching it.** Every main build of *any* of the four apps pushes an
> image-tag commit there, so a local clone goes stale within days. This is the one repo where the
> [[read-siblings-via-gh]] rule does **not** apply, because we write to it.

## Scope

Helm chart · `create-cluster-secret.sh` for `POLICY_SIGNING_KEY` · Argo CD Application CR ·
`ARCH_INFRA_TOKEN` · **`bump-arch-infra` made to fail hard** · then the Loki decision, the dashboard,
and the five alert rules provisioned as code.

## Exit criteria

- [ ] Argo CD reconciles the app from the GitOps repo; a tag bump rolls it
- [ ] Agent switches from `localhost` to the cluster by changing one env var, with **no code change**
- [ ] Migrations apply via the Helm pre-upgrade hook
- [ ] ⚠️ **C6 — a test alert demonstrably reaches the parent.** Until this passes, the entire
      observability design is decoration. **Confirmed 2026-09-20 that there is currently NO
      alerting in the cluster at all** — `/etc/grafana/provisioning/alerting/` is empty, no rules,
      no contact points, no notifiers. This is a pre-existing gap: `homework`, `homecal` and
      `homenews` have no alerting either, so any of them could be silently broken right now
- [ ] Loki stream labels read from the live Alloy ConfigMap before writing any LogQL (C8 partial)
- [ ] `git revert` rolls back both the app and the pinned agent version

## Traps to clear deliberately

- ⚠️ **`bump-arch-infra` soft-skips with `exit 0`** when the PAT or Application CR is missing — so an
  unwired GitOps chain **looks like a green build**. Make it fail hard (B3, A.22).
- ✅ **C2 ANSWERED — there is no Loki code to write.** Alloy already scrapes pod stdout cluster-wide
  (`discovery.kubernetes` + `loki.source.kubernetes` + `loki.write`). The control plane writes
  structured JSON to stdout and Alloy collects it. **Delete the forwarder from the plan**, along
  with its auth (C1) and the backfill-rewrite question (C3) — those become Alloy/Loki config
  concerns rather than application code.
- **Expect `OutOfSync but Healthy` on the db StatefulSet** and do not chase it. All three sibling
  apps show it; the drift is `volumeClaimTemplates` + ServerSideApply defaults, and sync reports
  "Succeeded". Chasing it wastes an afternoon.
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

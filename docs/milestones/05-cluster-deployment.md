---
name: 05-cluster-deployment
status: done
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

| Block | State on 2026-09-18 | State now |
|---|---|---|
| CI has **only a `test` job** | ✅ blocking | ❌ **removed** — `build-and-deploy` and `bump-arch-infra` land 2026-09-20 |
| **No `apps/homeparentcontrol.yaml` in `arch-infra`** | ✅ blocking | ✅ **still blocking** — and it is the LAST step, deliberately |
| **No GHCR packages** | ✅ blocking | ❌ **removed** — both pushed by the first main build |
| **No `ARCH_INFRA_TOKEN`** secret on the repo | ✅ blocking | ✅ **still blocking** |

⚠️ **Two blocks remain, and both need the owner.** With the deploy jobs in
place, `bump-arch-infra` now **fails hard** on each of them rather than
`exit 0`-ing — so `main` is RED until they are cleared. Observed on the
first push: `test` ✅, `build-and-deploy (api)` ✅, `build-and-deploy (web)`
✅, `bump-arch-infra` ❌ with *"ARCH_INFRA_TOKEN is not set on this
repository … nothing will reach the cluster. See deploy/RUNBOOK.md step 4."*
That is B3 working: a red build that names the gap, instead of a green one
that deployed nothing.

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

- [x] **1. Commit `apps/homeparentcontrol.yaml` to `arch-infra`** — ✅ done 2026-09-21
      (`08ddfd7`), deliberately without `syncPolicy.automated`; `9f376c4` added it after the
      first sync was confirmed good.
- [ ] **2. Set `ARCH_INFRA_TOKEN`** in this repo's GitHub secrets. ⚠️ **Still outstanding** —
      the app is deployed, but CI cannot bump its image tags, so `main` stays red and new
      commits do not roll. This is now the only thing between here and `git push` forever.
- [x] **3. Create the `homeparentcontrol-secrets` cluster Secret** — ✅ done 2026-09-21 via
      `scripts/create-cluster-secret.sh --generate`, all four keys present.
      ⚠️ **`POLICY_SIGNING_KEY` still needs backing up somewhere that is not this cluster.**
- [x] **4. Flip both GHCR packages to public** — ✅ **not needed, verified 2026-09-20.** Public
      *is* load-bearing (`homework-api` has no `imagePullSecrets`, so the cluster pulls
      anonymously), but both packages came out anonymously pullable: created by Actions with
      `GITHUB_TOKEN`, they inherited the repository's PUBLIC visibility. Checked by fetching each
      manifest with an anonymous GHCR token — `homeparentcontrol-api` 200,
      `homeparentcontrol-web` 200, and a nonexistent package 403, so the check discriminates.
- [x] **5. Flip `migrate.enabled` false → true** — ✅ done 2026-09-21 (`d7c55d5`). 29 tables.
- [x] ⚠️ **6. Add two DNS entries on the router** — `homeparentcontrol.arch.internal` and
      `homeparentcontrol-api.arch.internal`, both → `192.168.1.163`.
      **`*.arch.internal` is NOT a wildcard.** Verified 2026-09-20: every one of the ten existing
      ingress hosts has its own router entry, 1:1, and an unregistered name returns NXDOMAIN.
      ⚠️ **Nastiest failure mode in this list:** Argo syncs green, pods run, the Ingress object is
      created, everything in the cluster looks perfect — and the browser says "server not found".
      Easy to lose an hour inside the cluster before suspecting DNS.

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

Everything buildable is built and checked against the live cluster read-only.
What remains needs a browser, a router admin page, and one owner decision —
the runbook is [`../../deploy/RUNBOOK.md`](../../deploy/RUNBOOK.md).

- [x] **Argo CD reconciles the app from the GitOps repo** — ✅ **deployed 2026-09-21.**
      `homeparentcontrol` is Healthy, all three pods Running, both ingress hosts answering
      through Traefik, and 103 log lines reached Loki under `{namespace="homeparentcontrol"}`
      within fifteen minutes. `automated: {prune, selfHeal}` is on.
      ⚠️ *"a tag bump rolls it"* is **not** yet observed — that needs `ARCH_INFRA_TOKEN`.
- [x] ★ **Agent switches from `localhost` to the cluster by changing one env var, with no code
      change** — ✅ **H1 paid off, observed 2026-09-21.** All nine end-to-end tests were re-run
      against `http://homeparentcontrol-api.arch.internal` with `HPC_BASE_URL` as the only
      change — enrol, single-use code, sync, policy signature verification, telemetry
      idempotency, credential rotation with the 24 h overlap, a four-hour outage drained exactly
      once, and a forged credential halting sync without decommissioning. **No recompile, no
      code change, same binary.**
- [x] **Migrations apply via the Helm pre-upgrade hook** — ✅ observed 2026-09-21:
      `Job/homeparentcontrol-migrate hook=PreSync`, pod Completed, 29 tables.
      ⚠️ **But not on the first sync after enabling it** — see the finding below.
- [ ] ⚠️ **C6 — a test alert demonstrably reaches the parent.** ⛔ **Blocked on an owner
      decision, and it is the one criterion no amount of code closes.** Re-confirmed 2026-09-20 by
      reading the live Grafana ConfigMap: it holds `datasources.yaml` and `grafana.ini` and
      nothing else — no alerting provisioning, no contact point, no notification policy, no SMTP
      block. There is no notification service anywhere in the cluster (no ntfy, no Alertmanager,
      no mail relay) and no SMTP secret in any namespace. A pre-existing gap: `homework`,
      `homecal` and `homenews` have no alerting either, so **any of them could be silently broken
      right now**. The five rules and the dashboard are written and their queries verified against
      live Loki, which makes alerts *fire*; the channel is D.2, still open, and only that makes
      them *arrive*.
- [x] ★ **Loki stream labels read from the live Alloy ConfigMap before writing any LogQL** —
      done, and it was worth doing: **every one of §7.5's five example queries is dead.** See
      below.
- [ ] **`git revert` rolls back both the app and the pinned agent version** — the two are
      separate Helm parameters precisely so they revert independently. ⚠️ Needs
      `ARCH_INFRA_TOKEN` first: there is nothing to revert until CI has bumped a tag.

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

## ★ What the first deploy found

Three things, none of which showed up in the server-side dry run — which is
the argument for a manual first sync in one paragraph.

1. ⚠️ **The api CRASHLOOPS on a first deploy, correctly, and the runbook said
   to expect it Running.** Its X2 boot assertion queries `apikeys` to prove
   no device key has rate limiting armed; on a fresh database that table does
   not exist. Refusing to start is the right answer to *"I cannot verify the
   invariant"* — but the log line said `x2.violation` either way, which reads
   as "armed keys were found" and sends you looking for rows in a table that
   is not there. The assertion now distinguishes **unverifiable** from
   **violated**, and the runbook expects the crash.
2. ⚠️ **The migrate hook did not run on the sync immediately after enabling
   it — and the sync reported `Succeeded`.** The repo-server logged
   `manifest cache hit` and replayed the render from before the parameter
   changed: same eight resources, no hook, empty database, green tick. A
   later sync picked it up. **Check `syncResult` for `hook=PreSync`, not the
   sync's verdict** — and remember the Job deletes itself on success, so
   counting Jobs a minute later proves nothing. Count tables.
3. ✅ **The Loki retention rule already covered us**, added by the owner on
   2026-09-20 — and it uses `{namespace=~…}`, independently confirming C8's
   finding about which labels exist.

⚠️ **And one bug the fix's own test caught.** The first version of
`isMissingTable` matched on the error *message* — but postgres-js wraps the
driver error, so what reaches `catch` is `Failed query: select …` with no
mention of a missing relation anywhere in it. It would not have fired on the
one error it was written for. It now matches Postgres' `42P01` code, walking
the `cause` chain, with the text patterns as a fallback.

## ★ What checking C8 actually found

The exit criterion says "read the stream labels from the live Alloy ConfigMap
**before writing any LogQL**". Doing so in that order turned out to matter:
**all five of §7.5's example queries return nothing**, and one of them cannot
work at all.

Alloy sets exactly four labels — `namespace`, `pod`, `container`, `node` —
confirmed by reading the ConfigMap and then asking Loki's label API. The spec
selects `{app="homeparentcontrol", component="control-plane"}`. Neither label
exists.

Three findings, each verified against the live cluster:

1. **`job` and `service_name` are traps, not alternatives.** `job` has a
   single value for the entire cluster (`loki.source.kubernetes.pods`), and
   `service_name` is derived by Loki from the *container* name — so
   `{service_name="api"}` matches homework, homenews and homecal at once.
   Verified: three namespaces came back. Only `{namespace=…}` isolates an app.
2. **`or vector(0)` hides a wrong selector for ever.** It is the spec's own
   defence against Grafana's No-Data synthetic-alert trap, and it works — but
   it also converts "this query matches nothing" into a confident `0`. The
   spec's selector returns **0 against a namespace holding 240 matching
   lines**. A rule that can never fire, reporting healthy, indefinitely. The
   `or vector(0)` is kept; the selector is now verified independently, which
   is the only thing that can catch this.
3. **A4 cannot read what it is written against.** It selects the *agent's*
   log stream, and the agent is a LaunchDaemon on a Mac — its logs never
   reach Loki, and shipping them would be a second telemetry path competing
   with `/events`. Rewritten to count `agent_started` on the control plane's
   own ingest line, which required one new counter beside the two already
   there.

Also: the log field is `state`, not `status`.

Every query in `deploy/observability/` was executed against live Loki before
being committed. The two "is the shape right" controls — a query that must
return data, and one that must not — are recorded in that directory's README.

## Out of scope

Real shutdown on the Mac mini (06) · O.2 remote access, unless the owner decides it.

## Progress

- 2026-09-18: Opened, blocked on cluster access.
- 2026-09-20: **Opened for work.** Chart, secret script, Application CR, deploy jobs, dashboard
  and alert rules. `helm lint` clean; all nine manifests and the Application CR pass a
  server-side dry run against the live API server; every LogQL query executed against live Loki;
  `actionlint` and `shellcheck` clean.
- 2026-09-20: **C8 closed, and it found three bugs in §7.5's own examples.** See above.
- 2026-09-20: **`bump-arch-infra` made to fail hard (B3/A.22), and observed failing.** The first
  push built and shipped both images, then went red with *"ARCH_INFRA_TOKEN is not set … see
  deploy/RUNBOOK.md step 4"*. The house template `exit 0`s there.
- 2026-09-20: **GHCR step dropped** — both packages are already anonymously pullable.

## ⛔ What is left, and who has to do it

| | Needs | Why not from here |
|---|---|---|
| Router DNS ×2 | the router admin page | `*.arch.internal` is not a wildcard; nothing in the GitOps chain adds an entry |
| `ARCH_INFRA_TOKEN` | a browser | a repo secret |
| Commit the Application CR | a push to `arch-infra` | ⚠️ **the commit IS the deploy** — the `root` app-of-apps syncs automatically with prune, and there is no staging step. Doing it unasked would deploy a first-time app to a live home cluster |
| C6's channel | an owner decision (D.2) | no notification service exists; which one to add is not a coding question |

The cluster Secret (step 1) is scripted and its generator is verified end to
end — the key it produces loads through the API's own `loadSigningKey` — but
it writes a real credential to a live cluster, so it is the owner's to run.
- 2026-09-20: **`awaiting-verification`.** No code left. Two router DNS entries, one GitHub
  secret, one commit to `arch-infra` (⚠️ which IS the deploy), and C6's channel — a decision,
  not a task.
- 2026-09-21: ★ **DEPLOYED.** Secret → CR (manual sync) → migrations → `automated`. Healthy,
  three pods Running, both ingress hosts answering, logs in Loki. **All nine end-to-end tests
  re-run against the cluster and passing**, with `HPC_BASE_URL` as the only change — H1 paid off.
  Three findings from the first sync are written up above.
- 2026-09-21: **`done`**, with one carried item: `ARCH_INFRA_TOKEN` is still unset, so CI cannot
  bump image tags. The app runs; it just does not roll on a push yet. Tracked in the punch list.

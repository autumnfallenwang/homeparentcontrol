# First deploy — the runbook

Ongoing deploys are fully automatic: `git push` → GitHub Actions → GHCR →
`bump-arch-infra` rewrites the tag → the `root` app-of-apps reconciles.
**`kubectl apply` is never needed, not even for the Application CR.**

A *new* app needs the steps below once, in order. They are not all doable
from a coding session: steps 2, 4 and 6 need a browser or a router.

> ⚠️ **Steps 4 and 5 are the dangerous pair, because both fail silently and
> green.** Without `ARCH_INFRA_TOKEN`, or without the Application CR, the
> images build, GHCR fills up, every check passes — and nothing reaches the
> cluster. `bump-arch-infra` in this repo has been changed to **fail hard**
> on both, which is B3/A.22. That means: until you finish step 5, every push
> to `main` will show a red build. That is the design working.

Verified against the live cluster on 2026-09-20 unless marked otherwise.

---

## 0. Before you start

```sh
# The cluster answers, and you are the right user.
ssh aaronwang@192.168.1.163 'uname -n && kubectl get ns'
```

⚠️ The SSH user is `aaronwang`. `~/.ssh/config` has a stale `Host ubuntu`
entry with a different user that does not work.

`arch-infra` must be cloned on the Mac — step 5 is a commit to a second repo.
⚠️ **Always pull before touching it.** Every main build of any of the four
apps pushes an image-tag commit there, so a local clone goes stale in days.
This is the one repo where the "read siblings with `gh api`" rule does not
apply, because we write to it.

---

## 1. Create the cluster Secret

```sh
bash scripts/create-cluster-secret.sh --generate   # writes ./cluster-secrets.env, mode 600
bash scripts/create-cluster-secret.sh              # applies it
```

⚠️ **Back up `POLICY_SIGNING_KEY` immediately, somewhere that is not this
cluster.** It is the Ed25519 key every agent verifies its cached policy
against, the public half is handed to each Mac once at enrolment, and **there
is no rotation channel in the contract**. Replacing it makes every enrolled
device reject every new policy, fall back to last-known-good, and keep
enforcing yesterday's rules indefinitely. Recovering means re-enrolling every
Mac by hand.

### The four keys, and what each is

| Key | What it is |
|---|---|
| `DATABASE_URL` | `postgres://hpc:<password>@homeparentcontrol-db:5432/homeparentcontrol` |
| `POSTGRES_PASSWORD` | ⚠️ the **same** password. initdb consumes this one, the API connects with the one inside the URL, and a mismatch surfaces hours later as `password authentication failed`. The script refuses to apply a mismatched pair. |
| `BETTER_AUTH_SECRET` | signs parent session cookies |
| `POLICY_SIGNING_KEY` | ⚠️ Ed25519 PKCS#8 PEM, newlines as literal `\n`. See the warning above. |

> ⚠️ **There is deliberately no `cluster-secrets.env.example` in this repo.**
> A committed file whose name ends in `.env` trips the pre-commit secret
> scanner for everyone, for ever, over placeholders. `--generate` writes a
> correct file with real entropy, which is better than a template someone
> fills in by hand — a hand-typed signing key is a failure mode this avoids
> entirely.

**Verify:**

```sh
ssh aaronwang@192.168.1.163 \
  'kubectl -n homeparentcontrol get secret homeparentcontrol-secrets \
     -o go-template="{{range \$k, \$v := .data}}{{\$k}}{{\"\n\"}}{{end}}"'
# expect exactly: BETTER_AUTH_SECRET  DATABASE_URL  POLICY_SIGNING_KEY  POSTGRES_PASSWORD
```

---

## 2. GHCR packages must be anonymously pullable — ✅ **already true**

⚠️ **Public is load-bearing, not a convenience.** `homework-api` has **no
`imagePullSecrets`**, so the cluster pulls anonymously. A private package
gives `ImagePullBackOff` on the first sync, which reads like a broken image
rather than a permissions setting.

**Checked 2026-09-20, after the first `main` build pushed both images:**

```sh
check() {
  TOKEN=$(curl -s "https://ghcr.io/token?scope=repository:$1:pull&service=ghcr.io" \
    | python3 -c 'import sys,json;print(json.load(sys.stdin).get("token",""))')
  curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $TOKEN" \
    -H "Accept: application/vnd.oci.image.index.v1+json" \
    "https://ghcr.io/v2/$1/manifests/latest"
}
check autumnfallenwang/homeparentcontrol-api           # 200
check autumnfallenwang/homeparentcontrol-web           # 200
check autumnfallenwang/definitely-not-a-real-package   # 403  ← the check discriminates
```

Both return **200**. The packages inherited the repository's PUBLIC
visibility when Actions created them with `GITHUB_TOKEN`, so the manual flip
the milestone anticipated is **not needed**. The third line is there because
a check that only ever returns 200 proves nothing.

⚠️ Re-run it if the repo is ever made private — the packages follow.

---

## 3. Add two router DNS entries 🧑 *needs the router admin page*

```
homeparentcontrol.arch.internal      → 192.168.1.163
homeparentcontrol-api.arch.internal  → 192.168.1.163
```

⚠️ **`*.arch.internal` is NOT a wildcard.** Verified: all ten live ingress
hosts have their own 1:1 router entry, and an unregistered name returns
NXDOMAIN.

⚠️ **This is the nastiest failure in the list.** Argo syncs green, the pods
run, the Ingress object exists, everything inside the cluster looks perfect
— and the browser says "server not found". It is easy to lose an hour
inside the cluster before suspecting DNS.

**Verify from the Mac, before deploying anything:**

```sh
dig +short homeparentcontrol.arch.internal      # expect 192.168.1.163
dig +short homeparentcontrol-api.arch.internal  # expect 192.168.1.163
```

---

## 4. Set `ARCH_INFRA_TOKEN` 🧑 *needs a browser*

A classic PAT with `repo` scope on `autumnfallenwang/arch-infra`, added to
**this** repo's secrets:

```
https://github.com/autumnfallenwang/homeparentcontrol/settings/secrets/actions
```

Without it `bump-arch-infra` **fails the build** (deliberately — the house
template `exit 0`s here and that is the trap).

---

## 5. Commit the Application CR — ⚠️ **this is the deploy**

The `root` app-of-apps recurses `arch-infra/apps/` with automated sync and
prune. **The file appearing is the deploy**; there is no staging step.

```sh
cd ~/path/to/arch-infra
git pull                                  # ⚠️ always, see step 0
cp ~/github/homeparentcontrol/deploy/arch-infra/homeparentcontrol.yaml apps/
git add apps/homeparentcontrol.yaml
git commit -m "homeparentcontrol: add application"
git push
```

⚠️ **The copied file has no `syncPolicy.automated` block, on purpose.** Argo
will show the diff and apply nothing. Look at it, then sync once by hand:

```
https://argocd.arch.internal → homeparentcontrol → SYNC
```

**Verify before going further:**

```sh
ssh aaronwang@192.168.1.163 'kubectl -n homeparentcontrol get pods,svc,ingress'
# api + web Running, db Running, three Services, two Ingresses.
# The migrate Job should be ABSENT — migrate.enabled is still "false".
```

Then open `http://homeparentcontrol.arch.internal` and confirm the sign-in
page renders. If DNS was skipped in step 3, this is where it bites.

---

## 6. Turn on automated sync — a **second** commit

Only once step 5's pods are up. Add to `apps/homeparentcontrol.yaml`:

```yaml
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
```

⚠️ `prune: true` on a bad first render deletes whatever Argo thinks is
surplus, which is why it is not in the first commit. `homework`'s CR has it
from the outset — correct for an app that already worked, wrong for a first
deploy. This turns the first sync from "hope" into "look, then leap".

---

## 7. Enable migrations

Change `migrate.enabled` to `"true"` in `apps/homeparentcontrol.yaml`, commit,
push. The pre-upgrade hook runs `drizzle-kit migrate` against the SQL baked
into the api image.

**Verify:**

```sh
ssh aaronwang@192.168.1.163 \
  'kubectl -n homeparentcontrol logs job/homeparentcontrol-migrate'
ssh aaronwang@192.168.1.163 \
  'kubectl -n homeparentcontrol exec sts/homeparentcontrol-db -- \
     psql -U hpc -d homeparentcontrol -c "\dt" | head -20'
```

---

## 8. Observability 🧑 *needs an owner decision*

The rules and dashboard are authored in `deploy/observability/` and go into
the `observability-grafana` chart's values in `arch-infra`.

⚠️ **Read `deploy/observability/README.md` first.** §7.5's example queries
use labels that do not exist in this cluster; every query in this repo has
been rewritten and checked against live Loki.

⚠️ **C6 is not closed by provisioning them.** There is no contact point, no
notification policy and no SMTP anywhere in this cluster — not for this app
and not for the other three. Rules will *fire* and *arrive nowhere*. Pick a
channel in `alerting-contactpoints.yaml.example`, wire it, then **cause an
alert and watch it land on the phone**. Until that is observed, the
observability design is decoration, and an alert nobody receives is worse
than no alert because it is trusted.

---

## 9. Point the agent at the cluster

⚠️ **One environment variable, no code change** — hypothesis H1, and this is
where it either pays off or does not.

```sh
sudo launchctl setenv HPC_BASE_URL http://homeparentcontrol-api.arch.internal/api/agent/v1/
# or edit EnvironmentVariables in /Library/LaunchDaemons/com.hpc.sync.plist
sudo launchctl kickstart -k system/com.hpc.sync
```

**Verify:** the device appears on `http://homeparentcontrol.arch.internal`
and its health goes HEALTHY within three ticks.

---

## Rolling back

```sh
cd ~/path/to/arch-infra && git revert <the bump commit> && git push
```

Argo rolls the images back on the next reconcile. ⚠️ **This reverts the
control plane only.** The agent's pinned version is a separate parameter
(`agent.desiredVersion`) precisely so the two can be reverted
independently — a bad control-plane deploy should not force an agent
rollback, and vice versa.

---

## Things that are normal and not worth chasing

- **`OutOfSync` but `Healthy` on the db StatefulSet.** All three sibling apps
  show it. The drift is `volumeClaimTemplates` plus ServerSideApply defaults,
  and sync still reports "Succeeded". Chasing it wastes an afternoon.
- **Plain HTTP everywhere.** X4, accepted under AR.2. There is no `tls:`
  block and no cert-manager. The consequence that matters: the agent's device
  credential travels in clear on the LAN, which is why credential *scope* is
  the real control rather than the transport.

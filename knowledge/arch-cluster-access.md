---
name: arch-cluster-access
description: How to reach the k3s cluster and Argo CD from the Mac — SSH user, .arch.internal DNS, kubeconfig setup, and the OutOfSync StatefulSet red herring.
metadata:
  type: reference
---

The cluster is **k3s v1.35.4+k3s1** on `aaron-desktop-arch`, single control-plane node at
**192.168.1.163**. Verified reachable from the Mac on the home LAN, 2026-09-20.

## SSH

```bash
ssh aaronwang@192.168.1.163     # works with ~/.ssh/id_ed25519
```

⚠️ **The user is `aaronwang`, not `nicolewang`.** `~/.ssh/config` has a stale
`Host ubuntu → 192.168.1.163, User wangqiushi` entry left from before the Arch rebuild; it does not
work. Also note `hostname` is not installed on that box — use `uname -n`.

## `.arch.internal` resolves from the Mac

The router serves it, so these work in a browser with no VPN and no `/etc/hosts` edit:

| | |
|---|---|
| `argocd.arch.internal` | Argo CD — sync status, diffs, manual sync |
| `grafana.arch.internal` | Grafana — logs from every app |
| `<app>.arch.internal` / `<app>-api.arch.internal` | each app's web and api |

This is why `homecal` abandoned `.arch.local`: `.local` is reserved for mDNS (RFC 6762), so clients
intercept it and never query a unicast resolver. `.internal` is ICANN-reserved for private use.

## kubectl from the Mac

`6443` is open from the LAN and the API server binds `*:6443`. There is a user-readable kubeconfig
on the box whose `server:` points at `127.0.0.1`, so it needs rewriting:

```bash
ssh aaronwang@192.168.1.163 'cat ~/.kube/config' \
  | sed 's|https://127.0.0.1:6443|https://192.168.1.163:6443|' > ~/.kube/config
chmod 600 ~/.kube/config
```

⚠️ That is a **cluster-admin credential on a portable laptop**. Use it read-mostly — deployment
happens by committing, never by `kubectl apply`.

## ⚠️ `OutOfSync but Healthy` is expected — do not chase it

`homecal`, `homenews` and `homework` all report it. The drift is **`StatefulSet/<app>-db` only**,
and the sync operation itself reports *"Succeeded (all tasks run)"*. It is benign Argo behaviour on
StatefulSets — immutable `volumeClaimTemplates` plus ServerSideApply defaults the server adds back.
All three apps' Deployments are `1/1` and their pinned image tags match their repo HEADs.

**The GitOps chain works.** `homework`'s `api.image.tag` was `137b16b93c4c…`, exactly its repo HEAD.

## ❌ There is no alerting in this cluster

`/etc/grafana/provisioning/alerting/` in the running Grafana pod is **empty** — no rules, no contact
points, no notifiers. Any of the three live apps could be silently broken with nothing to say so.
See [[corepack-runtime-download]] for the kind of failure that would go unnoticed.

Relevant to this project as **C6**, the gate on the whole health design, and as an input to D.2.

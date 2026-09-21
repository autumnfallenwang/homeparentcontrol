# The punch list

Everything outstanding in the project, in one place, as of **2026-09-21**.

✅ **The cluster deploy is done.** `homeparentcontrol` is Healthy on k3s, both
ingress hosts answer, and all nine end-to-end tests pass against it with
`HPC_BASE_URL` as the only change. What follows is what is left.

**There is no code left to write.** Every item below needs hardware, a
router, a browser, a push to a second repo, or a decision. That is why no
milestone is `open` — see `CLAUDE.md`'s note on `awaiting-verification`.

Grouped by *what you need in your hand*, because that is how these actually
get done — not by milestone.

---

## 🖥️ A Mac you are willing to have locked, and sudo

The largest block, and the one that closes the most. Procedures:
[`agent/scripts/v-series.md`](../agent/scripts/v-series.md) and
[`agent/scripts/cutover.md`](../agent/scripts/cutover.md).

⚠️ **Do this on the mini, not the machine you work on.** Several of these
lock the screen and one powers the computer off.

### Session 1 — the isolation matrix (~30 min)

The contract's central unproven claim: *enforcement is independent of the
network*. Every row's expected result is "it still locks".

| | Break this | Needs |
|---|---|---|
| **V1** | Cluster off | — |
| **V2** | Cable out / Wi-Fi off | — |
| **V3** | DNS blackholed | — |
| **V4** | Server returns 500 for ever | a stub |
| **V7** | Disk full | `mkfile` |
| **V8** | `chmod 000` the current policy → must fall back to LKG | — |

### Session 2 — the three that needed M3's components

| | Break this | Why it was deferred |
|---|---|---|
| **V5** | Server accepts then hangs 120 s | needed the sync daemon |
| ⭐ **V6** | `launchctl bootout system/com.hpc.sync` → **byte-identical enforcer logs** | **the headline** — the only direct proof of the central claim |
| **V9** | `kill -9` the enforcer → the deadfall re-locks | needed the deadfall |

⚠️ **V6 first if you only do one.** And concatenate the rotated spool
segments before diffing, or you will "prove" that sync ate the enforcer's
log.

### Session 3 — the newer verifications

| | Question | Consequence if it fails |
|---|---|---|
| **V-PKG-1** | Does `installer -pkg … -target /` downgrade as **root**? | ⛔ **Run this first.** If not, §6.4's offline rollback does not exist and the fix is an ADR, not a patch. ~20 min |
| **V-SHADOW-1** | Does shadow mode not enforce — and then **start** enforcing? | its second half matters more than its first |
| **V-SAMPLE-1** | Do `lsappinfo` and the session probe survive `launchctl asuser` from root? | reporting only; cannot affect enforcement |
| **V-SAMPLE-2** | Does `systemUptime` stop during sleep? | loses the asleep/idle distinction only |
| | Supervisor installs, then rolls back **with the network down** | needs V-PKG-1 to pass first |

### Session 4 — the cutover

| | Needs |
|---|---|
| Pin macOS 26.x, automatic major updates off | ⚠️ 27 shipped 2026-09-14 and is entirely untested |
| `sudo agent/scripts/install.sh`, reboot, `sfltool dumpbtm` | — |
| ⚠️ **One real scheduled power-off** | **the one line development never exercised.** Have `sudo killall shutdown` ready in a second terminal |
| A 24 h shadow soak | a day |
| A real bedtime, observed | an evening |
| A real override on a real evening | someone to ask |

---

## 📡 The router admin page — ✅ done

- [x] **Two DNS entries**, both → `192.168.1.163`: ✅ **done 2026-09-21**, and
      verified resolving from the Mac before the deploy.

⚠️ `*.arch.internal` is **not** a wildcard — all ten live hosts have their
own 1:1 entry. This is the nastiest failure in the whole list: Argo syncs
green, the pods run, the Ingress exists, and the browser says "server not
found". Easy to lose an hour inside the cluster before suspecting DNS.

Verify from the Mac *before* deploying: `dig +short homeparentcontrol.arch.internal`

---

## 🌐 A browser

- [ ] ⬅️ **Set `ARCH_INFRA_TOKEN`** — a classic PAT with `repo` scope on
      `autumnfallenwang/arch-infra`, added to this repo's Actions secrets.
      **This is now the single thing between here and `git push` forever.**
      The app is deployed and running, but CI cannot bump its image tags, so
      a new commit does not roll — and `main` stays red, because
      `bump-arch-infra` fails hard rather than `exit 0`-ing (B3/A.22).
- [ ] **Look at the UI on a phone.** Two minutes. The viewport tag, the
      44px targets and the single-column layout are all verified in the
      built output and pinned by tests — but nobody has *looked*.

✅ **Not needed:** flipping the GHCR packages to public. Both are already
anonymously pullable, having inherited the repo's PUBLIC visibility.

---

## 🔑 The cluster — ✅ **deployed 2026-09-21**

Steps 1–4 are done: Secret created, CR committed (`08ddfd7`), migrations run
(29 tables), `automated: {prune, selfHeal}` on (`9f376c4`). Healthy, three
pods Running, both ingress hosts answering, 103 log lines in Loki.

⚠️ **One thing from that session still needs you:**

- [ ] **Back up `POLICY_SIGNING_KEY`** somewhere that is not this cluster.
      There is no rotation channel: replacing it makes every enrolled Mac
      reject every policy and keep enforcing yesterday's rules for ever.

      ```sh
      ssh aaronwang@192.168.1.163 \
        'kubectl -n homeparentcontrol get secret homeparentcontrol-secrets \
           -o jsonpath="{.data.POLICY_SIGNING_KEY}" | base64 -d'
      ```

Still to do:

- [ ] **Provision the observability files** into the `observability-grafana`
      chart's values in `arch-infra`.
- [ ] **Point the agent at the cluster** when you install it —
      `HPC_BASE_URL=http://homeparentcontrol-api.arch.internal/api/agent/v1/`.
      ✅ Already proven to need no code change: the full e2e suite passes
      against the cluster with only that variable different.

---

## 🤔 Decisions — nobody can do these for you

- [ ] ⛔ **C6 — pick a notification channel.** *The only item in the project
      blocked on a decision rather than on time.*

      There is **no contact point, no notification policy and no SMTP**
      anywhere in that cluster — not for this app and not for `homework`,
      `homecal` or `homenews`. **Any of them could be silently broken right
      now.** The five alert rules are written and their queries verified
      against live Loki, so they will *fire*; nothing carries them.

      Two ready options in `deploy/observability/alerting-contactpoints.yaml.example`
      (ntfy — no account, self-hostable; or SMTP). Then **cause an alert and
      watch it land on the phone.** Until that is observed, the observability
      design is decoration — and an alert nobody receives is worse than no
      alert, because it is trusted.

- [ ] **D.2** — reporting delivery: dashboard, digest, alerts, on-demand.
      Deliberately left open; the query service has one implementation and
      four sinks, so choosing later is a config flag and an adapter.
- [ ] **D.4** — bedtime window vs. daily budget. Mechanically unblocked
      (`active_s` is the meter); the product question is open.
- [ ] **O.2** — does the parent ever need access from outside the home?
- [ ] **Tell her it exists, or don't.** ⚠️ Not a technical decision.
      Protection comes from account privileges, not secrecy — she has admin,
      and the design assumes she could find everything if she looked. A
      visible countdown costs nothing technically.

---

## 📋 Known gaps — recorded, not yet anyone's action

Things that are true and written down, but which nothing is currently
blocked on.

- **No rotation channel for the policy signing key.** It is delivered only
  at enrolment, and an enrolled agent never repeats that. Replacing the key
  strands every device. A self-updating trust root fetched over plain HTTP
  (X4) is not the fix — it is the vulnerability.
- **`disk_full` is unimplementable as a `DEGRADED` reason** — the inputs do
  not exist in the database.
- **`/rules/calendar` has a working API but no month view.** Exceptions can
  be created and are compiled (and recompile every affected device); the UI
  page is not drawn.
- **macOS 27 is entirely untested.** Every empirical finding here is 26.6.2,
  and the version-fragile ones — TCC reach, `CGWindowList` redaction, BTM
  disposition, the `CGSession` lock path — are exactly the ones carrying the
  main conclusions. ⚠️ Do not accept the upgrade before re-running the
  V-series on it.
- **The remaining cluster checks (C1–C11)** beyond C2, C6 and C8.

✅ **Resolved since it was first recorded:** `telemetry.collect`'s defaults
no longer starve the projector — the block is decoded and every default errs
toward collecting, with tests.

---

## If you do only three things

1. **Back up `POLICY_SIGNING_KEY`** — sixty seconds, and losing it means
   re-enrolling every Mac by hand.
2. **V-PKG-1** — it can invalidate a design, and that is worth knowing early.
3. **C6** — because right now nothing in this house tells anyone when
   anything breaks.

(And **`ARCH_INFRA_TOKEN`**: two minutes, and it turns `main` green.)

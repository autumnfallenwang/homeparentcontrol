# The punch list

Everything outstanding in the project, in one place, as of **2026-09-26**.

✅ **The cluster deploy is done.** `homeparentcontrol` is Healthy on k3s, both
ingress hosts answer, and all nine end-to-end tests pass against it with
`HPC_BASE_URL` as the only change. What follows is what is left.

**One code item is waiting on a decision** — the screen-lock delay, below.
Everything else needs hardware, a router, a browser, a push to a second repo,
or a decision. That is why no milestone is `open` — see `CLAUDE.md`'s note on
`awaiting-verification`.

> **2026-09-22 — the first smoke test ran, and stalled.** Enrolled and ticked
> HEALTHY for 24 hours, but never locked: twelve problems between "the code is
> correct" and "it runs under launchd from a browser". Eleven are fixed (ADR
> 0010, milestone 06's progress notes). The twelfth is the first decision
> below. ✅ **Deployed 2026-09-27** (`1e51b54`) once `ARCH_INFRA_TOKEN` was
> set — the first fully green build on `main`.

Grouped by *what you need in your hand*, because that is how these actually
get done — not by milestone.

---

## 🖥️ A Mac you are willing to have locked, and sudo

The largest block, and the one that closes the most.

### ⬅️ Start here: the smoke test (~40 min)

[`agent/scripts/smoke-test.md`](../agent/scripts/smoke-test.md) — one Mac
enrolled against the deployed cluster, locking at a boundary, with **nothing
powering off**. It uses the safe build (`build-pkg.sh --dev`), so the real
power-off stays a separate, later decision. Everything below is easier once
this has worked once.

⚠️ **Rewritten after the first run** — reinstall with the rebuilt pkg; the
old one cannot say which variant it is and `install.sh` now refuses it.

Then: [`v-series.md`](../agent/scripts/v-series.md) and
[`cutover.md`](../agent/scripts/cutover.md).

⚠️ **The smoke test is safe on the machine you work on** (safe build, short
window, SSH in from the Arch box). **The rest belongs on the mini** — several
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

- [x] ✅ **`ARCH_INFRA_TOKEN` set** 2026-09-27 — the shared `arch-infra-bump` token, the same one
      homework, homecal and homenews use. `main` is green and commits roll to the cluster.
      ⏰ It expires **2027-05-10** — see Known gaps.
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
      `install.sh … --base-url http://homeparentcontrol-api.arch.internal/api/agent/v1/`.
      ⚠️ Not `launchctl setenv` (SIP refuses it) and not a plist edit (the
      next pkg upgrade undoes it) — ADR 0010.

---

## 🖥️ One command on the Mac, then a decision

- [ ] **Confirm the warning is delivered, and the ladder escalates.** On the first observed lock
      the modal was recorded `failed`. ✅ **Not the daemon context** — measured 2026-09-27: from a
      real LaunchDaemon the enforcer's exact command showed the dialog and the banner
      (`tools/verify/warning-from-daemon.sh`, all four variants seen). The explanation that fits is
      the fixed timing bug: a 60 s dialog under a 20 s runner, so an unclicked dialog was killed and
      counted as failed. **It matters beyond the dialog:** X10 forbids escalating to shutdown
      without a delivered warning. Re-run the smoke test's window with the rebuilt agent and check
      `warning_shown {outcome: delivered}` and, 5 minutes after the lock, the `DEV_ENFORCEMENT`
      line. If the dialog is recorded delivered but nobody saw it, it is appearing behind windows —
      a separate problem.

## 🤔 Decisions — nobody can do these for you

- [ ] ⛔ **The screen-lock delay makes the lock a no-op, and she can set it
      without admin.** Found on the smoke test: the agent's primary lock is
      `pmset displaysleepnow`, which only turns the display off. Whether
      waking needs a password is the *logged-in user's* screen-lock delay —
      it was **4 hours** on the test Mac. At any non-zero value the "lock" is
      a black screen a mouse wiggle undoes, while `lock()` reports success
      and the device card says it is enforcing. It is the shape of ADR 0009:
      an ordinary setting with the effect of an off switch, and it needs no
      admin, so it survives even the non-admin posture AR.1 keeps in reserve.

      Options, each needing a measurement on the Mac first
      (`verify-macos-claims`): **(a)** read the delay at boot and every tick
      and report `DEGRADED` when it is not `immediate` — honest, but it only
      tells you; **(b)** prefer `CGSession -suspend`, which switches to the
      login window regardless of the delay — but it is reported gone on macOS
      27, and whether it works from a root LaunchDaemon is unmeasured;
      **(c)** both. Until then: check `sysadminctl -screenLock status` **as
      her** before trusting a single bedtime (`cutover.md` step 0).

- [ ] ⛔ **C6 — pick a notification channel.** *The only item in the project
      blocked on a decision rather than on time.*

      There is **no contact point, no notification policy and no SMTP**
      anywhere in that cluster — not for this app and not for `homework`,
      `homecal` or `homenews`. **Any of them could be silently broken right
      now.** ✅ Since 2026-09-28 the five alert rules are **installed** in Grafana
      (`arch-infra@83f2810`, Loki pinned to `uid: loki`) and evaluating with
      `health=ok`. So they *fire*; nothing carries them.

      ⚠️ **Tune A1 before wiring a channel.** "Agent unexpectedly silent" matched
      102 five-minute windows in one day, mostly Macs asleep. With a channel
      attached as it is, it would page every night.

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

- **The agent's `boot_id` is per process, not per boot** (ADR 0013). Nothing relies on it any
  more: power-ons come from uptime at `/sync`. Sending the kernel's boot session UUID would need
  every Mac reinstalled. Worth doing only with some other agent change.
- **Next's startup banner** (`✓ Ready in …`) is the web container's only non-JSON output. It is
  harmless; real web errors are one JSON line each (ADR 0012).
- **Other home apps, found on 2026-09-28** (not this repo, recorded so they are not lost):
  - ⚠️ `llm-gateway` commits the **Grafana admin password** in plain text at
    `docs/k3s-migration/02-K3S_REFERENCE.md:167`. Change it and remove it.
  - `homenews` web logs `TypeError: controller[kState].transformAlgorithm is not a function`
    ~650×/day, as multi-line text nobody sees.
  - All four still write numeric levels, start with `pnpm`/`npm start`, and log `/health`. ADR 0012
    is the fix, and the "Home apps — HTTP overview" dashboard already covers them.

- ⏰ **The shared deploy token expires 2027-05-10.** One fine-grained token (`arch-infra-bump`,
  write to `arch-infra` only) is the `ARCH_INFRA_TOKEN` secret in homework, homecal, homenews and
  homeparentcontrol. On that day **every app stops deploying at once** — builds go red at
  `bump-arch-infra`, nothing else warns. A week before: regenerate it, then with the new value on
  the clipboard run
  `for r in homework homecal homenews homeparentcontrol; do pbpaste | gh secret set ARCH_INFRA_TOKEN --repo autumnfallenwang/$r; done`.
  (Argo CD Image Updater would remove the token from every app repo; it is a change to all five
  apps' deploy paths, so it is a deliberate project, not a side effect.)

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
- **A rules change publishes to one Mac at a time.** The rules page now
  picks the right one (the edited child's, never a `pending` device) and
  says which, with a picker when there are several — but a child with two
  Macs needs two publishes. The calendar path already recompiles every
  device; rules should too, with a C3 check per device.
- **The sync daemon's own events have no clock-independent order.** They
  carry `seq = -1` (ADR 0010) and sort by `ts`, which a clock step can
  scramble. Enforcement records come from the enforcer and are unaffected.

✅ **Resolved since it was first recorded:** `telemetry.collect`'s defaults
no longer starve the projector — the block is decoded and every default errs
toward collecting, with tests.

---

## If you do only three things

1. **Finish the smoke test** — ✅ the whole ladder is observed (warning → lock → re-lock → the
   `DEV_ENFORCEMENT` line → release, 2026-09-27). Left: step 7 (a grant from the phone,
   `Sent ✓ → Applied ✓`) and step 8 (reports).
2. **Decide the screen-lock delay** — until then a bedtime "lock" may be a
   black screen, and the dashboard cannot tell you.
3. **Back up `POLICY_SIGNING_KEY`** — sixty seconds, and losing it means
   re-enrolling every Mac by hand.

(Then re-run the smoke test; then V-PKG-1 and C6.)

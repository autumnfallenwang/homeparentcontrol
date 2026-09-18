# Architecture

Enforce screen-time rules on a child's Mac, and give the parent a way to set those rules and see what
actually happened. It exists because macOS Screen Time cannot power a machine off, offers no supported
API on macOS for a third party to build against, and cannot report the way this household wants.

## System shape

Two deployables and a contract between them. The **agent** runs on the child's Mac mini as two root
LaunchDaemons written in Swift. `enforcerd` ticks every 60 seconds, reads a cached policy from disk,
compares wall-clock time-of-day against the bedtime window, warns via `osascript` banners and a
`CFUserNotification` dialog, then enforces: lock, a 300-second grace period, then shutdown. **It has no
network code at all** — that is what makes "bedtime works with the server down" a structural property
rather than a promise. `syncd` is the only component that touches the network: it polls for desired
policy, posts telemetry on a separate endpoint, and writes the cached policy to disk for `enforcerd`.

The **control plane** is the fifth app in an established family (`homecal`, `homework`, `homenews`,
`llm-gateway`) and follows that pattern exactly: Hono API, Next.js UI, Drizzle, Postgres, better-auth,
deployed to single-node k3s via Helm, with GitHub Actions building to GHCR and bumping the tag in the
`arch-infra` GitOps repo for Argo CD. Its schema is `household → child → policy_set → device`; policy is
authored **per child** and compiled **per device** into an immutable, content-addressed artefact.

The **contract** is agent-initiated only, over the home LAN, with no inbound port on the child's Mac.
The server publishes desired state and the agent reconciles toward it — there is no RPC command channel
and **no verb that stops enforcement**. Every relaxation carries a mandatory `expires_at`, so a stale
policy can only converge *stricter*.

## Key components

- **`enforcerd`** (Swift, root LaunchDaemon) — the tick loop, warnings and the lock → grace → shutdown
  ladder. Opens no socket, ever. Subject to **Invariant E**: no code path in it may disable enforcement.
- **`syncd`** (Swift, root LaunchDaemon) — the only networked component. Polls desired policy, posts
  telemetry and logs, writes the cached policy to disk.
- **`supervisor`** (Swift, ~300 lines) — verifies and installs agent updates. Never self-updates.
- **`apps/api`** (Hono) — policy authoring and compilation, telemetry ingest, device enrolment, health.
- **`apps/web`** (Next.js) — the parent UI: rules, today's status, reports, one-click override grants.
- **`deploy/chart`** (Helm) — what Argo CD reconciles, with the agent version pinned alongside.
- **`docs/design-decisions.md`** — the buildable spec; supersedes the research tracks where they disagree.
- **`docs/research/`** — how the design was arrived at. History, not instruction.
- **`tools/verify/`** — throwaway macOS probes used to settle the empirical questions.

## Constraints and non-goals

**Constraints**

- **Enforcement must work with the network or server down.** The enforcer holds a cached policy and
  never blocks on a socket.
- **Fail-open on ignorance, fail-closed on knowledge.** Cannot determine the rules → do not lock, alert
  within one tick. Knows the rules but cannot reach the server → enforce as written, indefinitely.
- **Invariant E — the enforcer has no off switch.** Five separate "stop enforcing" levers were proposed
  during research and all were rejected. Health signals inform the parent; they never gate the action.
- **The child has admin and the assessed threat level is low.** Tamper resistance is a nice-to-have;
  misuse should be made *visible*, not impossible.
- **No kid-facing UI on the target.** Warnings and the override prompt are the only on-screen surfaces.
- **No separate mobile app, ever.** Every parent surface is the internal web UI in a browser on the LAN.
- **Monitoring stays at the permission-free tier** — app identity, CPU-gated active time, idle, power and
  session events. Anything richer needs TCC grants, which die on every agent rebuild under ad-hoc signing.
- **No paid Apple Developer account.** Ad-hoc signing throughout.
- **One child, one Mac today — but identity must not be hardcoded.**
- **Apple Silicon only.** All empirical findings are macOS 26.6.2; macOS 27 is untested.

**Non-goals**

MDM and Declarative Device Management · kernel extensions · Intel Macs · non-Mac devices (her phone and
iPad are explicitly out of scope, which does mean the control is evadable by switching device) ·
window-title and URL capture · offline override codes (designed in full, deliberately deferred) ·
surviving an OS reinstall.

## Open questions

**Owner decisions still open**

- **D.2** — reporting delivery: dashboard, digest, alerts, on-demand. Includes *pull vs push* for
  agent-death alerts. No mobile app either way.
- **D.4** — bedtime window vs. daily budget. Mechanically unblocked (`active_s` is the meter); the
  product question is open.
- **O.2** — does the parent ever need access from outside the home? Both shapes are LAN-scoped today.
- **O.4** — timeline.

**Verifications outstanding**

- **11 cluster checks**, blocked on k3s. Highest value: does a Grafana alert actually reach the parent,
  and does the existing Alloy DaemonSet already scrape pod stdout (if so, zero Loki-specific code).
- **V-PKG-1** — `.pkg` downgrade was observed only in the *user* domain; `installer -target /` is
  untested and the rollback story depends on it.
- **V1–V9** — the 9-case enforcement-isolation matrix, the contract's central unproven claim.
- **macOS 27** shipped 2026-09-14 and is entirely untested. ⚠️ Three confident claims about macOS 26 were
  refuted by direct testing during research, so treat version-fragile conclusions as hypotheses.

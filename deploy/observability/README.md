# Observability, as code

⚠️ **These files are NOT applied from this repo.** Grafana is deployed by the
`observability-grafana` Argo application, whose source lives in `arch-infra`.
They are authored here, beside the code that emits the log lines they read,
and copied into that chart's values — see `RUNBOOK.md` step 8.

Rules clicked into the Grafana UI are invisible to Argo CD and vanish on a
reinstall, which is directly at odds with P3.2/P3.4. That is why this exists
as files rather than as screenshots.

## ★ The label finding — read this before editing any query

§7.5's example queries use `{app="homeparentcontrol", component="control-plane"}`.
**Neither label exists.** Verified against the live cluster on 2026-09-20 by
reading the Alloy ConfigMap and then asking Loki directly:

| Label | Reality |
|---|---|
| `namespace`, `pod`, `container`, `node` | ✅ the four Alloy actually sets |
| `job` | ⚠️ **one value for the entire cluster** — `loki.source.kubernetes.pods` |
| `service_name` | ⚠️ derived by Loki from the container name, so `{service_name="api"}` matches **homework, homenews AND homecal** at once — verified, three namespaces came back |
| `instance` | `<namespace>/<pod>:<container>` |
| `app`, `component` | ❌ do not exist |

So the only correct selector for this app is **`{namespace="homeparentcontrol"}`**,
narrowed by `container="api"` or `container="web"`.

This matters more than it looks. A rule written as specified returns no
series, which Grafana evaluates as **No Data** — firing a *synthetic*
`DatasourceNoData` alert that 📄 "may not inherit existing silences or
notification policies". The carefully-routed alert arrives as a
differently-labelled one the policy may drop. **You would discover it the
first time it mattered.** §7.5 warns about exactly this trap and then falls
into it in its own examples.

Two further corrections the same check turned up:

- The log field is **`state`**, not `status`. `| state="DEGRADED"`.
- **A4 cannot read the agent's logs.** The agent is a daemon on a Mac; its
  logs never reach Loki, and shipping them would be a second telemetry path
  competing with `/events`. A4 now counts `agent_started` on the control
  plane's own `agent.events` line instead.

## Files

| File | Goes into |
|---|---|
| `alerting-rules.yaml` | the grafana chart's `alerting.rules\.yaml` values key |
| `alerting-contactpoints.yaml.example` | ⚠️ **a choice, not a default** — see below |
| `dashboard-agent-health.json` | the grafana chart's `dashboards` values, or a sidecar ConfigMap |

## ⚠️ C6 is not closed by any of this

> "**C6 — a test alert demonstrably reaches the parent.** Until this passes,
> the entire observability design is decoration."

Verified 2026-09-20: this cluster has **no contact point, no notification
policy, no SMTP configuration and no notification service of any kind** —
not for this app and not for `homework`, `homecal` or `homenews` either. Any
of them could be silently broken right now and nobody would be told.

Provisioning the rules below makes alerts *fire*. It does not make them
*arrive*. Choosing the channel is D.2, an owner decision that is still open,
and it needs infrastructure that does not exist yet.
`alerting-contactpoints.yaml.example` holds two ready options and neither is
picked.

**An alert nobody receives is worse than no alert, because it is trusted.**

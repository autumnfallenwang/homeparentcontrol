# Observability, as code

⚠️ **These files are not applied from this repo, but they ARE installed.**
Grafana is deployed by the `observability-grafana` Argo application, whose
source lives in `arch-infra`. They are authored here, beside the code that
emits the log lines they read, and copied into
`arch-infra/platform/observability/grafana/values.yaml`. They were first
installed in `arch-infra@83f2810` (2026-09-28). **Edit here first, then paste
there.** See `RUNBOOK.md` step 8.

The Loki data source is pinned to `uid: loki` in that file. Every dashboard
and rule refers to it by that uid, and it used to be auto-generated.

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
| `alerting-rules.yaml` | the grafana chart's `alerting.rules\.yaml` values key. ⚠️ No Go-template braces: the chart runs it through Helm's `tpl` |
| `alerting-contactpoints.yaml.example` | ⚠️ **a choice, not a default** — see below |
| `dashboard-agent-health.json` | `dashboards.home-apps.hpc-agent-health` (folder "Home apps") |
| `dashboard-http-overview.json` | `dashboards.home-apps.home-http-overview`: one dashboard for **every** home app, with a namespace picker. They all log the same `http.request` shape (ADR 0012) |

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

## Log cheat-sheet

The log shape is ADR 0012's: one JSON line per event, with `level` written as a word. Every query
below was run against live Loki. Paste them into Grafana → Explore → Loki
(`http://grafana.arch.internal/explore`).

| What | LogQL |
|---|---|
| Every error, both containers | `{namespace="homeparentcontrol"} \| json \| level=~"error\|fatal"` |
| One request, end to end | `{namespace="homeparentcontrol"} \| json \| req_id="<id>"`. The id is in the `X-Request-Id` response header |
| One run of a background job | `{namespace="homeparentcontrol", container="api"} \| json \| run_id="<id>"` |
| A device's health history | `{namespace="homeparentcontrol", container="api"} \| json \| event="agent_status" \| device_id="<uuid>"` |
| What parents did | `{namespace="homeparentcontrol", container="api"} \| json \| event=~"child.removed\|device\\..*\|enrolment.code_issued\|override.granted\|policy.published"` |
| Macs turned on (server-detected, ADR 0013) | `{namespace="homeparentcontrol", container="api"} \| json \| event="device.power_on"` |
| Web server errors (match the error page's reference) | `{namespace="homeparentcontrol", container="web"} \| json \| event="web.request_error"` |
| Slow requests | `{namespace="homeparentcontrol", container="api"} \| json \| event="http.request" \| latency_ms > 1000` |

- **Selectors:** only `namespace`, `pod`, `container` and `node` are labels. Anything else
  (`service`, `event`, `level`, `device_id`) goes after `| json`. `{service="…"}` silently matches
  nothing.
- **Counting over a range that holds a deploy from before ADR 0012:** add `| __error__=""` after
  `| json`, or the old non-JSON banner lines fail the whole query with `JSONParserErr`.
- **More detail for a while:** set `LOG_LEVEL: debug` for the api in `deploy/chart/values.yaml`
  and let Argo roll it. Put it back afterwards. There is no kubeconfig on the Mac, and changing the
  cluster by hand would be undone by Argo anyway.
- **After every deploy,** run the log check in `RUNBOOK.md` ("After every deploy").


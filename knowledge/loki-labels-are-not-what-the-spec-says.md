---
name: loki-labels-are-not-what-the-spec-says
description: Alloy sets only namespace/pod/container/node — and `or vector(0)` hides a wrong selector for ever
metadata:
  type: reference
---

**The only correct Loki selector for an app in this cluster is
`{namespace="<app>"}`**, narrowed by `container="api"` or `container="web"`.

Verified 2026-09-20 by reading the live `alloy` ConfigMap in `observability`
and then asking Loki's label API directly.

| Label | Reality |
|---|---|
| `namespace`, `pod`, `container`, `node` | ✅ the four Alloy's `discovery.relabel` actually sets |
| `job` | ⚠️ **one value for the whole cluster** — `loki.source.kubernetes.pods` |
| `service_name` | ⚠️ derived by Loki from the container name, so `{service_name="api"}` matches **homework, homenews AND homecal** — verified, three namespaces came back |
| `instance` | `<namespace>/<pod>:<container>` |
| `app`, `component` | ❌ do not exist, despite appearing in `design-decisions.md` §7.5's examples |

**Why:** §7.5 writes all five alert rules against
`{app="homeparentcontrol", component="control-plane"}`. Every one returns
nothing. This is [[verify-macos-claims]] pointed at infrastructure — a
confident, specific, and wrong claim in a document that is otherwise right.

**⚠️ The part that makes it dangerous.** §7.5 also mandates `or vector(0)`,
to stop an empty result becoming a Grafana **No Data** state — which fires a
*synthetic* `DatasourceNoData` alert that may not inherit the notification
policy the real alert was routed through. That defence is correct and worth
keeping. But it also converts "this query matches nothing" into a confident
`0`. Measured: the spec's selector returns **0 against a namespace holding
240 matching lines**. The rule cannot ever fire, and reports healthy for ever.

So `or vector(0)` and a verified selector are two different protections and
you need both. [[falsify-the-gate]]: a query that returns 0 proves nothing
until you have seen the same query shape return non-zero somewhere it should.

**How to apply:** before writing any LogQL for this cluster, run the two
controls — one query that MUST return data (`{namespace="homework",
container="api"}` over 30m) and one that must not — and only then write the
real ones. `deploy/observability/README.md` keeps the current findings, and
every query in that directory was executed against live Loki before being
committed.

Related: the agent's logs are **not** in Loki at all and should not be. It is
a LaunchDaemon on a Mac; shipping its logs would be a second telemetry path
competing with `/events`. Anything that looks like it needs the agent's log
stream has to be rephrased against what the control plane observed.

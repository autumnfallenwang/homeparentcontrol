{{/*
Chart name. Always returns "homeparentcontrol".
*/}}
{{- define "hpc.name" -}}
{{- .Chart.Name -}}
{{- end -}}

{{/*
Fully qualified resource name, component-scoped.
Usage: {{ include "hpc.fullname" (dict "context" . "component" "api") }}
Result: "homeparentcontrol-api"

Three workloads (api, web, db) plus a migrate hook live in one release, so
resource names must carry the component. The helper takes an explicit dict
because Helm's nested-template calling convention cannot pass both `.` and the
component name otherwise.
*/}}
{{- define "hpc.fullname" -}}
{{- printf "%s-%s" .context.Chart.Name .component -}}
{{- end -}}

{{- define "hpc.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .context.Chart.Name .context.Chart.Version }}
app.kubernetes.io/name: {{ .context.Chart.Name }}
app.kubernetes.io/instance: {{ .context.Release.Name }}
app.kubernetes.io/component: {{ .component }}
app.kubernetes.io/version: {{ .context.Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .context.Release.Service }}
{{- end -}}

{{/*
Selector labels. ⚠️ Must stay stable across Chart.Version bumps — a Deployment's
pod selector is immutable, so changing these makes the next sync fail with
"field is immutable" and needs the Deployment deleted by hand.
*/}}
{{- define "hpc.selectorLabels" -}}
app.kubernetes.io/name: {{ .context.Chart.Name }}
app.kubernetes.io/instance: {{ .context.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

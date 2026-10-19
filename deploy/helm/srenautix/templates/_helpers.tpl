{{/* 名称与标签 */}}
{{- define "srenautix.name" -}}
{{- .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "srenautix.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}
{{- .Release.Name | trunc 50 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 50 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "srenautix.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "srenautix.labels" -}}
helm.sh/chart: {{ include "srenautix.chart" . }}
app.kubernetes.io/name: {{ include "srenautix.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: srenautix
{{- end -}}

{{/* 角色的选择器标签；调用方式：include "srenautix.selectorLabels" (dict "ctx" $ "role" "server") */}}
{{- define "srenautix.selectorLabels" -}}
app.kubernetes.io/name: {{ include "srenautix.name" .ctx }}
app.kubernetes.io/instance: {{ .ctx.Release.Name }}
app.kubernetes.io/component: {{ .role }}
{{- end -}}

{{- define "srenautix.roleLabels" -}}
{{ include "srenautix.labels" .ctx }}
app.kubernetes.io/component: {{ .role }}
{{- end -}}

{{- define "srenautix.roleName" -}}
{{- printf "%s-%s" (include "srenautix.fullname" .ctx) .role -}}
{{- end -}}

{{- define "srenautix.serviceAccountName" -}}
{{- include "srenautix.roleName" . -}}
{{- end -}}

{{/* gateway 的 ServiceAccount 用户名，准入策略的 matchConditions 使用 */}}
{{- define "srenautix.gateway.username" -}}
{{- printf "system:serviceaccount:%s:%s" .Release.Namespace (include "srenautix.serviceAccountName" (dict "ctx" . "role" "gateway")) -}}
{{- end -}}

{{/* 镜像引用；调用方式：include "srenautix.image" (dict "ctx" $ "image" .Values.image.hub) */}}
{{- define "srenautix.image" -}}
{{- $repo := .image.repository -}}
{{- with .ctx.Values.global.imageRegistry -}}
{{- $parts := splitList "/" $repo -}}
{{- $repo = printf "%s/%s" . (rest $parts | join "/") -}}
{{- end -}}
{{- if .image.digest -}}
{{- printf "%s@%s" $repo .image.digest -}}
{{- else -}}
{{- printf "%s:%s" $repo (default .ctx.Chart.AppVersion .image.tag) -}}
{{- end -}}
{{- end -}}

{{- define "srenautix.podSecurityContext" -}}
runAsNonRoot: true
runAsUser: 65532
runAsGroup: 65532
fsGroup: 65532
seccompProfile:
  type: RuntimeDefault
{{- end -}}

{{- define "srenautix.containerSecurityContext" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop: [ALL]
{{- end -}}

{{- define "srenautix.imagePullSecrets" -}}
{{- with .Values.global.imagePullSecrets }}
imagePullSecrets:
{{- toYaml . | nindent 2 }}
{{- end }}
{{- end -}}

{{/* 角色 Pod 的调度字段：合并 global 与角色自己的 nodeSelector、tolerations，以及 affinity、拓扑分布和 PriorityClass */}}
{{- define "srenautix.scheduling" -}}
{{- $r := index .ctx.Values.roles .role -}}
{{- $ns := merge (deepCopy ($r.nodeSelector | default dict)) (.ctx.Values.global.nodeSelector | default dict) -}}
{{- with $ns }}
nodeSelector:
{{- toYaml . | nindent 2 }}
{{- end }}
{{- $tol := concat (.ctx.Values.global.tolerations | default list) ($r.tolerations | default list) -}}
{{- with $tol }}
tolerations:
{{- toYaml . | nindent 2 }}
{{- end }}
{{- with $r.topologySpreadConstraints }}
topologySpreadConstraints:
{{- toYaml . | nindent 2 }}
{{- end }}
{{- $pc := include "srenautix.priorityClassName" . -}}
{{- with $pc }}
priorityClassName: {{ . }}
{{- end }}
{{- end -}}

{{- define "srenautix.priorityClassName" -}}
{{- $r := index .ctx.Values.roles .role -}}
{{- if $r.priorityClassName -}}
{{- $r.priorityClassName -}}
{{- else if .ctx.Values.priorityClass.create -}}
{{- default (include "srenautix.fullname" .ctx) .ctx.Values.priorityClass.name -}}
{{- end -}}
{{- end -}}

{{/* PG 相关名称 */}}
{{- define "srenautix.pg.clusterName" -}}
{{- printf "%s-pg" (include "srenautix.fullname" .) -}}
{{- end -}}

{{- define "srenautix.pg.host" -}}
{{- if eq .Values.database.mode "cnpg" -}}
{{- printf "%s-rw.%s.svc" (include "srenautix.pg.clusterName" .) .Release.Namespace -}}
{{- else -}}
{{- .Values.database.external.host -}}
{{- end -}}
{{- end -}}

{{- define "srenautix.pg.port" -}}
{{- if eq .Values.database.mode "cnpg" -}}5432{{- else -}}{{ .Values.database.external.port }}{{- end -}}
{{- end -}}

{{- define "srenautix.pg.sslmode" -}}
{{- if eq .Values.database.mode "cnpg" -}}verify-full{{- else -}}{{ .Values.database.external.sslmode }}{{- end -}}
{{- end -}}

{{/* 数据库管理员凭证 Secret（键 username、password），db bootstrap Job 使用；为空表示由管理员手动初始化 */}}
{{- define "srenautix.pg.adminSecret" -}}
{{- if eq .Values.database.mode "cnpg" -}}
{{- printf "%s-superuser" (include "srenautix.pg.clusterName" .) -}}
{{- else -}}
{{- .Values.database.external.adminSecret -}}
{{- end -}}
{{- end -}}

{{/* 某个库角色的密码 Secret 名称；调用方式：include "srenautix.pg.passwordSecret" (dict "ctx" $ "role" "server") */}}
{{- define "srenautix.pg.passwordSecret" -}}
{{- $db := .ctx.Values.database -}}
{{- if eq $db.mode "cnpg" -}}
{{- default (printf "%s-%s" (include "srenautix.pg.clusterName" .ctx) .role) (index $db.cnpg.passwordSecrets .role) -}}
{{- else -}}
{{- index $db.external.passwordSecrets .role -}}
{{- end -}}
{{- end -}}

{{- define "srenautix.pg.caSecret" -}}
{{- if eq .Values.database.mode "cnpg" -}}
{{- printf "%s-ca" (include "srenautix.pg.clusterName" .) -}}
{{- else if eq .Values.database.external.sslmode "verify-full" -}}
{{- .Values.database.external.caSecret -}}
{{- end -}}
{{- end -}}

{{/* 审计汇相关名称 */}}
{{- define "srenautix.minio.name" -}}
{{- printf "%s-minio" (include "srenautix.fullname" .) -}}
{{- end -}}

{{- define "srenautix.audit.endpoint" -}}
{{- $sink := include "srenautix.auditSink" . -}}
{{- if eq $sink "minio" -}}
{{- printf "http://%s.%s.svc:9000" (include "srenautix.minio.name" .) .Release.Namespace -}}
{{- else if eq $sink "s3" -}}
{{- .Values.audit.s3.endpoint -}}
{{- end -}}
{{- end -}}

{{/* 审计汇凭证 Secret：minio 时为 chart 为每个角色生成的服务账号；s3 时为用户提供的 Secret */}}
{{- define "srenautix.audit.credentialsSecret" -}}
{{- $sink := include "srenautix.auditSink" .ctx -}}
{{- if eq $sink "minio" -}}
{{- printf "%s-audit-%s" (include "srenautix.minio.name" .ctx) .role -}}
{{- else if eq $sink "s3" -}}
{{- $s3 := .ctx.Values.audit.s3 -}}
{{- default $s3.existingSecret (index ($s3.existingSecrets | default dict) .role) -}}
{{- end -}}
{{- end -}}

{{/* 镜像对应的 40 位提交 SHA：values.codeSha，为空时取发布时写入的 Chart 注解 srenautix.io/code-sha */}}
{{- define "srenautix.codeSha" -}}
{{- $annotations := .Chart.Annotations | default dict -}}
{{- default (index $annotations "srenautix.io/code-sha" | default "") .Values.codeSha -}}
{{- end -}}

{{/*
各角色进程的监听端口（与各角色读取配置的代码一致）：
- server、worker：API 8080、指标 9090、探针 8081（/healthz、/readyz）
- mcp：API 8080（/healthz 也在这里）、指标 9090
- reader：一个端口 8080，同时提供 API、/metrics、/healthz、/readyz
- gateway：指标 9090、探针 8081
输出 YAML：http（0 表示没有）、metrics、probes、ready（就绪探针路径）
*/}}
{{- define "srenautix.rolePorts" -}}
{{- $ports := dict
  "server" (dict "http" 8080 "metrics" 9090 "probes" 8081 "ready" "/readyz")
  "worker" (dict "http" 8080 "metrics" 9090 "probes" 8081 "ready" "/readyz")
  "mcp" (dict "http" 8080 "metrics" 9090 "probes" 8080 "ready" "/healthz")
  "reader" (dict "http" 8080 "metrics" 8080 "probes" 8080 "ready" "/readyz")
  "gateway" (dict "http" 0 "metrics" 9090 "probes" 8081 "ready" "/readyz")
-}}
{{- index $ports .role | toYaml -}}
{{- end -}}

{{/* 容器端口号对应的端口名：http、metrics、probes 中第一个使用该端口号的名称 */}}
{{- define "srenautix.portName" -}}
{{- $p := .ports -}}
{{- if and (gt (int $p.http) 0) (eq (int $p.http) (int .port)) -}}http
{{- else if eq (int $p.metrics) (int .port) -}}metrics
{{- else -}}probes
{{- end -}}
{{- end -}}

{{/* 在已存在的 Secret 中读取某个键，不存在时生成随机值；保证 helm upgrade 不改变已生成的密码 */}}
{{- define "srenautix.persistentRandom" -}}
{{- $existing := lookup "v1" "Secret" .ctx.Release.Namespace .name -}}
{{- if and $existing (hasKey $existing.data .key) -}}
{{- index $existing.data .key | b64dec -}}
{{- else -}}
{{- randAlphaNum (int .length) -}}
{{- end -}}
{{- end -}}

{{/* 已存在的 Secret 中的 Ed25519 私钥（键 private.pem），不存在时生成 */}}
{{- define "srenautix.persistentKey" -}}
{{- $existing := lookup "v1" "Secret" .ctx.Release.Namespace .name -}}
{{- if and $existing (hasKey $existing.data "private.pem") -}}
{{- index $existing.data "private.pem" | b64dec | trim -}}
{{- else -}}
{{- genPrivateKey "ed25519" | trim -}}
{{- end -}}
{{- end -}}

{{/*
各角色的配置文件、挂载的 Secret 与环境变量。
每个角色的配置都由 chart 按部署事实生成（地址、端口、挂载路径、集群 id），键与各角色读取配置的代码一致：
  server   apps/srenautix/src/config/server.ts
  worker   apps/srenautix/src/research/config.ts
  mcp      apps/srenautix/src/roles/mcp.ts
  reader   internal/spoke/reader/config.go
  gateway  internal/spoke/gateway/run.go
再与 roles.<角色>.config 深度合并，同名键以用户值为准。
*/}}
{{- define "srenautix.secretsDir" -}}/etc/srenautix/secrets{{- end -}}

{{- define "srenautix.publicUrl" -}}
{{- if .Values.publicUrl -}}
{{- .Values.publicUrl -}}
{{- else if and .Values.roles.server.ingress.enabled .Values.roles.server.ingress.hosts -}}
{{- printf "https://%s" (first .Values.roles.server.ingress.hosts).host -}}
{{- else -}}
{{- printf "http://%s.%s.svc:8080" (include "srenautix.roleName" (dict "ctx" . "role" "server")) .Release.Namespace -}}
{{- end -}}
{{- end -}}

{{- define "srenautix.roleUrl" -}}
{{- printf "http://%s.%s.svc:8080" (include "srenautix.roleName" .) .ctx.Release.Namespace -}}
{{- end -}}

{{/* chart 生成或用户提供的 Secret 与 ConfigMap 名称 */}}
{{- define "srenautix.serviceTokensSecret" -}}
{{- default (printf "%s-service-tokens" (include "srenautix.fullname" .)) .Values.serviceTokens.existingSecret -}}
{{- end -}}
{{- define "srenautix.callersSecret" -}}
{{- default (printf "%s-callers" (include "srenautix.fullname" .)) .Values.callers.existingSecret -}}
{{- end -}}
{{- define "srenautix.ingestTokensSecret" -}}
{{- default (printf "%s-ingest-tokens" (include "srenautix.fullname" .)) .Values.ingest.existingSecret -}}
{{- end -}}
{{- define "srenautix.auditKeySecret" -}}
{{- default (printf "%s-audit-key" (include "srenautix.fullname" .)) .Values.secrets.auditSigningKey.existingSecret -}}
{{- end -}}
{{- define "srenautix.gatewayAuditKeySecret" -}}
{{- default (printf "%s-gateway-audit-key" (include "srenautix.fullname" .)) .Values.secrets.gatewayAuditSigningKey.existingSecret -}}
{{- end -}}
{{- define "srenautix.bindingsConfigMap" -}}
{{- default (printf "%s-bindings" (include "srenautix.fullname" .)) .Values.identity.bindingsConfigMap -}}
{{- end -}}
{{- define "srenautix.policyConfigMap" -}}
{{- default (printf "%s-gateway-policy" (include "srenautix.fullname" .)) .Values.roles.gateway.policy.existingConfigMap -}}
{{- end -}}
{{- define "srenautix.policyFile" -}}{{ .Values.clusterId }}.yaml{{- end -}}

{{/* Go 风格时长（例如 30s、5m、1h30m）换算成秒 */}}
{{- define "srenautix.durationSeconds" -}}
{{- $total := 0 -}}
{{- range $part := regexFindAll "[0-9]+[smh]" (toString .) -1 -}}
{{- $n := regexFind "[0-9]+" $part | int -}}
{{- $unit := regexFind "[smh]$" $part -}}
{{- $total = add $total (mul $n (get (dict "s" 1 "m" 60 "h" 3600) $unit)) -}}
{{- end -}}
{{- if not (regexMatch "^([0-9]+[smh])+$" (toString .)) -}}
{{- fail (printf "%q 不是时长（例如 30s、5m、1h30m）" (toString .)) -}}
{{- end -}}
{{- $total -}}
{{- end -}}

{{/* gateway 策略的最终内容（roles.gateway.policy.content）：启用自愈 PR 且策略中没有 gitops 一节时，
     按 remediation 的值补上 gitops 一节，并在 actions 中加入 gitops_pr（自动批准规则 remediation-pr）。 */}}
{{- define "srenautix.gatewayPolicyContent" -}}
{{- $content := .Values.roles.gateway.policy.content -}}
{{- $r := .Values.remediation -}}
{{- $policy := $content | fromYaml -}}
{{- if and $r.enabled (not (hasKey $policy "gitops")) (not (hasKey $policy "Error")) -}}
{{- $repo := dict "repository" $r.repository "base" $r.baseBranch "paths" $r.paths -}}
{{- with $r.reviewers }}{{- $_ := set $repo "reviewers" . }}{{- end -}}
{{- with $r.compensatingControls }}
{{- $_ := set $repo "compensating_controls" (dict "approved_by" .approvedBy "approved_at" (toString .approvedAt) "reference" .reference) }}
{{- end -}}
{{- $wd := $r.mainWatchdog -}}
{{- $_ := set $policy "gitops" (dict "max_prs_per_hour" (int $r.maxPerHour) "main_watchdog" (dict "interval" $wd.interval "lookback" $wd.lookback "allowed_bots" $wd.allowedBots) "repositories" (list $repo)) -}}
{{- $actions := $policy.actions | default list -}}
{{- $has := false -}}
{{- range $a := $actions }}{{- if eq $a.id "gitops_pr" }}{{- $has = true }}{{- end }}{{- end -}}
{{- if not $has -}}
{{- $actions = append $actions (dict "id" "gitops_pr" "auto_execution" (dict "rules" (list "remediation-pr"))) -}}
{{- end -}}
{{- $_ := set $policy "actions" $actions -}}
{{- toYaml $policy -}}
{{- else -}}
{{- $content -}}
{{- end -}}
{{- end -}}

{{/* worker 会在启动时禁用的模型路由：境外路由（in_domain=false）且没有 llm.allow_cross_border（ADR 0062） */}}
{{- define "srenautix.blockedRoutes" -}}
{{- $llm := (.Values.roles.worker.config | default dict).llm | default dict -}}
{{- $ids := list -}}
{{- range $r := $llm.routes | default list -}}
{{- if and (not $r.in_domain) (not $llm.allow_cross_border) -}}
{{- $ids = append $ids $r.id -}}
{{- end -}}
{{- end -}}
{{- join "、" $ids -}}
{{- end -}}

{{/* server 是否挂载审批人公钥（合规配置 H 档的通行密钥审批）：requirePasskey 为真且给出了 roles.gateway.approverKeys */}}
{{- define "srenautix.serverApproverKeys" -}}
{{- $keys := .Values.roles.gateway.approverKeys -}}
{{- $g := include "srenautix.governance" . | fromYaml -}}
{{- if and $g.requirePasskey (or $keys.content $keys.existingConfigMap $keys.existingSecret) -}}true{{- end -}}
{{- end -}}

{{/* GitHub App 凭证的卷，挂载在 <secretsDir>/github-app。调用方式：include "srenautix.githubAppEntry" (dict "ctx" $ "role" "gateway")
     server 只读私钥（App id 写在配置的 github_app 中）。gateway 读目录中的 app-id、installation-id、slug、private-key.pem：
     roles.gateway.githubApp.slug 非空时 slug 来自 chart 生成的 ConfigMap（与 Secret 投射到同一目录），否则来自 Secret 的 slug 键 */}}
{{- define "srenautix.githubAppEntry" -}}
{{- $app := index .ctx.Values.roles .role "githubApp" -}}
{{- $keys := list "private-key.pem" -}}
{{- if eq .role "gateway" -}}
{{- $keys = list "app-id" "installation-id" "private-key.pem" -}}
{{- if not $app.slug -}}{{- $keys = append $keys "slug" -}}{{- end -}}
{{- end -}}
{{- $items := list -}}
{{- range $k := $keys -}}{{- $items = append $items (dict "key" $k "path" $k) -}}{{- end -}}
{{- if and (eq .role "gateway") $app.slug -}}
{{- $slugItems := list (dict "key" "slug" "path" "slug") -}}
{{- $sources := list (dict "secret" (dict "name" $app.existingSecret "items" $items)) (dict "configMap" (dict "name" (include "srenautix.gatewayGithubAppConfigMap" .ctx) "items" $slugItems)) -}}
{{- toYaml (dict "key" "github-app" "projected" $sources) -}}
{{- else -}}
{{- toYaml (dict "key" "github-app" "secretName" $app.existingSecret "items" $items) -}}
{{- end -}}
{{- end -}}
{{- define "srenautix.gatewayGithubAppConfigMap" -}}{{ include "srenautix.fullname" . }}-gateway-github-app{{- end -}}

{{/* 审批人公钥的卷（gateway 与 server 挂载同一份，键 approver-keys.yaml） */}}
{{- define "srenautix.approverKeysEntry" -}}
{{- $keys := .Values.roles.gateway.approverKeys -}}
{{- $items := list (dict "key" "approver-keys.yaml" "path" "approver-keys.yaml") -}}
{{- if $keys.existingSecret -}}
{{- toYaml (dict "key" "approver-keys" "secretName" $keys.existingSecret "items" $items) -}}
{{- else -}}
{{- toYaml (dict "key" "approver-keys" "configMap" (default (printf "%s-approver-keys" (include "srenautix.fullname" .)) $keys.existingConfigMap) "items" $items) -}}
{{- end -}}
{{- end -}}

{{/* 使用数据库的角色 */}}
{{- define "srenautix.dbRoles" -}}server worker{{- end -}}

{{/*
角色挂载的 Secret 与 ConfigMap，返回 YAML 列表 [{key, secretName | configMap, items?}]，挂载到 /etc/srenautix/secrets/<key>/。
持有关系见设计 §1.1。
*/}}
{{- define "srenautix.roleSecrets" -}}
{{- $v := .ctx.Values -}}
{{- $role := .role -}}
{{- $tokens := include "srenautix.serviceTokensSecret" .ctx -}}
{{- $out := list -}}
{{- if has $role (splitList " " (include "srenautix.dbRoles" .)) -}}
{{- $out = append $out (dict "key" "db" "secretName" (include "srenautix.pg.passwordSecret" .) "items" (list (dict "key" "password" "path" "password"))) -}}
{{- $ca := include "srenautix.pg.caSecret" .ctx -}}
{{- if $ca -}}
{{- $out = append $out (dict "key" "db-ca" "secretName" $ca "items" (list (dict "key" "ca.crt" "path" "ca.crt"))) -}}
{{- end -}}
{{- end -}}
{{- if has $role (list "worker" "reader" "gateway") -}}
{{- $out = append $out (dict "key" "service-token" "secretName" $tokens "items" (list (dict "key" $role "path" "token"))) -}}
{{- end -}}
{{- if eq $role "worker" -}}
{{- $out = append $out (dict "key" "worker-inbound" "secretName" $tokens "items" (list (dict "key" "server.sha256" "path" "sha256"))) -}}
{{- with $v.secrets.llm.existingSecret -}}
{{- $out = append $out (dict "key" "llm" "secretName" .) -}}
{{- end -}}
{{- end -}}
{{- if eq $role "server" -}}
{{- if include "srenautix.roleEnabled" (dict "ctx" .ctx "role" "worker") -}}
{{- $out = append $out (dict "key" "worker-client" "secretName" $tokens "items" (list (dict "key" "server" "path" "token"))) -}}
{{- end -}}
{{- $out = append $out (dict "key" "ingest" "secretName" (include "srenautix.ingestTokensSecret" .ctx)) -}}
{{- $out = append $out (dict "key" "callers" "secretName" (include "srenautix.callersSecret" .ctx) "items" (list (dict "key" "callers.yaml" "path" "callers.yaml"))) -}}
{{- $out = append $out (dict "key" "audit-key" "secretName" (include "srenautix.auditKeySecret" .ctx) "items" (list (dict "key" "private.pem" "path" "private.pem"))) -}}
{{- with $v.secrets.channels.existingSecret -}}
{{- $out = append $out (dict "key" "channels" "secretName" .) -}}
{{- end -}}
{{- if $v.identity.oidc.enabled -}}
{{- $out = append $out (dict "key" "oidc" "secretName" $v.identity.oidc.existingSecret "items" (list (dict "key" "client_secret" "path" "client_secret"))) -}}
{{- end -}}
{{- with $v.identity.localAdmin.existingSecret -}}
{{- $out = append $out (dict "key" "local-admin" "secretName" . "items" (list (dict "key" "password_hash" "path" "password_hash") (dict "key" "totp_secret" "path" "totp_secret"))) -}}
{{- end -}}
{{- with $v.secrets.serviceSigningKey.existingSecret -}}
{{- $out = append $out (dict "key" "service-signing" "secretName" . "items" (list (dict "key" "private.pem" "path" "private.pem"))) -}}
{{- end -}}
{{- if include "srenautix.serverApproverKeys" .ctx -}}
{{- $out = append $out (include "srenautix.approverKeysEntry" .ctx | fromYaml) -}}
{{- end -}}
{{- if $v.roles.server.githubApp.existingSecret -}}
{{- $out = append $out (include "srenautix.githubAppEntry" (dict "ctx" .ctx "role" "server") | fromYaml) -}}
{{- end -}}
{{- with $v.packs.oci.keySecret -}}
{{- $out = append $out (dict "key" "pack-keys" "secretName" .) -}}
{{- end -}}
{{- with $v.packs.oci.dockerConfigSecret -}}
{{- $out = append $out (dict "key" "pack-registry" "secretName" . "items" (list (dict "key" ".dockerconfigjson" "path" "config.json"))) -}}
{{- end -}}
{{- end -}}
{{- if eq $role "mcp" -}}
{{- with $v.roles.mcp.clientTokensSecret -}}
{{- $out = append $out (dict "key" "mcp-clients" "secretName" .) -}}
{{- end -}}
{{- end -}}
{{- if eq $role "gateway" -}}
{{- $out = append $out (dict "key" "audit-key" "secretName" (include "srenautix.gatewayAuditKeySecret" .ctx) "items" (list (dict "key" "private.pem" "path" "private.pem"))) -}}
{{- $out = append $out (include "srenautix.approverKeysEntry" .ctx | fromYaml) -}}
{{- $out = append $out (dict "key" "policy" "configMap" (include "srenautix.policyConfigMap" .ctx) "items" (list (dict "key" (include "srenautix.policyFile" .ctx) "path" (include "srenautix.policyFile" .ctx)))) -}}
{{- if $v.roles.gateway.githubApp.existingSecret -}}
{{- $out = append $out (include "srenautix.githubAppEntry" (dict "ctx" .ctx "role" "gateway") | fromYaml) -}}
{{- end -}}
{{- end -}}
{{- if has $role (list "server" "worker" "reader") -}}
{{- with $v.secrets.datasources.existingSecret -}}
{{- $out = append $out (dict "key" "datasources" "secretName" .) -}}
{{- end -}}
{{- end -}}
{{- if and (has $role (list "server" "gateway")) (has (include "srenautix.auditSink" .ctx) (list "minio" "s3")) -}}
{{- $out = append $out (dict "key" "audit-store" "secretName" (include "srenautix.audit.credentialsSecret" .)) -}}
{{- end -}}
{{- toYaml $out -}}
{{- end -}}

{{/* 使用数据库的角色的 libpq 环境变量（apps/srenautix/src/config/database.ts） */}}
{{- define "srenautix.pgEnv" -}}
{{- $v := .ctx.Values -}}
- name: PGHOST
  value: {{ include "srenautix.pg.host" .ctx | quote }}
- name: PGPORT
  value: {{ include "srenautix.pg.port" .ctx | quote }}
- name: PGDATABASE
  value: {{ $v.database.name | quote }}
- name: PGUSER
  value: {{ (index $v.database.roles .role).username | quote }}
- name: PGSSLMODE
  value: {{ include "srenautix.pg.sslmode" .ctx | quote }}
{{- if include "srenautix.pg.caSecret" .ctx }}
- name: PGSSLROOTCERT
  value: {{ printf "%s/db-ca/ca.crt" (include "srenautix.secretsDir" .ctx) | quote }}
{{- end }}
{{- end -}}

{{/* server 的配置（未合并 roles.server.config） */}}
{{- define "srenautix.serverConfig" -}}
{{- $v := .Values -}}
{{- $dir := include "srenautix.secretsDir" . -}}
{{- $sink := include "srenautix.auditSink" . -}}
{{- $readerOn := include "srenautix.roleEnabled" (dict "ctx" . "role" "reader") -}}
cluster_id: {{ $v.clusterId }}
profile: {{ $v.profile }}
public_url: {{ include "srenautix.publicUrl" . }}
listen:
  api: ":8080"
  metrics: ":9090"
  probes: ":8081"
database:
  password_file: {{ $dir }}/db/password
leader:
  mode: lease
  namespace: {{ .Release.Namespace }}
  name: {{ include "srenautix.roleName" (dict "ctx" . "role" "server") }}-leader
{{- if include "srenautix.roleEnabled" (dict "ctx" . "role" "worker") }}
worker:
  url: {{ include "srenautix.roleUrl" (dict "ctx" . "role" "worker") }}
  token_file: {{ $dir }}/worker-client/token
{{- end }}
{{- if include "srenautix.roleEnabled" (dict "ctx" . "role" "gateway") }}
policies_dir: /etc/srenautix/policies
{{- end }}
ingest:
  {{- if $v.ingest.sources }}
  sources:
    {{- range $s := $v.ingest.sources }}
    - {{- toYaml (merge (dict "token_file" (printf "%s/ingest/%s" $dir $s.id)) (omit $s "token_file")) | nindent 6 }}
    {{- end }}
  {{- else }}
  sources: []
  {{- end }}
  self_label: srenautix_self
  reconcile:
    enabled: true
    interval: 60s
    {{- with $v.datasources.alertmanager.url }}
    alertmanager_url: {{ . }}
    {{- end }}
    prometheus_url: {{ $v.datasources.prometheus.url }}
packs:
  dirs:
    - /app/packs
    {{- range $p := $v.packs.userConfigMaps }}
    - /etc/srenautix/packs/{{ (include "srenautix.userPack" $p | fromYaml).configMap }}
    {{- end }}
  {{- if $v.packs.lockConfigMap }}
  lock_file: /etc/srenautix/pack-lock/pack.lock
  {{- end }}
  {{- with $v.packs.oci.sources }}
  oci:
    sources:
      {{- toYaml . | nindent 6 }}
    cache_dir: /var/cache/srenautix/packs
  {{- end }}
datasources:
  prometheus:
    url: {{ $v.datasources.prometheus.url }}
    dialect: {{ $v.datasources.prometheus.dialect }}
topology:
  source: {{ if $readerOn }}reader{{ else if $v.roles.server.clusterRead }}informer{{ else }}off{{ end }}
{{- with $v.roles.server.githubApp }}
{{- if .existingSecret }}
github_app:
  app_id: {{ .appId | quote }}
  installation_id: {{ .installationId | quote }}
  private_key_file: {{ $dir }}/github-app/private-key.pem
  {{- with .apiUrl }}
  api_base: {{ . }}
  {{- end }}
{{- end }}
{{- end }}
{{- if $v.issues.enabled }}
issues:
  {{- toYaml $v.issues | nindent 2 }}
{{- end }}
changes:
  {{- with $v.changes.sources }}
  sources:
    {{- toYaml . | nindent 4 }}
  {{- end }}
  {{- with $v.changes.kubernetes }}
  kubernetes:
    enabled: {{ .enabled }}
    revision_labels: {{ toJson .revisionLabels }}
    group_within: {{ .groupWithin }}
    {{- with .preStepLabels }}
    pre_step_labels: {{ toJson . }}
    {{- end }}
  {{- end }}
{{- with $v.detectors }}
{{- if .enabled }}
detectors:
  enabled: true
  namespaces: {{ toJson .namespaces }}
  exclude_namespaces: {{ toJson .excludeNamespaces }}
  pod_init_after: {{ .podInitAfter }}
  pod_pending_after: {{ .podPendingAfter }}
  rollout_stalled_after: {{ .rolloutStalledAfter }}
  crash_loop_after: {{ .crashLoopAfter }}
  pdb_blocked_after: {{ .pdbBlockedAfter }}
  job_failed: {{ .jobFailed }}
  severity: {{ .severity }}
  interval: {{ .interval }}
  equivalent_alerts: {{ toJson .equivalentAlerts }}
{{- end }}
{{- end }}
{{- with $v.remediation }}
{{- if .enabled }}
remediation:
  enabled: true
  repositories:
    gitops:
      repo: {{ .repository }}
      base_branch: {{ .baseBranch }}
      files: {{ toJson .files }}
  categories: {{ toJson .categories }}
  conclusions: {{ toJson .conclusions }}
  {{- if not (kindIs "invalid" .titlePrefix) }}
  title_prefix: {{ .titlePrefix | quote }}
  {{- end }}
{{- end }}
{{- end }}
{{- with $v.secrets.serviceSigningKey.existingSecret }}
approvals:
  signing_key_file: {{ $dir }}/service-signing/private.pem
  key_id: {{ $v.approvals.keyId }}
  h_reauth_max_age: {{ printf "%ds" (int $v.governance.highTierReauthMaxAgeSeconds) }}
  {{- if include "srenautix.serverApproverKeys" $ }}
  # 合规配置 H 档的通行密钥审批：与 gateway 相同的审批人公钥文件（webauthn.origins 应为 publicUrl）
  approver_keys_file: {{ $dir }}/approver-keys/approver-keys.yaml
  {{- end }}
{{- end }}
callers:
  tokens_file: {{ $dir }}/callers/callers.yaml
identity:
  bindings_dir: /etc/srenautix/bindings
  {{- with $v.identity.localAdmin.existingSecret }}
  local_admin:
    username: {{ $v.identity.localAdmin.username }}
    password_hash_file: {{ $dir }}/local-admin/password_hash
    totp_secret_file: {{ $dir }}/local-admin/totp_secret
  {{- end }}
  {{- if $v.identity.oidc.enabled }}
  oidc:
    issuer: {{ $v.identity.oidc.issuer }}
    client_id: {{ $v.identity.oidc.clientId }}
    client_secret_file: {{ $dir }}/oidc/client_secret
    scopes: {{ toJson $v.identity.oidc.scopes }}
    groups_claim: {{ $v.identity.oidc.groupsClaim }}
    name_claim: {{ $v.identity.oidc.nameClaim }}
  {{- end }}
audit:
  checkpoint_key_file: {{ $dir }}/audit-key/private.pem
  {{- if has $sink (list "minio" "s3") }}
  s3:
    endpoint: {{ include "srenautix.audit.endpoint" . }}
    region: {{ default "us-east-1" $v.audit.s3.region }}
    bucket: {{ $v.audit.bucket }}
    prefix: governance/
    access_key_file: {{ $dir }}/audit-store/accessKey
    secret_key_file: {{ $dir }}/audit-store/secretKey
    force_path_style: {{ or (eq $sink "minio") $v.audit.s3.forcePathStyle }}
  {{- end }}
{{- end -}}

{{/* worker 的配置（未合并 roles.worker.config） */}}
{{- define "srenautix.workerConfig" -}}
{{- $dir := include "srenautix.secretsDir" . -}}
cluster_id: {{ .Values.clusterId }}
code_sha: {{ include "srenautix.codeSha" . | quote }}
listen:
  api: ":8080"
  metrics: ":9090"
  probes: ":8081"
database:
  password_file: {{ $dir }}/db/password
hub:
  url: {{ include "srenautix.roleUrl" (dict "ctx" . "role" "server") }}
  token_file: {{ $dir }}/service-token/token
inbound:
  token_sha256_file: {{ $dir }}/worker-inbound/sha256
{{- end -}}

{{/* mcp 的配置（未合并 roles.mcp.config） */}}
{{- define "srenautix.mcpConfig" -}}
enabled: true
listen:
  api: ":8080"
  metrics: ":9090"
hub_url: {{ include "srenautix.roleUrl" (dict "ctx" . "role" "server") }}
{{- end -}}

{{/* reader 的配置（未合并 roles.reader.config） */}}
{{- define "srenautix.readerConfig" -}}
{{- $v := .Values -}}
cluster_id: {{ $v.clusterId }}
listen: ":8080"
hub:
  url: {{ include "srenautix.roleUrl" (dict "ctx" . "role" "server") }}
  token_file: {{ include "srenautix.secretsDir" . }}/service-token/token
datasources:
  - name: metrics
    url: {{ $v.datasources.prometheus.url }}
alerts:
  metrics_datasource: metrics
  {{- with $v.datasources.alertmanager.url }}
  alertmanager_url: {{ . }}
  {{- end }}
history:
  datasource: metrics
{{- if $v.roles.reader.queryManifestConfigMap }}
query_manifest: /etc/srenautix/query-manifest/queries.yaml
{{- end }}
{{- end -}}

{{/* gateway 的配置（未合并 roles.gateway.config） */}}
{{- define "srenautix.gatewayConfig" -}}
{{- $v := .Values -}}
{{- $dir := include "srenautix.secretsDir" . -}}
{{- $sink := include "srenautix.auditSink" . -}}
cluster_id: {{ $v.clusterId }}
profile: {{ $v.profile }}
namespace: {{ .Release.Namespace }}
listen:
  metrics: ":9090"
  probes: ":8081"
hub:
  url: {{ include "srenautix.roleUrl" (dict "ctx" . "role" "server") }}
  token_file: {{ $dir }}/service-token/token
audit:
  checkpoint_key_file: {{ $dir }}/audit-key/private.pem
  staging_dir: /var/lib/srenautix/audit-staging
  s3:
    endpoint: {{ include "srenautix.audit.endpoint" . }}
    region: {{ default "us-east-1" $v.audit.s3.region }}
    bucket: {{ $v.audit.bucket }}
    access_key_file: {{ $dir }}/audit-store/accessKey
    secret_key_file: {{ $dir }}/audit-store/secretKey
    force_path_style: {{ or (eq $sink "minio") $v.audit.s3.forcePathStyle }}
  object_lock:
    enabled: {{ $v.audit.objectLock.enabled }}
    mode: {{ include "srenautix.auditLockMode" . }}
    retention_days: {{ int $v.audit.objectLock.retentionDays }}
gateway:
  lease_name: {{ include "srenautix.roleName" (dict "ctx" . "role" "gateway") }}
  policy_file: {{ $dir }}/policy/{{ include "srenautix.policyFile" . }}
  approver_keys_file: {{ $dir }}/approver-keys/approver-keys.yaml
  admission_policy_prefix: {{ include "srenautix.fullname" . }}
  metrics_url: {{ $v.datasources.prometheus.url }}
  {{- if $v.roles.gateway.githubApp.existingSecret }}
  github_app_dir: {{ $dir }}/github-app
  {{- with $v.roles.gateway.githubApp.apiUrl }}
  github_api: {{ . }}
  {{- end }}
  {{- end }}
{{- end -}}

{{/* 角色最终写入 config.yaml 的内容；调用方式：include "srenautix.roleConfig" (dict "ctx" $ "role" "server") */}}
{{- define "srenautix.roleConfig" -}}
{{- $user := deepCopy ((index .ctx.Values.roles .role).config | default dict) -}}
{{- $base := include (printf "srenautix.%sConfig" .role) .ctx | fromYaml -}}
{{- if hasKey $base "Error" -}}
{{- fail (printf "%s 配置渲染失败：%s" .role $base.Error) -}}
{{- end -}}
{{- toYaml (mustMergeOverwrite $base $user) -}}
{{- end -}}

{{/*
各角色的配置文件、挂载的 Secret 与环境变量。
server 的配置由 chart 按部署事实生成（键与 apps/srenautix/src/config/server.ts 一致），再与 roles.server.config 深度合并；
其余角色的配置就是 roles.<角色>.config。
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

{{/* chart 生成的 Secret 名称 */}}
{{- define "srenautix.serviceTokensSecret" -}}{{ include "srenautix.fullname" . }}-service-tokens{{- end -}}
{{- define "srenautix.callersSecret" -}}{{ include "srenautix.fullname" . }}-callers{{- end -}}
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

{{/* 使用数据库的角色 */}}
{{- define "srenautix.dbRoles" -}}server worker mcp{{- end -}}

{{/*
角色挂载的 Secret（设计 §1.1 的持有关系），返回 YAML 列表 [{key, secretName, items?}]，
挂载到 /etc/srenautix/secrets/<key>/。
*/}}
{{- define "srenautix.roleSecrets" -}}
{{- $v := .ctx.Values -}}
{{- $role := .role -}}
{{- $out := list -}}
{{- if has $role (splitList " " (include "srenautix.dbRoles" .)) -}}
{{- $out = append $out (dict "key" "db" "secretName" (include "srenautix.pg.passwordSecret" .) "items" (list (dict "key" "password" "path" "password"))) -}}
{{- $ca := include "srenautix.pg.caSecret" .ctx -}}
{{- if $ca -}}
{{- $out = append $out (dict "key" "db-ca" "secretName" $ca "items" (list (dict "key" "ca.crt" "path" "ca.crt"))) -}}
{{- end -}}
{{- end -}}
{{- if has $role (list "worker" "mcp" "reader" "gateway") -}}
{{- $out = append $out (dict "key" "service-token" "secretName" (include "srenautix.serviceTokensSecret" .ctx) "items" (list (dict "key" $role "path" "token"))) -}}
{{- end -}}
{{- if eq $role "server" -}}
{{- $out = append $out (dict "key" "ingest" "secretName" (include "srenautix.ingestTokensSecret" .ctx)) -}}
{{- $out = append $out (dict "key" "callers" "secretName" (include "srenautix.callersSecret" .ctx)) -}}
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
{{- end -}}
{{- if eq $role "gateway" -}}
{{- $out = append $out (dict "key" "audit-key" "secretName" (include "srenautix.gatewayAuditKeySecret" .ctx) "items" (list (dict "key" "private.pem" "path" "private.pem"))) -}}
{{- with $v.secrets.serviceSigningKey.existingSecret -}}
{{- $out = append $out (dict "key" "service-signing" "secretName" . "items" (list (dict "key" "public.pem" "path" "public.pem"))) -}}
{{- end -}}
{{- end -}}
{{- if eq $role "worker" -}}
{{- with $v.secrets.llm.existingSecret -}}
{{- $out = append $out (dict "key" "llm" "secretName" .) -}}
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
ingest:
  sources:
    {{- range $s := $v.ingest.sources }}
    - {{- toYaml (merge (dict "token_file" (printf "%s/ingest/%s" $dir $s.id)) (omit $s "token_file")) | nindent 6 }}
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
    {{- range $cm := $v.packs.userConfigMaps }}
    - /etc/srenautix/packs/{{ $cm }}
    {{- end }}
  {{- if $v.packs.lockConfigMap }}
  lock_file: /etc/srenautix/pack-lock/pack.lock
  {{- end }}
datasources:
  prometheus:
    url: {{ $v.datasources.prometheus.url }}
    dialect: {{ $v.datasources.prometheus.dialect }}
topology:
  source: {{ if $readerOn }}reader{{ else if $v.roles.server.clusterRead }}informer{{ else }}off{{ end }}
{{- with $v.secrets.serviceSigningKey.existingSecret }}
approvals:
  signing_key_file: {{ $dir }}/service-signing/private.pem
  key_id: {{ $v.approvals.keyId }}
  h_reauth_max_age: {{ printf "%ds" (int $v.governance.highTierReauthMaxAgeSeconds) }}
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

{{/* 角色最终写入 config.yaml 的内容；调用方式：include "srenautix.roleConfig" (dict "ctx" $ "role" "server") */}}
{{- define "srenautix.roleConfig" -}}
{{- $user := deepCopy ((index .ctx.Values.roles .role).config | default dict) -}}
{{- if eq .role "server" -}}
{{- $base := include "srenautix.serverConfig" .ctx | fromYaml -}}
{{- if hasKey $base "Error" -}}
{{- fail (printf "server 配置渲染失败：%s" $base.Error) -}}
{{- end -}}
{{- toYaml (mustMergeOverwrite $base $user) -}}
{{- else -}}
{{- toYaml $user -}}
{{- end -}}
{{- end -}}

{{/*
每个角色的 config.yaml。chart 生成的部分只描述部署事实（地址、挂载路径、开关），
业务配置由 .Values.config（所有角色）与 roles.<角色>.config 合并覆盖。
调用方式：include "srenautix.roleConfig" (dict "ctx" $ "role" "server")
*/}}
{{- define "srenautix.secretsDir" -}}/etc/srenautix/secrets{{- end -}}

{{/* 角色挂载的 Secret：返回 YAML 列表 [{key, secretName}]（设计 §1.1 的持有关系） */}}
{{- define "srenautix.roleSecrets" -}}
{{- $v := .ctx.Values -}}
{{- $holders := dict
  "llm" (list "worker")
  "channels" (list "server")
  "oidc" (list "server")
  "serviceSigningKey" (list "server")
  "auditSigningKey" (list "server" "gateway")
  "datasources" (list "server" "worker" "reader")
-}}
{{- $out := list -}}
{{- range $key := keys $holders | sortAlpha -}}
{{- $s := index $v.secrets $key -}}
{{- if and $s.existingSecret (has $.role (index $holders $key)) -}}
{{- $out = append $out (dict "key" $key "secretName" $s.existingSecret) -}}
{{- end -}}
{{- end -}}
{{- if and (has .role (list "server" "worker")) -}}
{{- $out = append $out (dict "key" "db" "secretName" (include "srenautix.pg.passwordSecret" .) "items" (list (dict "key" "password" "path" "password"))) -}}
{{- $ca := include "srenautix.pg.caSecret" .ctx -}}
{{- if $ca -}}
{{- $out = append $out (dict "key" "db-ca" "secretName" $ca "items" (list (dict "key" "ca.crt" "path" "ca.crt"))) -}}
{{- end -}}
{{- end -}}
{{- if and (has .role (list "server" "gateway")) (has (include "srenautix.auditSink" .ctx) (list "minio" "s3")) -}}
{{- $out = append $out (dict "key" "audit-store" "secretName" (include "srenautix.audit.credentialsSecret" .)) -}}
{{- end -}}
{{- toYaml $out -}}
{{- end -}}

{{- define "srenautix.roleConfig" -}}
{{- $v := .ctx.Values -}}
{{- $ns := .ctx.Release.Namespace -}}
{{- $dir := include "srenautix.secretsDir" . -}}
{{- $cfg := dict
  "role" .role
  "profile" $v.profile
  "clusterId" $v.clusterId
  "release" (dict "name" .ctx.Release.Name "namespace" $ns)
  "listen" (dict "http" ":8080" "metrics" ":9090" "probes" ":8081")
  "secretsDir" $dir
  "hub" (dict "url" (printf "http://%s.%s.svc:8080" (include "srenautix.roleName" (dict "ctx" .ctx "role" "server")) $ns))
-}}
{{- if has .role (list "server" "worker" "reader" "gateway") -}}
{{- $_ := set $cfg "datasources" $v.datasources -}}
{{- end -}}
{{- if has .role (list "server" "worker") -}}
{{- $db := dict
  "host" (include "srenautix.pg.host" .ctx)
  "port" (include "srenautix.pg.port" .ctx | int)
  "database" $v.database.name
  "user" (index $v.database.roles .role).username
  "sslmode" (include "srenautix.pg.sslmode" .ctx)
  "passwordFile" (printf "%s/db/password" $dir)
-}}
{{- if include "srenautix.pg.caSecret" .ctx -}}
{{- $_ := set $db "caFile" (printf "%s/db-ca/ca.crt" $dir) -}}
{{- end -}}
{{- $_ := set $cfg "database" $db -}}
{{- end -}}
{{- if has .role (list "server" "gateway") -}}
{{- $sink := include "srenautix.auditSink" .ctx -}}
{{- $lock := dict "enabled" $v.audit.objectLock.enabled "mode" (include "srenautix.auditLockMode" .ctx) "retentionDays" (int $v.audit.objectLock.retentionDays) -}}
{{- $audit := dict "sink" $sink "bucket" $v.audit.bucket "objectLock" $lock -}}
{{- if has $sink (list "minio" "s3") -}}
{{- $_ := set $audit "endpoint" (include "srenautix.audit.endpoint" .ctx) -}}
{{- $_ := set $audit "region" (default "us-east-1" $v.audit.s3.region) -}}
{{- $_ := set $audit "forcePathStyle" (or (eq $sink "minio") $v.audit.s3.forcePathStyle) -}}
{{- $_ := set $audit "credentialsDir" (printf "%s/audit-store" $dir) -}}
{{- end -}}
{{- $_ := set $cfg "audit" $audit -}}
{{- $_ := set $cfg "freeze" (dict "configMap" "srenautix-freeze" "namespace" $ns) -}}
{{- end -}}
{{- if eq .role "server" -}}
{{- $_ := set $cfg "governance" (include "srenautix.governance" .ctx | fromYaml) -}}
{{- $_ := set $cfg "roles" (dict
  "mcp" (include "srenautix.roleEnabled" (dict "ctx" .ctx "role" "mcp") | eq "true")
  "reader" (include "srenautix.roleEnabled" (dict "ctx" .ctx "role" "reader") | eq "true")
  "gateway" (include "srenautix.roleEnabled" (dict "ctx" .ctx "role" "gateway") | eq "true")
  "clusterRead" $v.roles.server.clusterRead
) -}}
{{- end -}}
{{- if eq .role "gateway" -}}
{{- $_ := set $cfg "gateway" (dict
  "actions" $v.roles.gateway.actions
  "leaseName" (include "srenautix.roleName" (dict "ctx" .ctx "role" "gateway"))
  "auditStagingDir" "/var/lib/srenautix/audit-staging"
) -}}
{{- end -}}
{{- $merged := mustMergeOverwrite $cfg (deepCopy ($v.config | default dict)) (deepCopy ((index $v.roles .role).config | default dict)) -}}
{{- toYaml $merged -}}
{{- end -}}

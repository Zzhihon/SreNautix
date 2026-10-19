{{/*
三种安装配置的默认值（设计 §1.3）。values 中为 null 的开关取这里的值。
*/}}
{{- define "srenautix.profileDefaults" -}}
observe:
  roles: {server: true, worker: true, mcp: false, reader: false, gateway: false}
  governance: {separationOfDuties: false, requirePasskey: false, allowSelfApproval: true}
  audit: {sink: pg, lockMode: GOVERNANCE}
  imagePolicy: false
standard:
  roles: {server: true, worker: true, mcp: false, reader: true, gateway: true}
  governance: {separationOfDuties: false, requirePasskey: false, allowSelfApproval: true}
  audit: {sink: minio, lockMode: GOVERNANCE}
  imagePolicy: false
compliance:
  roles: {server: true, worker: true, mcp: false, reader: true, gateway: true}
  governance: {separationOfDuties: true, requirePasskey: true, allowSelfApproval: false}
  audit: {sink: minio, lockMode: COMPLIANCE}
  imagePolicy: true
{{- end -}}

{{- define "srenautix.profile" -}}
{{- $all := include "srenautix.profileDefaults" . | fromYaml -}}
{{- if not (hasKey $all .Values.profile) -}}
{{- fail (printf "profile 必须是 observe、standard、compliance 之一，当前为 %q" .Values.profile) -}}
{{- end -}}
{{- index $all .Values.profile | toYaml -}}
{{- end -}}

{{/* 角色是否启用：返回 "true" 或空字符串；调用方式：include "srenautix.roleEnabled" (dict "ctx" $ "role" "gateway") */}}
{{- define "srenautix.roleEnabled" -}}
{{- $p := include "srenautix.profile" .ctx | fromYaml -}}
{{- $v := (index .ctx.Values.roles .role).enabled -}}
{{- if kindIs "invalid" $v -}}
{{- if index $p.roles .role -}}true{{- end -}}
{{- else if $v -}}true{{- end -}}
{{- end -}}

{{/* 治理选项的生效值，输出 YAML */}}
{{- define "srenautix.governance" -}}
{{- $p := include "srenautix.profile" . | fromYaml -}}
{{- $g := .Values.governance -}}
{{- $out := dict "highTierReauthMaxAgeSeconds" (int $g.highTierReauthMaxAgeSeconds) -}}
{{- range $k := list "separationOfDuties" "requirePasskey" "allowSelfApproval" -}}
{{- $v := index $g $k -}}
{{- if kindIs "invalid" $v -}}
{{- $_ := set $out $k (index $p.governance $k) -}}
{{- else -}}
{{- $_ := set $out $k $v -}}
{{- end -}}
{{- end -}}
{{- toYaml $out -}}
{{- end -}}

{{/* 审计汇类型：minio | s3 | pg */}}
{{- define "srenautix.auditSink" -}}
{{- $p := include "srenautix.profile" . | fromYaml -}}
{{- default $p.audit.sink .Values.audit.sink -}}
{{- end -}}

{{/* 对象锁模式：GOVERNANCE | COMPLIANCE */}}
{{- define "srenautix.auditLockMode" -}}
{{- $p := include "srenautix.profile" . | fromYaml -}}
{{- default $p.audit.lockMode .Values.audit.objectLock.mode -}}
{{- end -}}

{{- define "srenautix.imagePolicyEnabled" -}}
{{- $p := include "srenautix.profile" . | fromYaml -}}
{{- $v := .Values.imagePolicy.enabled -}}
{{- if kindIs "invalid" $v -}}
{{- if $p.imagePolicy -}}true{{- end -}}
{{- else if $v -}}true{{- end -}}
{{- end -}}

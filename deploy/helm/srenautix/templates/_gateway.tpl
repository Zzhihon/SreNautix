{{/*
gateway 动作目录。files/admission/ 由 internal/spoke/gateway/admission 的生成器写入：
index.yaml 给出每个动作的准入策略文件与 RBAC 规则，每个策略文件含一个 ValidatingAdmissionPolicy。
*/}}
{{- define "srenautix.gateway.index" -}}
{{- $raw := .Files.Get "files/admission/index.yaml" -}}
{{- if not $raw -}}
{{- fail "缺少 files/admission/index.yaml：gateway 的准入策略由 internal/spoke/gateway/admission 生成器产出" -}}
{{- end -}}
{{- $idx := $raw | fromYaml -}}
{{- if hasKey $idx "Error" -}}
{{- fail (printf "files/admission/index.yaml 无法解析：%s" $idx.Error) -}}
{{- end -}}
{{- toYaml $idx -}}
{{- end -}}

{{/* 启用的动作汇总：policies（去重后的文件名）与 rules（RBAC 规则），输出 YAML */}}
{{- define "srenautix.gateway.catalog" -}}
{{- $idx := include "srenautix.gateway.index" . | fromYaml -}}
{{- $policies := list -}}
{{- $rules := list -}}
{{- range $action := .Values.roles.gateway.actions -}}
{{- if not (hasKey $idx.actions $action) -}}
{{- fail (printf "roles.gateway.actions 中的 %q 不在动作目录中（files/admission/index.yaml）" $action) -}}
{{- end -}}
{{- $entry := index $idx.actions $action -}}
{{- include "srenautix.assertSafeRules" (dict "rules" ($entry.rules | default list) "source" (printf "动作 %s 的 RBAC 规则" $action)) -}}
{{- range $p := ($entry.policies | default list) -}}
{{- $policies = append $policies $p -}}
{{- end -}}
{{- range $r := ($entry.rules | default list) -}}
{{- $rules = append $rules $r -}}
{{- end -}}
{{- end -}}
{{- dict "policies" ($policies | uniq | sortAlpha) "rules" ($rules | uniq) | toYaml -}}
{{- end -}}

{{/*
gateway 可以写入的 "组/资源[/子资源]" 列表：目录规则中的写动词，加上 gateway 自己的记录对象。
兜底准入策略只放行这个列表内的写入。
*/}}
{{- define "srenautix.gateway.writableResources" -}}
{{- $cat := include "srenautix.gateway.catalog" . | fromYaml -}}
{{- $writeVerbs := list "create" "update" "patch" "delete" "deletecollection" -}}
{{- $out := list "srenautix.io/actionexecutions" "srenautix.io/actionexecutions/status" "coordination.k8s.io/leases" "/events" "events.k8s.io/events" "authorization.k8s.io/selfsubjectaccessreviews" "authorization.k8s.io/selfsubjectrulesreviews" -}}
{{- range $r := $cat.rules -}}
{{- $writes := false -}}
{{- range $v := $r.verbs -}}
{{- if has $v $writeVerbs -}}{{- $writes = true -}}{{- end -}}
{{- end -}}
{{- if $writes -}}
{{- range $g := $r.apiGroups -}}
{{- range $res := $r.resources -}}
{{- $out = append $out (printf "%s/%s" $g $res) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- $out | uniq | sortAlpha | toJson -}}
{{- end -}}

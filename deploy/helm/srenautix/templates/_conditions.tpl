{{/*
当前异常的状态条件的 PromQL（按 files/conditions.yaml 的方向表生成），结果带 by 中列出的标签。
调用方式：include "srenautix.unhealthyConditions" (dict "ctx" $ "selector" "namespace=\"srenautix\"" "by" "namespace, role, type")
只包含启用的角色；reader 的指标没有 role 标签，用 label_replace 补上。
*/}}
{{- define "srenautix.unhealthyConditions" -}}
{{- $ctx := .ctx -}}
{{- $selector := .selector -}}
{{- $exprs := list -}}
{{- range $m := $ctx.Files.Get "files/conditions.yaml" | fromYamlArray -}}
{{- range $role, $spec := $m.roles -}}
{{- if include "srenautix.roleEnabled" (dict "ctx" $ctx "role" $role) -}}
{{- $types := deepCopy ($spec.types | default dict) -}}
{{- if and (eq $role "reader") (not $ctx.Values.roles.reader.queryManifestConfigMap) -}}
{{- $_ := set $types "QueryManifest" "ignore" -}}
{{- end -}}
{{- $base := list $selector -}}
{{- if $m.roleLabel -}}{{- $base = append $base (printf "role=%q" $role) -}}{{- end -}}
{{- /* 每一项：选择器与正常取值。第一项是没有单独列出的类型（按角色的 healthy），其后是单独列出方向的类型 */}}
{{- $sel := $base -}}
{{- with keys $types | sortAlpha -}}{{- $sel = append $sel (printf "type!~%q" (join "|" .)) -}}{{- end -}}
{{- $items := list (dict "sel" $sel "healthy" (int $spec.healthy)) -}}
{{- range $t := keys $types | sortAlpha -}}
{{- $v := index $types $t -}}
{{- if ne (toString $v) "ignore" -}}
{{- $items = append $items (dict "sel" (append $base (printf "type=%q" $t)) "healthy" (int $v)) -}}
{{- end -}}
{{- end -}}
{{- range $i := $items -}}
{{- $series := printf "%s{%s}" $m.metric (join ", " $i.sel) -}}
{{- if not $m.roleLabel -}}{{- $series = printf "label_replace(%s, \"role\", %q, \"\", \"\")" $series $role -}}{{- end -}}
{{- $exprs = append $exprs (printf "max by (%s) (%s != %d)" $.by $series $i.healthy) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- join " or " $exprs -}}
{{- end -}}

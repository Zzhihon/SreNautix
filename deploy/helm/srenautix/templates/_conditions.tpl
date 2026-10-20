{{/*
当前异常的状态条件的 PromQL，结果带 by 中列出的标签。方向来自契约的方向表（contract/conditions.json，
chart 内的副本 files/conditions.json 必须与它逐字节相同，apps/srenautix 的单元测试与 check.sh 都会比较）：
每个角色正常时的取值 healthy，类型可以单独覆盖；alert: false 的类型（例如冻结）不告警。
指标的取值为 1 当且仅当条件的 status 为 true 或 True：server、worker、mcp 与 gateway 用 srenautix_condition（带 role 标签），
reader 用自己的 srenautix_reader_condition（没有 role 标签，用 label_replace 补上）。
没有挂载证据查询清单（roles.reader.queryManifestConfigMap 为空）时 reader 的 QueryManifest 为 False，此时不告警。
调用方式：include "srenautix.unhealthyConditions" (dict "ctx" $ "selector" "namespace=\"srenautix\"" "by" "namespace, role, type")
只包含启用的角色。
*/}}
{{- define "srenautix.unhealthyConditions" -}}
{{- $ctx := .ctx -}}
{{- $selector := .selector -}}
{{- $exprs := list -}}
{{- $table := $ctx.Files.Get "files/conditions.json" | fromJson -}}
{{- /* 先是 srenautix_condition 的角色（按名称排序），最后是 reader 自己的指标 */}}
{{- $roles := without (keys $table.roles | sortAlpha) "reader" -}}
{{- if hasKey $table.roles "reader" -}}{{- $roles = append $roles "reader" -}}{{- end -}}
{{- range $role := $roles -}}
{{- $spec := index $table.roles $role -}}
{{- if include "srenautix.roleEnabled" (dict "ctx" $ctx "role" $role) -}}
{{- $metric := ternary "srenautix_reader_condition" "srenautix_condition" (eq $role "reader") -}}
{{- $roleLabel := ne $role "reader" -}}
{{- $metricOf := dict "true" 1 "True" 1 "false" 0 "False" 0 -}}
{{- $defaultHealthy := index $metricOf $spec.healthy -}}
{{- /* 单独列出的类型：方向与角色默认不同、或者不告警 */}}
{{- $special := dict -}}
{{- range $t, $ts := $spec.types | default dict -}}
{{- $alert := ternary $ts.alert true (hasKey $ts "alert") -}}
{{- if and (eq $role "reader") (eq $t "QueryManifest") (not $ctx.Values.roles.reader.queryManifestConfigMap) -}}
{{- $alert = false -}}
{{- end -}}
{{- $h := ternary (index $metricOf (toString $ts.healthy)) $defaultHealthy (hasKey $ts "healthy") -}}
{{- if or (not $alert) (ne (int $h) (int $defaultHealthy)) -}}
{{- $_ := set $special $t (ternary (toString $h) "ignore" $alert) -}}
{{- end -}}
{{- end -}}
{{- $base := list $selector -}}
{{- if $roleLabel -}}{{- $base = append $base (printf "role=%q" $role) -}}{{- end -}}
{{- /* 每一项：选择器与正常取值。第一项是没有单独列出的类型（按角色的 healthy），其后是单独列出方向的类型 */}}
{{- $sel := $base -}}
{{- with keys $special | sortAlpha -}}{{- $sel = append $sel (printf "type!~%q" (join "|" .)) -}}{{- end -}}
{{- $items := list (dict "sel" $sel "healthy" (int $defaultHealthy)) -}}
{{- range $t := keys $special | sortAlpha -}}
{{- $v := index $special $t -}}
{{- if ne $v "ignore" -}}
{{- $items = append $items (dict "sel" (append $base (printf "type=%q" $t)) "healthy" (atoi $v)) -}}
{{- end -}}
{{- end -}}
{{- range $i := $items -}}
{{- $series := printf "%s{%s}" $metric (join ", " $i.sel) -}}
{{- if not $roleLabel -}}{{- $series = printf "label_replace(%s, \"role\", %q, \"\", \"\")" $series $role -}}{{- end -}}
{{- $exprs = append $exprs (printf "max by (%s) (%s != %d)" $.by $series $i.healthy) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- join " or " $exprs -}}
{{- end -}}

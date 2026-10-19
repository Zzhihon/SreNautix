{{/*
只读 RBAC 规则（设计 §16.1 不变量 1）：显式列出资源，不使用通配符，从不包含 secrets。
调用方式：include "srenautix.readRules" (dict "ctx" $ "configmaps" true "logs" true)
*/}}
{{- define "srenautix.readRules" -}}
- apiGroups: [""]
  resources:
    - pods
    - services
    - endpoints
    - nodes
    - namespaces
    - events
    - persistentvolumeclaims
    - persistentvolumes
    - replicationcontrollers
    - resourcequotas
    - limitranges
    - serviceaccounts
    {{- if .configmaps }}
    - configmaps
    {{- end }}
    {{- if .logs }}
    - pods/log
    {{- end }}
  verbs: [get, list, watch]
- apiGroups: [apps]
  resources: [deployments, replicasets, statefulsets, daemonsets, controllerrevisions]
  verbs: [get, list, watch]
- apiGroups: [batch]
  resources: [jobs, cronjobs]
  verbs: [get, list, watch]
- apiGroups: [autoscaling]
  resources: [horizontalpodautoscalers]
  verbs: [get, list, watch]
- apiGroups: [policy]
  resources: [poddisruptionbudgets]
  verbs: [get, list, watch]
- apiGroups: [networking.k8s.io]
  resources: [ingresses, networkpolicies]
  verbs: [get, list, watch]
- apiGroups: [discovery.k8s.io]
  resources: [endpointslices]
  verbs: [get, list, watch]
- apiGroups: [events.k8s.io]
  resources: [events]
  verbs: [get, list, watch]
- apiGroups: [storage.k8s.io]
  resources: [storageclasses, volumeattachments, csidrivers, csinodes]
  verbs: [get, list, watch]
- apiGroups: [apiextensions.k8s.io]
  resources: [customresourcedefinitions]
  verbs: [get, list, watch]
- apiGroups: [metrics.k8s.io]
  resources: [pods, nodes]
  verbs: [get, list]
- apiGroups: [argoproj.io]
  resources: [applications, applicationsets, workflows, workflowtemplates, rollouts]
  verbs: [get, list, watch]
- apiGroups: [kustomize.toolkit.fluxcd.io]
  resources: [kustomizations]
  verbs: [get, list, watch]
- apiGroups: [helm.toolkit.fluxcd.io]
  resources: [helmreleases]
  verbs: [get, list, watch]
- apiGroups: [source.toolkit.fluxcd.io]
  resources: [gitrepositories, ocirepositories, helmrepositories, helmcharts]
  verbs: [get, list, watch]
- apiGroups: [postgresql.cnpg.io]
  resources: [clusters, backups, scheduledbackups, poolers]
  verbs: [get, list, watch]
- apiGroups: [gateway.networking.k8s.io]
  resources: [gateways, httproutes, grpcroutes]
  verbs: [get, list, watch]
- apiGroups: [cert-manager.io]
  resources: [certificates, issuers, clusterissuers]
  verbs: [get, list, watch]
- apiGroups: [monitoring.coreos.com]
  resources: [prometheusrules, servicemonitors, podmonitors]
  verbs: [get, list, watch]
- apiGroups: [srenautix.io]
  resources: [actionexecutions]
  verbs: [get, list, watch]
{{- with .ctx.Values.rbac.extraReadRules }}
{{ toYaml . }}
{{- end }}
{{- end -}}

{{/*
gateway 永远不能拥有的权限（不变量 4）。规则命中其中任意一项时渲染失败。
调用方式：include "srenautix.assertSafeRules" (dict "rules" $rules "source" "说明")
*/}}
{{- define "srenautix.assertSafeRules" -}}
{{- $forbiddenGroups := list "rbac.authorization.k8s.io" "admissionregistration.k8s.io" "authentication.k8s.io" "certificates.k8s.io" "*" -}}
{{- $forbiddenResources := list "secrets" "serviceaccounts" "serviceaccounts/token" "*" "*/*" -}}
{{- range $rule := .rules -}}
{{- range $g := ($rule.apiGroups | default list) -}}
{{- if has $g $forbiddenGroups -}}
{{- fail (printf "%s：不允许授予 API 组 %q" $.source $g) -}}
{{- end -}}
{{- end -}}
{{- range $res := ($rule.resources | default list) -}}
{{- if has $res $forbiddenResources -}}
{{- fail (printf "%s：不允许授予资源 %q" $.source $res) -}}
{{- end -}}
{{- end -}}
{{- if has "*" ($rule.verbs | default list) -}}
{{- fail (printf "%s：不允许使用通配符动词" $.source) -}}
{{- end -}}
{{- if $rule.nonResourceURLs -}}
{{- fail (printf "%s：不允许授予 nonResourceURLs" $.source) -}}
{{- end -}}
{{- end -}}
{{- end -}}

package admission

import (
	"fmt"
	"sort"
)

// BaseRules 是 gateway 维护自身记录需要的权限（只在自己的命名空间内）：ActionExecution、Lease、Event，
// 以及读取 srenautix-freeze。chart 在 gateway 的命名空间 Role 中授予它们。
func BaseRules() []Rule {
	return []Rule{
		{APIGroups: []string{"srenautix.io"}, Resources: []string{"actionexecutions"}, Verbs: []string{"create", "get", "list", "watch"}},
		{APIGroups: []string{"srenautix.io"}, Resources: []string{"actionexecutions/status"}, Verbs: []string{"get", "patch", "update"}},
		{APIGroups: []string{"coordination.k8s.io"}, Resources: []string{"leases"}, Verbs: []string{"create", "get", "list", "watch", "update"}},
		{APIGroups: []string{""}, Resources: []string{"events"}, Verbs: []string{"create", "patch"}},
		{APIGroups: []string{""}, Resources: []string{"configmaps"}, ResourceNames: []string{"srenautix-freeze"}, Verbs: []string{"get", "list", "watch"}},
	}
}

// Manifests 渲染与 chart 等价的 gateway 安装清单（ServiceAccount、ClusterRole 与绑定、命名空间 Role 与绑定、
// srenautix-freeze、启用动作的准入策略与 Binding），供 envtest 与不变量测试安装。opts 必须是具体值。
func Manifests(out *Output, opts Options, namespace, saName string, actions []string, frozen string, extra ...Policy) ([]map[string]any, error) {
	var docs []map[string]any
	docs = append(docs,
		map[string]any{"apiVersion": "v1", "kind": "ServiceAccount", "metadata": map[string]any{"name": saName, "namespace": namespace}},
		map[string]any{"apiVersion": "v1", "kind": "ConfigMap", "metadata": map[string]any{"name": "srenautix-freeze", "namespace": namespace},
			"data": map[string]any{"frozen": frozen}},
	)
	var rules []Rule
	files := map[string]bool{}
	for _, a := range actions {
		e, ok := out.Index.Actions[a]
		if !ok {
			return nil, fmt.Errorf("admission: action %s is not in the index", a)
		}
		rules = append(rules, e.Rules...)
		for _, f := range e.Policies {
			files[f] = true
		}
	}
	subject := []any{map[string]any{"kind": "ServiceAccount", "name": saName, "namespace": namespace}}
	docs = append(docs,
		map[string]any{"apiVersion": "rbac.authorization.k8s.io/v1", "kind": "ClusterRole",
			"metadata": map[string]any{"name": opts.Prefix + "-gateway-actions"}, "rules": rulesDoc(mergeRules(rules))},
		map[string]any{"apiVersion": "rbac.authorization.k8s.io/v1", "kind": "ClusterRoleBinding",
			"metadata": map[string]any{"name": opts.Prefix + "-gateway-actions"},
			"roleRef":  map[string]any{"apiGroup": "rbac.authorization.k8s.io", "kind": "ClusterRole", "name": opts.Prefix + "-gateway-actions"},
			"subjects": subject},
		map[string]any{"apiVersion": "rbac.authorization.k8s.io/v1", "kind": "Role",
			"metadata": map[string]any{"name": opts.Prefix + "-gateway-records", "namespace": namespace}, "rules": rulesDoc(BaseRules())},
		map[string]any{"apiVersion": "rbac.authorization.k8s.io/v1", "kind": "RoleBinding",
			"metadata": map[string]any{"name": opts.Prefix + "-gateway-records", "namespace": namespace},
			"roleRef":  map[string]any{"apiGroup": "rbac.authorization.k8s.io", "kind": "Role", "name": opts.Prefix + "-gateway-records"},
			"subjects": subject},
	)
	names := make([]string, 0, len(files))
	for f := range files {
		names = append(names, f)
	}
	sort.Strings(names)
	var pols []Policy
	for _, f := range names {
		for _, p := range out.Policies {
			if p.File == f {
				pols = append(pols, p)
			}
		}
	}
	for _, p := range append(pols, extra...) {
		docs = append(docs, p.Doc, Binding(p.Name(), namespace))
	}
	return docs, nil
}

func rulesDoc(rules []Rule) []any {
	var out []any
	for _, r := range rules {
		m := map[string]any{"apiGroups": toAny(r.APIGroups), "resources": toAny(r.Resources), "verbs": toAny(r.Verbs)}
		if len(r.ResourceNames) > 0 {
			m["resourceNames"] = toAny(r.ResourceNames)
		}
		out = append(out, m)
	}
	return out
}

// ProbeNames 返回 out 中启用动作用到的策略短名（自检时每个都要探测）。
func (o *Output) ProbeNames(actions []string) []string {
	seen := map[string]bool{}
	for _, a := range actions {
		for _, f := range o.Index.Actions[a].Policies {
			seen[f[:len(f)-len(".yaml")]] = true
		}
	}
	var out []string
	for s := range seen {
		out = append(out, s)
	}
	sort.Strings(out)
	return out
}

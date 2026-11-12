package topology

import (
	"strings"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

// LookupRecognizer 是提取时要查询其他对象的识别器（例如按标签选中 Pod 的策略）。reader 在 Pod、命名空间变化后
// 与 NetworkPolicy 一起重算它们的贡献。
type LookupRecognizer interface {
	Recognizer
	ExtractWith(lk Lookup, obj *unstructured.Unstructured) Contribution
}

// Cilium 端点标签里的命名空间：io.kubernetes.pod.namespace 是 Pod 所在的命名空间，
// io.cilium.k8s.namespace.labels.<键> 是命名空间的标签，io.cilium.k8s.policy.serviceaccount 是 Pod 的服务账号
const (
	ciliumNamespaceKey      = "io.kubernetes.pod.namespace"
	ciliumNamespaceLabelKey = "io.cilium.k8s.namespace.labels."
	ciliumServiceAccountKey = "io.cilium.k8s.policy.serviceaccount"
)

// ── CiliumNetworkPolicy ─────────────────────────────────────────

// ciliumPolicy 识别 CiliumNetworkPolicy（cilium.io/v2，SreNautix ADR 0200）：endpointSelector 选中的 Pod 与
// egress.toEndpoints、ingress.fromEndpoints 选中的 Pod 之间的放行，按顶层 owner 产生 egress_to 边，置信度 ConfPolicyAllowed。
// toEntities、toFQDNs、toCIDR 这类对端不对应集群里的对象，不产生边；用到无法求值的保留标签的选择器跳过。
// 与 NetworkPolicy 一样，"命名空间内全部端点互相放行"（端点选择器与对端都为空）不产生边。
type ciliumPolicy struct{}

func (ciliumPolicy) Resource() schema.GroupVersionResource {
	return schema.GroupVersionResource{Group: "cilium.io", Version: "v2", Resource: "ciliumnetworkpolicies"}
}

func (ciliumPolicy) Kind() string { return "CiliumNetworkPolicy" }

// Extract 只贡献策略自己的节点；边要查询 Pod，由 ExtractWith 给出。
func (r ciliumPolicy) Extract(obj *unstructured.Unstructured) Contribution {
	c, _ := generic(crdKind(r), obj)
	return c
}

func (r ciliumPolicy) ExtractWith(lk Lookup, obj *unstructured.Unstructured) Contribution {
	kind := crdKind(r)
	c, self := generic(kind, obj)
	if self == "" {
		return c
	}
	f := fields{c: &c, kind: kind, obj: obj}
	ns := obj.GetNamespace()
	var rules []map[string]any
	if spec, ok, _ := unstructured.NestedMap(obj.Object, "spec"); ok {
		rules = append(rules, spec)
	}
	for _, s := range f.slice("specs") {
		if m, ok := s.(map[string]any); ok {
			rules = append(rules, m)
		}
	}
	ev := kind + " " + ns + "/" + obj.GetName()
	for _, rule := range rules {
		subject, ok := ciliumSelect(lk, &c, ns, rule["endpointSelector"])
		if !ok || len(subject) == 0 {
			continue
		}
		everyone := emptyCiliumSelector(rule["endpointSelector"])
		for _, dir := range []struct{ field, peers string }{{"egress", "toEndpoints"}, {"ingress", "fromEndpoints"}} {
			list, _ := rule[dir.field].([]any)
			for _, item := range list {
				m, _ := item.(map[string]any)
				peerList, _ := m[dir.peers].([]any)
				for _, p := range peerList {
					if everyone && emptyCiliumSelector(p) {
						continue
					}
					peers, ok := ciliumSelect(lk, &c, ns, p)
					if !ok {
						continue
					}
					if dir.field == "egress" {
						c.allow(subject, peers, ConfPolicyAllowed, ev)
					} else {
						c.allow(peers, subject, ConfPolicyAllowed, ev+" ingress")
					}
				}
			}
		}
	}
	return c
}

// ciliumSelect 求一个 Cilium 端点选择器选中的 Pod 的顶层 owner。选择器的键去掉来源前缀（k8s:、any:）后，按 Pod 标签加上
// 命名空间、命名空间标签与服务账号三个 Cilium 保留键求值；选择器没有提到命名空间时只看策略所在的命名空间（Cilium 的语义）。
// 选择器无法解析或用到其他来源前缀时 ok 为 false。
func ciliumSelect(lk Lookup, c *Contribution, policyNS string, raw any) (map[string]bool, bool) {
	m, _ := raw.(map[string]any)
	var sel metav1.LabelSelector
	if m != nil {
		if err := runtime.DefaultUnstructuredConverter.FromUnstructured(m, &sel); err != nil {
			return nil, false
		}
	}
	scoped := true
	strip := func(k string) (string, bool) {
		if i := strings.Index(k, ":"); i >= 0 {
			if src := k[:i]; src != "k8s" && src != "any" {
				return "", false
			}
			k = k[i+1:]
		}
		if k == ciliumNamespaceKey || strings.HasPrefix(k, ciliumNamespaceLabelKey) {
			scoped = false
		}
		return k, true
	}
	ml := map[string]string{}
	for k, v := range sel.MatchLabels {
		s, ok := strip(k)
		if !ok {
			return nil, false
		}
		ml[s] = v
	}
	var mx []metav1.LabelSelectorRequirement
	for _, r := range sel.MatchExpressions {
		s, ok := strip(r.Key)
		if !ok {
			return nil, false
		}
		r.Key = s
		mx = append(mx, r)
	}
	selector, err := metav1.LabelSelectorAsSelector(&metav1.LabelSelector{MatchLabels: ml, MatchExpressions: mx})
	if err != nil {
		return nil, false
	}
	namespaces := []string{policyNS}
	if !scoped {
		namespaces = lk.Namespaces(labels.Everything())
	}
	out := map[string]bool{}
	for _, ns := range namespaces {
		nsLabels, _ := lk.NamespaceLabels(ns)
		for _, p := range lk.Pods(ns, labels.Everything()) {
			if !selector.Matches(ciliumLabels(p, nsLabels)) {
				continue
			}
			c.addRoot(lk, out, p)
		}
	}
	return out, true
}

func emptyCiliumSelector(raw any) bool {
	m, _ := raw.(map[string]any)
	ml, _ := m["matchLabels"].(map[string]any)
	mx, _ := m["matchExpressions"].([]any)
	return len(ml) == 0 && len(mx) == 0
}

// ciliumLabels 是 Pod 在 Cilium 看来的标签：自己的标签加上命名空间、命名空间标签与服务账号。
func ciliumLabels(p *corev1.Pod, nsLabels map[string]string) labels.Set {
	set := labels.Set{ciliumNamespaceKey: p.Namespace, ciliumServiceAccountKey: p.Spec.ServiceAccountName}
	for k, v := range nsLabels {
		set[ciliumNamespaceLabelKey+k] = v
	}
	for k, v := range p.Labels {
		set[k] = v
	}
	return set
}

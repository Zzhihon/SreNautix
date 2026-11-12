package topology

import (
	"sort"
	"testing"

	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/labels"
)

// cluster 是内存里的集群：命名空间及其标签、Pod 及其 controller，按参考部署的写法组织（SreNautix ADR 0200）。
type cluster struct {
	owners
	ns   map[string]map[string]string
	pods []*corev1.Pod
}

func (c cluster) Namespaces(sel labels.Selector) []string {
	var out []string
	for n, l := range c.ns {
		if sel.Matches(labels.Set(l)) {
			out = append(out, n)
		}
	}
	sort.Strings(out)
	return out
}

func (c cluster) NamespaceLabels(name string) (map[string]string, bool) {
	l, ok := c.ns[name]
	return l, ok
}

func (c cluster) Pods(namespace string, sel labels.Selector) []*corev1.Pod {
	var out []*corev1.Pod
	for _, p := range c.pods {
		if (namespace == "" || p.Namespace == namespace) && sel.Matches(labels.Set(p.Labels)) {
			out = append(out, p)
		}
	}
	return out
}

func pod(ns, name, sa string, lbl map[string]string) *corev1.Pod {
	return &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: name, Labels: lbl}, Spec: corev1.PodSpec{ServiceAccountName: sa}}
}

func testCluster() cluster {
	nsl := func(n string, extra map[string]string) map[string]string {
		l := map[string]string{"kubernetes.io/metadata.name": n}
		for k, v := range extra {
			l[k] = v
		}
		return l
	}
	return cluster{
		owners: owners{
			"Pod/cchp-prod/gateway-0":               {Kind: "StatefulSet", Name: "gateway"},
			"Pod/cchp-prod/control-1":               {Kind: "ReplicaSet", Name: "control-rs"},
			"ReplicaSet/cchp-prod/control-rs":       {Kind: "Deployment", Name: "control"},
			"Pod/cchp-data/cchp-postgres-1":         {Kind: "Cluster.postgresql.cnpg.io", Name: "cchp-postgres"},
			"Pod/observability/grafana-1":           {Kind: "ReplicaSet", Name: "grafana-rs"},
			"ReplicaSet/observability/grafana-rs":   {Kind: "Deployment", Name: "grafana"},
			"Pod/cchp-tunnel/cloudflared-1":         {Kind: "ReplicaSet", Name: "cloudflared-rs"},
			"ReplicaSet/cchp-tunnel/cloudflared-rs": {Kind: "Deployment", Name: "cloudflared"},
			"Pod/cchp-tunnel/sidecar-1":             {Kind: "ReplicaSet", Name: "sidecar-rs"},
			"ReplicaSet/cchp-tunnel/sidecar-rs":     {Kind: "Deployment", Name: "sidecar"},
		},
		ns: map[string]map[string]string{
			"cchp-prod":     nsl("cchp-prod", map[string]string{"tier": "app"}),
			"cchp-data":     nsl("cchp-data", nil),
			"observability": nsl("observability", nil),
			"cchp-tunnel":   nsl("cchp-tunnel", nil),
		},
		pods: []*corev1.Pod{
			pod("cchp-prod", "gateway-0", "gateway", map[string]string{"app": "gateway", "app.kubernetes.io/part-of": "cchp"}),
			pod("cchp-prod", "control-1", "control", map[string]string{"app": "control", "app.kubernetes.io/part-of": "cchp"}),
			pod("cchp-data", "cchp-postgres-1", "pg", map[string]string{"cnpg.io/cluster": "cchp-postgres"}),
			pod("observability", "grafana-1", "grafana", map[string]string{"app.kubernetes.io/name": "grafana"}),
			pod("cchp-tunnel", "cloudflared-1", "cloudflared", map[string]string{"app.kubernetes.io/name": "cloudflared"}),
			pod("cchp-tunnel", "sidecar-1", "sidecar", map[string]string{"app.kubernetes.io/name": "sidecar"}),
		},
	}
}

func edgeSummary(c Contribution) []string {
	var out []string
	for _, e := range c.Edges {
		out = append(out, e.From+" -> "+e.To+" "+string(e.Provenance)+" "+fmtConf(e.Confidence))
	}
	sort.Strings(out)
	return out
}

func fmtConf(f float64) string {
	switch f {
	case ConfNetworkPolicy:
		return "0.6"
	case ConfPolicyAllowed:
		return "0.5"
	}
	return "?"
}

func nsSel(name string) *metav1.LabelSelector {
	return &metav1.LabelSelector{MatchLabels: map[string]string{"kubernetes.io/metadata.name": name}}
}

// 数据库一侧按命名空间放行（参考部署的 postgresql-ingress）：cchp-prod 的每个工作负载都得到一条到数据库的 0.5 边
func TestNetworkPolicyIngressAllowsTheSourcesToReachTheSelectedPods(t *testing.T) {
	np := &networkingv1.NetworkPolicy{
		ObjectMeta: metav1.ObjectMeta{Namespace: "cchp-data", Name: "postgresql-ingress"},
		Spec: networkingv1.NetworkPolicySpec{
			PodSelector: metav1.LabelSelector{MatchLabels: map[string]string{"cnpg.io/cluster": "cchp-postgres"}},
			PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeIngress},
			Ingress: []networkingv1.NetworkPolicyIngressRule{
				{From: []networkingv1.NetworkPolicyPeer{{NamespaceSelector: nsSel("cchp-prod")}}},
				{From: []networkingv1.NetworkPolicyPeer{{IPBlock: &networkingv1.IPBlock{CIDR: "10.0.0.0/8"}}}},
				// 来源是数据库自己：不产生自环
				{From: []networkingv1.NetworkPolicyPeer{{PodSelector: &metav1.LabelSelector{MatchLabels: map[string]string{"cnpg.io/cluster": "cchp-postgres"}}}}},
			},
		},
	}
	c := NetworkPolicyEdges(testCluster(), np)
	equal(t, edgeSummary(c), []string{
		"Deployment:cchp-prod/control -> Cluster.postgresql.cnpg.io:cchp-data/cchp-postgres network_policy 0.5",
		"StatefulSet:cchp-prod/gateway -> Cluster.postgresql.cnpg.io:cchp-data/cchp-postgres network_policy 0.5",
	})
	if c.Edges[0].Evidence != "NetworkPolicy cchp-data/postgresql-ingress ingress" || c.Edges[0].Relation != RelEgressTo {
		t.Fatalf("edge = %+v", c.Edges[0])
	}
}

// 出站规则仍是 0.6；同一对组件既有出站又有入站的放行时保留 0.6 的一条
func TestNetworkPolicyEgressKeepsItsConfidenceOverIngress(t *testing.T) {
	np := &networkingv1.NetworkPolicy{
		ObjectMeta: metav1.ObjectMeta{Namespace: "cchp-prod", Name: "both"},
		Spec: networkingv1.NetworkPolicySpec{
			PodSelector: metav1.LabelSelector{MatchLabels: map[string]string{"app": "gateway"}},
			PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeIngress, networkingv1.PolicyTypeEgress},
			Egress:      []networkingv1.NetworkPolicyEgressRule{{To: []networkingv1.NetworkPolicyPeer{{PodSelector: &metav1.LabelSelector{MatchLabels: map[string]string{"app": "control"}}}}}},
			Ingress:     []networkingv1.NetworkPolicyIngressRule{{From: []networkingv1.NetworkPolicyPeer{{PodSelector: &metav1.LabelSelector{MatchLabels: map[string]string{"app": "control"}}}}}},
		},
	}
	equal(t, edgeSummary(NetworkPolicyEdges(testCluster(), np)), []string{
		"Deployment:cchp-prod/control -> StatefulSet:cchp-prod/gateway network_policy 0.5",
		"StatefulSet:cchp-prod/gateway -> Deployment:cchp-prod/control network_policy 0.6",
	})
}

func cnp(ns, name string, spec map[string]any) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "cilium.io/v2", "kind": "CiliumNetworkPolicy",
		"metadata": map[string]any{"namespace": ns, "name": name},
		"spec":     spec,
	}}
}

func ml(kv ...string) map[string]any {
	m := map[string]any{}
	for i := 0; i+1 < len(kv); i += 2 {
		m[kv[i]] = kv[i+1]
	}
	return map[string]any{"matchLabels": m}
}

// 参考部署的 cloudflared 出站策略：带命名空间标签的对端跨命名空间，不带的只在策略所在的命名空间；toEntities、保留标签不产生边
func TestCiliumPolicyEgressAndIngress(t *testing.T) {
	r := ciliumPolicy{}
	obj := cnp("cchp-tunnel", "cloudflared", map[string]any{
		"endpointSelector": ml("app.kubernetes.io/name", "cloudflared"),
		"egress": []any{
			map[string]any{"toEndpoints": []any{
				ml("k8s:io.kubernetes.pod.namespace", "observability", "app.kubernetes.io/name", "grafana"),
				ml("k8s:app.kubernetes.io/name", "sidecar"),
				// 不带命名空间标签：只看 cchp-tunnel，cchp-prod 的 gateway 不算
				ml("app", "gateway"),
				ml("reserved:host", ""),
			}},
			map[string]any{"toEntities": []any{"world"}},
		},
		"ingress": []any{
			map[string]any{"fromEndpoints": []any{
				map[string]any{"matchExpressions": []any{map[string]any{
					"key": "k8s:io.cilium.k8s.namespace.labels.tier", "operator": "In", "values": []any{"app"},
				}}},
			}},
		},
	})
	c := r.ExtractWith(testCluster(), obj)
	equal(t, edgeSummary(c), []string{
		"Deployment:cchp-prod/control -> Deployment:cchp-tunnel/cloudflared network_policy 0.5",
		"Deployment:cchp-tunnel/cloudflared -> Deployment:cchp-tunnel/sidecar network_policy 0.5",
		"Deployment:cchp-tunnel/cloudflared -> Deployment:observability/grafana network_policy 0.5",
		"StatefulSet:cchp-prod/gateway -> Deployment:cchp-tunnel/cloudflared network_policy 0.5",
	})
	// 策略自己是节点；没有 Lookup 的 Extract 只给节点
	if got := r.Extract(obj); len(got.Edges) != 0 || len(got.Nodes) != 1 {
		t.Fatalf("Extract = %+v", got)
	}
}

// specs 列表与服务账号保留键
func TestCiliumPolicySpecsAndServiceAccount(t *testing.T) {
	obj := cnp("cchp-prod", "by-sa", nil)
	delete(obj.Object, "spec")
	obj.Object["specs"] = []any{map[string]any{
		"endpointSelector": ml("k8s:io.cilium.k8s.policy.serviceaccount", "gateway"),
		"egress": []any{map[string]any{"toEndpoints": []any{
			ml("k8s:io.kubernetes.pod.namespace", "cchp-data", "cnpg.io/cluster", "cchp-postgres"),
		}}},
	}}
	equal(t, edgeSummary(ciliumPolicy{}.ExtractWith(testCluster(), obj)), []string{
		"StatefulSet:cchp-prod/gateway -> Cluster.postgresql.cnpg.io:cchp-data/cchp-postgres network_policy 0.5",
	})
}

// "命名空间内全部 Pod 互相放行"不说明依赖：策略与对端都为空选择器的入站规则不产生边，Cilium 同理
func TestNamespaceMeshRulesProduceNoEdges(t *testing.T) {
	all := metav1.LabelSelector{}
	np := &networkingv1.NetworkPolicy{
		ObjectMeta: metav1.ObjectMeta{Namespace: "cchp-tunnel", Name: "mesh"},
		Spec: networkingv1.NetworkPolicySpec{
			PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeIngress},
			Ingress: []networkingv1.NetworkPolicyIngressRule{{From: []networkingv1.NetworkPolicyPeer{
				{PodSelector: &all},
				// 跨命名空间的来源仍然产生边
				{NamespaceSelector: nsSel("observability")},
			}}},
		},
	}
	equal(t, edgeSummary(NetworkPolicyEdges(testCluster(), np)), []string{
		"Deployment:observability/grafana -> Deployment:cchp-tunnel/cloudflared network_policy 0.5",
		"Deployment:observability/grafana -> Deployment:cchp-tunnel/sidecar network_policy 0.5",
	})
	mesh := cnp("cchp-tunnel", "mesh", map[string]any{
		"endpointSelector": map[string]any{},
		"ingress":          []any{map[string]any{"fromEndpoints": []any{map[string]any{}}}},
	})
	equal(t, edgeSummary(ciliumPolicy{}.ExtractWith(testCluster(), mesh)), nil)
}

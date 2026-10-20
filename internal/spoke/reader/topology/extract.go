package topology

import (
	"fmt"
	"sort"
	"strings"

	corev1 "k8s.io/api/core/v1"
	discoveryv1 "k8s.io/api/discovery/v1"
	networkingv1 "k8s.io/api/networking/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

const (
	RelOwnedBy         = "owned_by"
	RelRunsOn          = "runs_on"
	RelMounts          = "mounts"
	RelBoundTo         = "bound_to"
	RelProvisionedBy   = "provisioned_by"
	RelCSINodePlugin   = "csi_node_plugin"
	RelSelects         = "selects"
	RelRoutesTo        = "routes_to"
	RelAttachedTo      = "attached_to"
	RelManagedBy       = "managed_by"
	RelReferences      = "references"
	RelEgressTo        = "egress_to"
	RelOperatorConv    = "operator_convention"
	RelPrimary         = "primary"
	RelReplica         = "replica"
	KindCSIDriver      = "CSIDriver"
	registrarContainer = "csi-node-driver-registrar"
)

// hubWorkloads 是集群枢纽（DESIGN §4.3）：CoreDNS、CNI、kube-proxy。按 kube-system 中的 k8s-app 标签识别。
var hubWorkloads = map[string]bool{
	"kube-dns": true, "coredns": true, "cilium": true, "calico-node": true, "flannel": true,
	"canal": true, "kube-router": true, "kube-proxy": true, "antrea-agent": true, "weave-net": true,
}

func isHub(namespace string, lbl map[string]string) bool {
	if namespace != "kube-system" && namespace != "calico-system" {
		return false
	}
	return hubWorkloads[lbl["k8s-app"]] || hubWorkloads[lbl["app.kubernetes.io/name"]]
}

// ObjectNode 构造对象自己的节点。对象无法生成合法的键时返回 *KeyError。
func ObjectNode(kind string, obj metav1.Object) (Node, error) {
	n, err := NewNode(kind, obj.GetNamespace(), obj.GetName(), string(obj.GetUID()), obj.GetLabels())
	if err != nil {
		return Node{}, err
	}
	n.Hub = isHub(obj.GetNamespace(), obj.GetLabels())
	return n, nil
}

// generic 贡献对象自己的节点与 ownerReferences 产生的占位节点和 owned_by 边，并返回对象自己的键。
// 对象自己无法生成合法的键时只返回问题，键为空串。
func generic(kind string, obj metav1.Object) (Contribution, string) {
	var c Contribution
	self, err := ObjectNode(kind, obj)
	if err != nil {
		c.Problems = append(c.Problems, KeyProblem(err))
		return c, ""
	}
	c.Nodes = append(c.Nodes, NodeContribution{Node: self, Own: true})
	for _, ref := range obj.GetOwnerReferences() {
		gv, err := schema.ParseGroupVersion(ref.APIVersion)
		if err != nil {
			c.fail(kind, obj.GetNamespace(), obj.GetName(), fmt.Sprintf("ownerReference %q has invalid apiVersion %q", ref.Name, ref.APIVersion))
			continue
		}
		ok := KindName(gv.Group, ref.Kind)
		// 集群级 owner（例如静态 Pod 的 Node）没有命名空间
		owner := c.ref(ok, OwnerNamespace(ok, obj.GetNamespace()), ref.Name, string(ref.UID), false)
		ev := "ownerReference"
		if ref.Controller != nil && *ref.Controller {
			ev = "ownerReference (controller)"
		}
		c.edge(Structural(self.Key, owner, RelOwnedBy, ScopeService, ev))
	}
	return c, self.Key
}

// Generic 是只贡献自身节点和 owner 边的对象（Node、ReplicaSet、Deployment、StatefulSet、DaemonSet、Job、CronJob、Service 等）。
func Generic(kind string, obj metav1.Object) Contribution {
	c, _ := generic(kind, obj)
	return c
}

// Pod 贡献 Pod 节点、owner 边、Pod→Node、Pod→PVC、PV→CSI node plugin，以及配置引用边。
func Pod(lk Lookup, pod *corev1.Pod) Contribution {
	c, self := generic("Pod", pod)
	if self == "" {
		return c
	}
	if pod.Spec.NodeName != "" {
		node := c.ref("Node", "", pod.Spec.NodeName, "", false)
		c.edge(Structural(self, node, RelRunsOn, ScopeInstance, "spec.nodeName"))
	}
	for _, v := range pod.Spec.Volumes {
		var claim string
		switch {
		case v.PersistentVolumeClaim != nil:
			claim = v.PersistentVolumeClaim.ClaimName
		case v.Ephemeral != nil:
			claim = pod.Name + "-" + v.Name
		default:
			continue
		}
		pvc := c.ref("PersistentVolumeClaim", pod.Namespace, claim, "", false)
		c.edge(Structural(self, pvc, RelMounts, ScopeInstance, "volume "+v.Name))
		csiPluginEdge(lk, pod, claim, &c)
	}
	configRefs(lk, pod, &c)
	return c
}

// csiPluginEdge 贡献 PV → 本节点 CSI node plugin Pod 的边：PV 在哪个节点上被使用，就依赖那个节点上的 node plugin。
func csiPluginEdge(lk Lookup, pod *corev1.Pod, claim string, c *Contribution) {
	if pod.Spec.NodeName == "" {
		return
	}
	pvc, ok := lk.PVC(pod.Namespace, claim)
	if !ok || pvc.Spec.VolumeName == "" {
		return
	}
	pv, ok := lk.PV(pvc.Spec.VolumeName)
	if !ok || pv.Spec.CSI == nil {
		return
	}
	plugin, ok := lk.CSINodePlugin(pv.Spec.CSI.Driver, pod.Spec.NodeName)
	if !ok {
		return
	}
	pn := c.ref("Pod", plugin.Namespace, plugin.Name, string(plugin.UID), false)
	c.edge(Structural(c.key("PersistentVolume", "", pv.Name), pn, RelCSINodePlugin, ScopeInstance,
		"driver "+pv.Spec.CSI.Driver+" on node "+pod.Spec.NodeName))
}

// configRefs 贡献配置引用边（DESIGN §4.2，置信度 0.7），起点是 Pod 的顶层 owner（通常是 Deployment 或 StatefulSet）。
// 只输出名称：Service DNS 名、ConfigMap 名、Secret 名；环境变量和 ConfigMap 的取值不进入输出。Secret 从不读取。
func configRefs(lk Lookup, pod *corev1.Pod, c *Contribution) {
	from, err := RootOwner(lk, "Pod", pod.Namespace, pod.Name)
	if err != nil {
		c.Problems = append(c.Problems, KeyProblem(err))
		return
	}
	ns := pod.Namespace
	edges := map[string]Edge{}
	add := func(to, evidence string) {
		if to == "" {
			return
		}
		e := Edge{From: from, To: to, Relation: RelReferences, Provenance: ProvConfigRef, Confidence: ConfConfigRef, Scope: ScopeService, Evidence: clip(evidence)}
		if _, ok := edges[e.ID()]; !ok {
			edges[e.ID()] = e
		}
	}
	svc := func(value, evidence string) {
		for _, r := range FindServiceRefs(lk, ns, value) {
			add(c.key("Service", r.Namespace, r.Name), evidence)
		}
	}
	cmAll := func(name, evidence string) {
		add(c.key("ConfigMap", ns, name), evidence)
		cm, ok := lk.ConfigMap(ns, name)
		if !ok {
			return
		}
		keys := make([]string, 0, len(cm.Data))
		for k := range cm.Data {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			svc(cm.Data[k], "ConfigMap "+name+" key "+k)
		}
	}
	containers := append(append([]corev1.Container{}, pod.Spec.InitContainers...), pod.Spec.Containers...)
	for _, ct := range containers {
		for _, env := range ct.Env {
			switch {
			case env.ValueFrom == nil:
				svc(env.Value, "env "+env.Name)
			case env.ValueFrom.ConfigMapKeyRef != nil:
				ref := env.ValueFrom.ConfigMapKeyRef
				add(c.key("ConfigMap", ns, ref.Name), "env "+env.Name)
				if cm, ok := lk.ConfigMap(ns, ref.Name); ok {
					svc(cm.Data[ref.Key], "env "+env.Name+" from ConfigMap "+ref.Name+" key "+ref.Key)
				}
			case env.ValueFrom.SecretKeyRef != nil:
				add(c.key("Secret", ns, env.ValueFrom.SecretKeyRef.Name), "env "+env.Name+" secretKeyRef")
			}
		}
		for _, ef := range ct.EnvFrom {
			if ef.ConfigMapRef != nil {
				cmAll(ef.ConfigMapRef.Name, "envFrom ConfigMap "+ef.ConfigMapRef.Name)
			}
			if ef.SecretRef != nil {
				add(c.key("Secret", ns, ef.SecretRef.Name), "envFrom Secret")
			}
		}
	}
	for _, v := range pod.Spec.Volumes {
		switch {
		case v.ConfigMap != nil:
			cmAll(v.ConfigMap.Name, "volume "+v.Name)
		case v.Secret != nil:
			add(c.key("Secret", ns, v.Secret.SecretName), "volume "+v.Name)
		case v.Projected != nil:
			for _, src := range v.Projected.Sources {
				if src.ConfigMap != nil {
					cmAll(src.ConfigMap.Name, "projected volume "+v.Name)
				}
				if src.Secret != nil {
					add(c.key("Secret", ns, src.Secret.Name), "projected volume "+v.Name)
				}
			}
		}
	}
	ids := make([]string, 0, len(edges))
	for id := range edges {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		c.Edges = append(c.Edges, edges[id])
	}
}

// PVC 贡献 PVC → PV。
func PVC(pvc *corev1.PersistentVolumeClaim) Contribution {
	c, self := generic("PersistentVolumeClaim", pvc)
	if self != "" && pvc.Spec.VolumeName != "" {
		pv := c.ref("PersistentVolume", "", pvc.Spec.VolumeName, "", false)
		c.edge(Structural(self, pv, RelBoundTo, ScopeInstance, "spec.volumeName"))
	}
	return c
}

// PV 贡献 PV → CSIDriver。CSIDriver 是存储枢纽。
func PV(pv *corev1.PersistentVolume) Contribution {
	c, self := generic("PersistentVolume", pv)
	if self != "" && pv.Spec.CSI != nil {
		d := c.ref(KindCSIDriver, "", pv.Spec.CSI.Driver, "", true)
		c.edge(Structural(self, d, RelProvisionedBy, ScopeInstance, "spec.csi.driver"))
	}
	return c
}

// EndpointSlice 贡献 Service → Pod（selects）。EndpointSlice 自身不成为节点。
func EndpointSlice(es *discoveryv1.EndpointSlice) Contribution {
	var c Contribution
	svcName := es.Labels[discoveryv1.LabelServiceName]
	if svcName == "" {
		return c
	}
	svc := c.ref("Service", es.Namespace, svcName, "", false)
	if svc == "" {
		return c
	}
	for _, ep := range es.Endpoints {
		if ep.TargetRef == nil || ep.TargetRef.Kind != "Pod" {
			continue
		}
		ns := ep.TargetRef.Namespace
		if ns == "" {
			ns = es.Namespace
		}
		p := c.ref("Pod", ns, ep.TargetRef.Name, string(ep.TargetRef.UID), false)
		c.edge(Structural(svc, p, RelSelects, ScopeService, "EndpointSlice "+es.Name))
	}
	return c
}

// Ingress 贡献 Ingress → Service（routes_to）。
func Ingress(ing *networkingv1.Ingress) Contribution {
	c, self := generic("Ingress", ing)
	if self == "" {
		return c
	}
	add := func(b *networkingv1.IngressBackend, ev string) {
		if b == nil || b.Service == nil {
			return
		}
		s := c.ref("Service", ing.Namespace, b.Service.Name, "", false)
		c.edge(Structural(self, s, RelRoutesTo, ScopeService, ev))
	}
	add(ing.Spec.DefaultBackend, "defaultBackend")
	for _, r := range ing.Spec.Rules {
		if r.HTTP == nil {
			continue
		}
		for _, p := range r.HTTP.Paths {
			add(&p.Backend, "rule "+r.Host+p.Path)
		}
	}
	return c
}

// NetworkPolicyEgress 贡献 NetworkPolicy 出站规则推出的边（DESIGN §4.2，置信度 0.6）：
// 被策略选中的 Pod 的顶层 owner → 出站规则允许的对端 Pod 的顶层 owner。ipBlock 对端不产生边；没有 to 的规则（放行全部）也不产生边。
func NetworkPolicyEgress(lk Lookup, np *networkingv1.NetworkPolicy) Contribution {
	var c Contribution
	if !hasEgress(np) {
		return c
	}
	fail := func(field string, err error) Contribution {
		c.fail("NetworkPolicy", np.Namespace, np.Name, field+": "+err.Error())
		return c
	}
	root := func(p *corev1.Pod, into map[string]bool) {
		k, err := RootOwner(lk, "Pod", p.Namespace, p.Name)
		if err != nil {
			c.Problems = append(c.Problems, KeyProblem(err))
			return
		}
		into[k] = true
	}
	srcSel, err := metav1.LabelSelectorAsSelector(&np.Spec.PodSelector)
	if err != nil {
		return fail("podSelector", err)
	}
	sources := map[string]bool{}
	for _, p := range lk.Pods(np.Namespace, srcSel) {
		root(p, sources)
	}
	if len(sources) == 0 {
		return c
	}
	dests := map[string]bool{}
	for _, rule := range np.Spec.Egress {
		for _, peer := range rule.To {
			if peer.PodSelector == nil && peer.NamespaceSelector == nil {
				continue
			}
			namespaces := []string{np.Namespace}
			if peer.NamespaceSelector != nil {
				nsSel, err := metav1.LabelSelectorAsSelector(peer.NamespaceSelector)
				if err != nil {
					return fail("egress namespaceSelector", err)
				}
				namespaces = lk.Namespaces(nsSel)
			}
			podSel := labels.Everything()
			if peer.PodSelector != nil {
				podSel, err = metav1.LabelSelectorAsSelector(peer.PodSelector)
				if err != nil {
					return fail("egress podSelector", err)
				}
			}
			for _, ns := range namespaces {
				for _, p := range lk.Pods(ns, podSel) {
					root(p, dests)
				}
			}
		}
	}
	ev := "NetworkPolicy " + np.Namespace + "/" + np.Name
	for _, s := range sortedKeys(sources) {
		for _, d := range sortedKeys(dests) {
			if s == d {
				continue
			}
			c.Edges = append(c.Edges, Edge{From: s, To: d, Relation: RelEgressTo, Provenance: ProvNetworkPolicy, Confidence: ConfNetworkPolicy, Scope: ScopeService, Evidence: ev})
		}
	}
	return c
}

func hasEgress(np *networkingv1.NetworkPolicy) bool {
	for _, t := range np.Spec.PolicyTypes {
		if t == networkingv1.PolicyTypeEgress {
			return true
		}
	}
	return len(np.Spec.Egress) > 0
}

func sortedKeys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// IsCSINodePlugin 判断 Pod 是否为 driver 的 CSI node plugin：带 node-driver-registrar 容器，且其参数里出现 driver 名称
// （kubelet 注册路径 /var/lib/kubelet/plugins/<driver>/csi.sock）。
func IsCSINodePlugin(pod *corev1.Pod, driver string) bool {
	for _, ct := range pod.Spec.Containers {
		if ct.Name != registrarContainer && !strings.Contains(ct.Image, registrarContainer) {
			continue
		}
		for _, a := range append(append([]string{}, ct.Command...), ct.Args...) {
			if strings.Contains(a, "/"+driver+"/") {
				return true
			}
		}
	}
	return false
}

// HasCSIRegistrar 判断 Pod 是否带 node-driver-registrar 容器。
func HasCSIRegistrar(pod *corev1.Pod) bool {
	for _, ct := range pod.Spec.Containers {
		if ct.Name == registrarContainer || strings.Contains(ct.Image, registrarContainer) {
			return true
		}
	}
	return false
}

package topology

import (
	"fmt"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"sigs.k8s.io/cli-utils/pkg/object"
	gatewayv1 "sigs.k8s.io/gateway-api/apis/v1"
)

// Recognizer 把一种自定义资源转换成拓扑贡献。reader 只为 apiserver 实际提供的资源启动 informer，
// CRD 晚于 reader 安装时，下一次资源发现会补上。领域包声明的 Operator 约定通过实现这个接口接入。
type Recognizer interface {
	// Resource 是要监听的资源。
	Resource() schema.GroupVersionResource
	// Kind 是资源的 Kind。
	Kind() string
	// Extract 返回对象的贡献。
	Extract(obj *unstructured.Unstructured) Contribution
}

// BuiltinRecognizers 返回内置的自定义资源识别器：Argo CD Application、Flux Kustomization、Gateway API HTTPRoute、CNPG Cluster。
func BuiltinRecognizers() []Recognizer {
	return []Recognizer{argoApplication{}, fluxKustomization{}, httpRoute{}, cnpgCluster{}}
}

func crdKind(r Recognizer) string { return KindName(r.Resource().Group, r.Kind()) }

func nestedSlice(obj *unstructured.Unstructured, fields ...string) []any {
	v, found, err := unstructured.NestedSlice(obj.Object, fields...)
	if err != nil {
		panic(fmt.Sprintf("topology: %s %s/%s field %v: %v", obj.GetKind(), obj.GetNamespace(), obj.GetName(), fields, err))
	}
	if !found {
		return nil
	}
	return v
}

func nestedString(m map[string]any, fields ...string) string {
	v, _, err := unstructured.NestedString(m, fields...)
	if err != nil {
		panic(fmt.Sprintf("topology: field %v: %v", fields, err))
	}
	return v
}

// ── Argo CD Application ─────────────────────────────────────────

type argoApplication struct{}

func (argoApplication) Resource() schema.GroupVersionResource {
	return schema.GroupVersionResource{Group: "argoproj.io", Version: "v1alpha1", Resource: "applications"}
}
func (argoApplication) Kind() string { return "Application" }

// Extract：status.resources 中的每个受管资源 → Application（managed_by）。Application 的同步会改变它管理的资源。
// 目标是其他集群的 Application 不产生受管资源边，那些资源由目标集群的 reader 负责。
func (r argoApplication) Extract(obj *unstructured.Unstructured) Contribution {
	kind := crdKind(r)
	c := Generic(kind, obj)
	app := Key(kind, obj.GetNamespace(), obj.GetName())
	server := nestedString(obj.Object, "spec", "destination", "server")
	dest := nestedString(obj.Object, "spec", "destination", "name")
	if !(server == "https://kubernetes.default.svc" || (server == "" && dest == "in-cluster")) {
		return c
	}
	for _, item := range nestedSlice(obj, "status", "resources") {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		rk, name := nestedString(m, "kind"), nestedString(m, "name")
		if rk == "" || name == "" {
			continue
		}
		res := NewNode(KindName(nestedString(m, "group"), rk), nestedString(m, "namespace"), name, "", nil)
		c.Nodes = append(c.Nodes, NodeContribution{Node: res})
		c.Edges = append(c.Edges, Structural(res.Key, app, RelManagedBy, ScopeService, "Argo CD status.resources"))
	}
	return c
}

// ── Flux Kustomization ─────────────────────────────────────────

type fluxKustomization struct{}

func (fluxKustomization) Resource() schema.GroupVersionResource {
	return schema.GroupVersionResource{Group: "kustomize.toolkit.fluxcd.io", Version: "v1", Resource: "kustomizations"}
}
func (fluxKustomization) Kind() string { return "Kustomization" }

// Extract：status.inventory.entries 中的每个资源 → Kustomization（managed_by）。条目 ID 用 cli-utils 的 ObjMetadata 格式解析。
func (r fluxKustomization) Extract(obj *unstructured.Unstructured) Contribution {
	kind := crdKind(r)
	c := Generic(kind, obj)
	ks := Key(kind, obj.GetNamespace(), obj.GetName())
	for _, item := range nestedSlice(obj, "status", "inventory", "entries") {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		meta, err := object.ParseObjMetadata(nestedString(m, "id"))
		if err != nil {
			panic(fmt.Sprintf("topology: Kustomization %s/%s inventory entry: %v", obj.GetNamespace(), obj.GetName(), err))
		}
		res := NewNode(KindName(meta.GroupKind.Group, meta.GroupKind.Kind), meta.Namespace, meta.Name, "", nil)
		c.Nodes = append(c.Nodes, NodeContribution{Node: res})
		c.Edges = append(c.Edges, Structural(res.Key, ks, RelManagedBy, ScopeService, "Flux status.inventory"))
	}
	return c
}

// ── Gateway API HTTPRoute ─────────────────────────────────────

type httpRoute struct{}

func (httpRoute) Resource() schema.GroupVersionResource {
	return schema.GroupVersionResource{Group: "gateway.networking.k8s.io", Version: "v1", Resource: "httproutes"}
}
func (httpRoute) Kind() string { return "HTTPRoute" }

// Extract：HTTPRoute → backendRefs 指向的 Service（routes_to）；HTTPRoute → parentRefs 指向的 Gateway（attached_to）。
func (r httpRoute) Extract(obj *unstructured.Unstructured) Contribution {
	var route gatewayv1.HTTPRoute
	if err := runtime.DefaultUnstructuredConverter.FromUnstructured(obj.Object, &route); err != nil {
		panic(fmt.Sprintf("topology: HTTPRoute %s/%s: %v", obj.GetNamespace(), obj.GetName(), err))
	}
	kind := crdKind(r)
	c := Generic(kind, obj)
	self := Key(kind, route.Namespace, route.Name)
	for _, p := range route.Spec.ParentRefs {
		group, pk := gatewayv1.GroupName, "Gateway"
		if p.Group != nil {
			group = string(*p.Group)
		}
		if p.Kind != nil {
			pk = string(*p.Kind)
		}
		ns := route.Namespace
		if p.Namespace != nil {
			ns = string(*p.Namespace)
		}
		parent := NewNode(KindName(group, pk), ns, string(p.Name), "", nil)
		c.Nodes = append(c.Nodes, NodeContribution{Node: parent})
		c.Edges = append(c.Edges, Structural(self, parent.Key, RelAttachedTo, ScopeService, "parentRefs"))
	}
	for _, rule := range route.Spec.Rules {
		for _, b := range rule.BackendRefs {
			group, bk := "", "Service"
			if b.Group != nil {
				group = string(*b.Group)
			}
			if b.Kind != nil {
				bk = string(*b.Kind)
			}
			ns := route.Namespace
			if b.Namespace != nil {
				ns = string(*b.Namespace)
			}
			be := NewNode(KindName(group, bk), ns, string(b.Name), "", nil)
			c.Nodes = append(c.Nodes, NodeContribution{Node: be})
			c.Edges = append(c.Edges, Structural(self, be.Key, RelRoutesTo, ScopeService, "backendRefs"))
		}
	}
	return c
}

// ── CNPG Cluster ─────────────────────────────────────────────

type cnpgCluster struct{}

func (cnpgCluster) Resource() schema.GroupVersionResource {
	return schema.GroupVersionResource{Group: "postgresql.cnpg.io", Version: "v1", Resource: "clusters"}
}
func (cnpgCluster) Kind() string { return "Cluster" }

// Extract 实现 CNPG 的 Operator 约定（DESIGN §4.2）：<cluster>-rw / -ro / -r 三个 Service 指向 Cluster；
// Cluster 依赖 status.currentPrimary（primary）和其余 status.instanceNames（replica）。
func (r cnpgCluster) Extract(obj *unstructured.Unstructured) Contribution {
	kind := crdKind(r)
	c := Generic(kind, obj)
	ns, name := obj.GetNamespace(), obj.GetName()
	self := Key(kind, ns, name)
	for _, suffix := range []string{"-rw", "-ro", "-r"} {
		svc := NewNode("Service", ns, name+suffix, "", nil)
		c.Nodes = append(c.Nodes, NodeContribution{Node: svc})
		c.Edges = append(c.Edges, Structural(svc.Key, self, RelOperatorConv, ScopeService, "CNPG service "+name+suffix))
	}
	primary := nestedString(obj.Object, "status", "currentPrimary")
	if primary != "" {
		p := NewNode("Pod", ns, primary, "", nil)
		c.Nodes = append(c.Nodes, NodeContribution{Node: p})
		c.Edges = append(c.Edges, Structural(self, p.Key, RelPrimary, ScopeService, "status.currentPrimary"))
	}
	for _, item := range nestedSlice(obj, "status", "instanceNames") {
		inst, ok := item.(string)
		if !ok || inst == primary || inst == "" {
			continue
		}
		p := NewNode("Pod", ns, inst, "", nil)
		c.Nodes = append(c.Nodes, NodeContribution{Node: p})
		c.Edges = append(c.Edges, Structural(self, p.Key, RelReplica, ScopeService, "status.instanceNames"))
	}
	return c
}

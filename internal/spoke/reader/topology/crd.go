package topology

import (
	"fmt"
	"strings"

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

// fields 读取自定义资源的字段。字段类型与预期不符时记录一个问题，按字段缺失处理。
type fields struct {
	c    *Contribution
	kind string
	obj  *unstructured.Unstructured
}

func (f fields) slice(path ...string) []any {
	v, _, err := unstructured.NestedSlice(f.obj.Object, path...)
	if err != nil {
		f.c.fail(f.kind, f.obj.GetNamespace(), f.obj.GetName(), fmt.Sprintf("field %s: %v", strings.Join(path, "."), err))
		return nil
	}
	return v
}

func (f fields) str(m map[string]any, path ...string) string {
	v, _, err := unstructured.NestedString(m, path...)
	if err != nil {
		f.c.fail(f.kind, f.obj.GetNamespace(), f.obj.GetName(), fmt.Sprintf("field %s: %v", strings.Join(path, "."), err))
		return ""
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
// 单个受管资源的键无法生成（例如名称超长）时只跳过这一项，Application 与其余受管资源照常进入拓扑。
func (r argoApplication) Extract(obj *unstructured.Unstructured) Contribution {
	kind := crdKind(r)
	c, app := generic(kind, obj)
	if app == "" {
		return c
	}
	f := fields{c: &c, kind: kind, obj: obj}
	server := f.str(obj.Object, "spec", "destination", "server")
	dest := f.str(obj.Object, "spec", "destination", "name")
	if !(server == "https://kubernetes.default.svc" || (server == "" && dest == "in-cluster")) {
		return c
	}
	for _, item := range f.slice("status", "resources") {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		rk, name := f.str(m, "kind"), f.str(m, "name")
		if rk == "" || name == "" {
			continue
		}
		res := c.ref(KindName(f.str(m, "group"), rk), f.str(m, "namespace"), name, "", false)
		c.edge(Structural(res, app, RelManagedBy, ScopeService, "Argo CD status.resources"))
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
	c, ks := generic(kind, obj)
	if ks == "" {
		return c
	}
	f := fields{c: &c, kind: kind, obj: obj}
	for _, item := range f.slice("status", "inventory", "entries") {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		meta, err := object.ParseObjMetadata(f.str(m, "id"))
		if err != nil {
			c.fail(kind, obj.GetNamespace(), obj.GetName(), "status.inventory entry: "+err.Error())
			continue
		}
		res := c.ref(KindName(meta.GroupKind.Group, meta.GroupKind.Kind), meta.Namespace, meta.Name, "", false)
		c.edge(Structural(res, ks, RelManagedBy, ScopeService, "Flux status.inventory"))
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
	kind := crdKind(r)
	c, self := generic(kind, obj)
	if self == "" {
		return c
	}
	var route gatewayv1.HTTPRoute
	if err := runtime.DefaultUnstructuredConverter.FromUnstructured(obj.Object, &route); err != nil {
		c.fail(kind, obj.GetNamespace(), obj.GetName(), "spec: "+err.Error())
		return c
	}
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
		parent := c.ref(KindName(group, pk), ns, string(p.Name), "", false)
		c.edge(Structural(self, parent, RelAttachedTo, ScopeService, "parentRefs"))
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
			be := c.ref(KindName(group, bk), ns, string(b.Name), "", false)
			c.edge(Structural(self, be, RelRoutesTo, ScopeService, "backendRefs"))
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
	c, self := generic(kind, obj)
	if self == "" {
		return c
	}
	ns, name := obj.GetNamespace(), obj.GetName()
	f := fields{c: &c, kind: kind, obj: obj}
	for _, suffix := range []string{"-rw", "-ro", "-r"} {
		svc := c.ref("Service", ns, name+suffix, "", false)
		c.edge(Structural(svc, self, RelOperatorConv, ScopeService, "CNPG service "+name+suffix))
	}
	primary := f.str(obj.Object, "status", "currentPrimary")
	if primary != "" {
		p := c.ref("Pod", ns, primary, "", false)
		c.edge(Structural(self, p, RelPrimary, ScopeService, "status.currentPrimary"))
	}
	for _, item := range f.slice("status", "instanceNames") {
		inst, ok := item.(string)
		if !ok || inst == primary || inst == "" {
			continue
		}
		p := c.ref("Pod", ns, inst, "", false)
		c.edge(Structural(self, p, RelReplica, ScopeService, "status.instanceNames"))
	}
	return c
}

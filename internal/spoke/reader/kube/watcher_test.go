package kube

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"
	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	discoveryv1 "k8s.io/api/discovery/v1"
	networkingv1 "k8s.io/api/networking/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/discovery"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/utils/ptr"
	"sigs.k8s.io/controller-runtime/pkg/envtest"

	"github.com/Zzhihon/SreNautix/internal/spoke/reader/clock"
	"github.com/Zzhihon/SreNautix/internal/spoke/reader/testenv"
	"github.com/Zzhihon/SreNautix/internal/spoke/reader/topology"
)

// replica 按事件流重放出的拓扑，用来验证事件流与 Store 快照一致。
type replica struct {
	mu      sync.Mutex
	events  []topology.Event
	nodes   map[string]topology.Node
	edges   map[string]topology.Edge
	lastSeq int64
	t       *testing.T
}

func newReplica(t *testing.T) *replica {
	return &replica{nodes: map[string]topology.Node{}, edges: map[string]topology.Edge{}, t: t}
}

func (r *replica) sink(evs []topology.Event) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, e := range evs {
		if e.Seq != r.lastSeq+1 {
			r.t.Errorf("event seq %d after %d: stream is not contiguous", e.Seq, r.lastSeq)
		}
		r.lastSeq = e.Seq
		r.events = append(r.events, e)
		switch e.Op {
		case topology.OpNodeUpsert:
			r.nodes[e.Node.Key] = *e.Node
		case topology.OpNodeDelete:
			delete(r.nodes, e.Node.Key)
		case topology.OpEdgeUpsert:
			r.edges[e.Edge.ID()] = *e.Edge
		case topology.OpEdgeDelete:
			delete(r.edges, e.Edge.ID())
		}
	}
}

func (r *replica) hasEdge(id string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	_, ok := r.edges[id]
	return ok
}

func (r *replica) edge(id string) (topology.Edge, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	e, ok := r.edges[id]
	return e, ok
}

func (r *replica) node(key string) (topology.Node, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	n, ok := r.nodes[key]
	return n, ok
}

func (r *replica) edgeIDs() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]string, 0, len(r.edges))
	for id := range r.edges {
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}

// must 返回 apiserver 调用的结果；出错时就地 panic，测试随之失败。
func must[T any](obj T, err error) T {
	if err != nil {
		panic(err)
	}
	return obj
}

func ns(name string, labels map[string]string) *corev1.Namespace {
	return &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: name, Labels: labels}}
}

func svc(namespace, name string) *corev1.Service {
	return &corev1.Service{ObjectMeta: metav1.ObjectMeta{Namespace: namespace, Name: name},
		Spec: corev1.ServiceSpec{Ports: []corev1.ServicePort{{Port: 80}}}}
}

func ctrlRef(apiVersion, kind, name string, uid types.UID) metav1.OwnerReference {
	return metav1.OwnerReference{APIVersion: apiVersion, Kind: kind, Name: name, UID: uid, Controller: ptr.To(true)}
}

func mustQty(s string) resource.Quantity { return resource.MustParse(s) }

func quietLog() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

// 回归：Argo CD Application 的 status.resources 里有名称带冒号的 RBAC 对象（cert-manager 的 ClusterRole）时，
// reader 曾在 informer 回调中 panic 退出。现在冒号按 ADR 0034 编码进入拓扑；仍然无法生成键的条目（命名空间不是 DNS 标签、
// kind 含空格）只跳过它自己并计数，Application 的其余受管资源与集群中其他对象的拓扑完整。
// 回归：静态 Pod 的 controller owner 是 Node。顶层 owner 的键曾带上 Pod 的命名空间，拓扑里出现虚构的
// Node:kube-system/<节点>。owner 边、配置引用边、NetworkPolicy 出站边与墓碑的 root_owner 都必须指向集群级的 Node:<节点>。
func TestWatcherStaticPodOwnedByNode(t *testing.T) {
	cfg, _ := testenv.StartKube(t, false)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cs := kubernetes.NewForConfigOrDie(cfg)
	c := context.Background()

	// kube-system 由 apiserver 自己创建
	node := must(cs.CoreV1().Nodes().Create(c, &corev1.Node{ObjectMeta: metav1.ObjectMeta{Name: "control-plane-01"}}, metav1.CreateOptions{}))
	must(cs.CoreV1().Services("kube-system").Create(c, svc("kube-system", "metrics"), metav1.CreateOptions{}))
	must(cs.CoreV1().Pods("kube-system").Create(c, &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Namespace: "kube-system", Name: "etcd-control-plane-01", Labels: map[string]string{"component": "etcd"},
			OwnerReferences: []metav1.OwnerReference{ctrlRef("v1", "Node", "control-plane-01", node.UID)}},
		Spec: corev1.PodSpec{NodeName: "control-plane-01", Containers: []corev1.Container{{Name: "etcd", Image: "etcd",
			Env: []corev1.EnvVar{{Name: "METRICS", Value: "metrics.kube-system.svc:2381"}}}}},
	}, metav1.CreateOptions{}))
	must(cs.NetworkingV1().NetworkPolicies("kube-system").Create(c, &networkingv1.NetworkPolicy{
		ObjectMeta: metav1.ObjectMeta{Namespace: "kube-system", Name: "etcd-egress"},
		Spec: networkingv1.NetworkPolicySpec{PodSelector: metav1.LabelSelector{MatchLabels: map[string]string{"component": "etcd"}},
			PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeEgress},
			Egress: []networkingv1.NetworkPolicyEgressRule{{To: []networkingv1.NetworkPolicyPeer{
				{PodSelector: &metav1.LabelSelector{MatchLabels: map[string]string{"component": "apiserver"}}}}}}},
	}, metav1.CreateOptions{}))
	must(cs.CoreV1().Pods("kube-system").Create(c, &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Namespace: "kube-system", Name: "kube-apiserver-control-plane-01", Labels: map[string]string{"component": "apiserver"},
			OwnerReferences: []metav1.OwnerReference{ctrlRef("v1", "Node", "control-plane-01", node.UID)}},
		Spec: corev1.PodSpec{NodeName: "control-plane-01", Containers: []corev1.Container{{Name: "apiserver", Image: "apiserver"}}},
	}, metav1.CreateOptions{}))

	httpc, err := rest.HTTPClientFor(cfg)
	if err != nil {
		t.Fatal(err)
	}
	reg := prometheus.NewRegistry()
	rep := newReplica(t)
	w := New(cs, nil, topology.NewStore("c1"), clock.New(httpc, cfg.Host, reg), rep.sink, reg, topology.NewReporter(reg, quietLog()))
	if err := w.Start(ctx); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"Pod:kube-system/etcd-control-plane-01|owned_by|Node:control-plane-01",
		"Pod:kube-system/etcd-control-plane-01|runs_on|Node:control-plane-01",
		"Node:control-plane-01|references|Service:kube-system/metrics",
	}
	testenv.Eventually(t, 10*time.Second, func() error {
		for _, id := range want {
			if !rep.hasEdge(id) {
				return fmt.Errorf("missing edge %s; have %v", id, rep.edgeIDs())
			}
		}
		return nil
	})
	// 两个静态 Pod 的顶层 owner 是同一个 Node：出站边的两端相同，不产生边
	for _, id := range rep.edgeIDs() {
		if strings.Contains(id, "Node:kube-system/") || strings.Contains(id, "egress_to") {
			t.Fatalf("edge with a namespaced Node or a self egress edge: %s", id)
		}
	}
	rep.mu.Lock()
	for k := range rep.nodes {
		if strings.HasPrefix(k, "Node:") && strings.Contains(k, "/") {
			rep.mu.Unlock()
			t.Fatalf("fictitious namespaced node %s", k)
		}
	}
	rep.mu.Unlock()

	if err := cs.CoreV1().Pods("kube-system").Delete(c, "etcd-control-plane-01", metav1.DeleteOptions{GracePeriodSeconds: ptr.To[int64](0)}); err != nil {
		t.Fatal(err)
	}
	testenv.Eventually(t, 10*time.Second, func() error {
		ts, ok := w.Tombstones().ByKey("Pod:kube-system/etcd-control-plane-01", time.Time{})
		if !ok {
			return fmt.Errorf("no tombstone yet")
		}
		if ts.RootOwner != "Node:control-plane-01" {
			return fmt.Errorf("tombstone root owner %q", ts.RootOwner)
		}
		return nil
	})
}

func TestWatcherSurvivesArgoResourcesWithColonNames(t *testing.T) {
	cfg, _ := testenv.StartKube(t, true)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cs := kubernetes.NewForConfigOrDie(cfg)
	dyn := dynamic.NewForConfigOrDie(cfg)
	disc := discovery.NewDiscoveryClientForConfigOrDie(cfg)
	c := context.Background()

	for _, n := range []string{"argocd", "cert-manager"} {
		must(cs.CoreV1().Namespaces().Create(c, ns(n, nil), metav1.CreateOptions{}))
	}
	const roleName = "cert-manager-controller-approve:cert-manager-io"
	must(cs.RbacV1().ClusterRoles().Create(c, &rbacv1.ClusterRole{ObjectMeta: metav1.ObjectMeta{Name: roleName}}, metav1.CreateOptions{}))
	must(cs.CoreV1().Services("cert-manager").Create(c, svc("cert-manager", "cert-manager"), metav1.CreateOptions{}))
	dep := must(cs.AppsV1().Deployments("cert-manager").Create(c, &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{Namespace: "cert-manager", Name: "cert-manager"},
		Spec: appsv1.DeploymentSpec{Selector: &metav1.LabelSelector{MatchLabels: map[string]string{"app": "cm"}},
			Template: corev1.PodTemplateSpec{ObjectMeta: metav1.ObjectMeta{Labels: map[string]string{"app": "cm"}},
				Spec: corev1.PodSpec{Containers: []corev1.Container{{Name: "c", Image: "x"}}}}},
	}, metav1.CreateOptions{}))
	must(cs.CoreV1().Pods("cert-manager").Create(c, &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Namespace: "cert-manager", Name: "cert-manager-0",
			OwnerReferences: []metav1.OwnerReference{ctrlRef("apps/v1", "Deployment", "cert-manager", dep.UID)}},
		Spec: corev1.PodSpec{Containers: []corev1.Container{{Name: "c", Image: "x"}}},
	}, metav1.CreateOptions{}))

	appGVR := schema.GroupVersionResource{Group: "argoproj.io", Version: "v1alpha1", Resource: "applications"}
	app := must(dyn.Resource(appGVR).Namespace("argocd").Create(c, &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "argoproj.io/v1alpha1", "kind": "Application",
		"metadata": map[string]any{"namespace": "argocd", "name": "cert-manager"},
		"spec": map[string]any{
			"project":     "default",
			"source":      map[string]any{"repoURL": "https://charts.example.test", "chart": "cert-manager", "targetRevision": "1.0.0"},
			"destination": map[string]any{"server": "https://kubernetes.default.svc", "namespace": "cert-manager"},
		},
	}}, metav1.CreateOptions{}))
	if err := unstructured.SetNestedSlice(app.Object, []any{
		map[string]any{"group": "rbac.authorization.k8s.io", "version": "v1", "kind": "ClusterRole", "name": roleName},
		map[string]any{"group": "apps", "version": "v1", "kind": "Deployment", "namespace": "cert-manager", "name": "cert-manager"},
		map[string]any{"version": "v1", "kind": "Service", "namespace": "cert-manager", "name": "cert-manager"},
		map[string]any{"version": "v1", "kind": "ConfigMap", "namespace": "Not_A_Label", "name": "x"},
		map[string]any{"version": "v1", "kind": "Bad Kind", "name": "y"},
	}, "status", "resources"); err != nil {
		t.Fatal(err)
	}
	// Argo CD 的 Application CRD 没有 status 子资源，status 随对象一起更新
	must(dyn.Resource(appGVR).Namespace("argocd").Update(c, app, metav1.UpdateOptions{}))

	httpc, err := rest.HTTPClientFor(cfg)
	if err != nil {
		t.Fatal(err)
	}
	reg := prometheus.NewRegistry()
	rp := topology.NewReporter(reg, quietLog())
	rep := newReplica(t)
	store := topology.NewStore("c1")
	w := New(cs, &CRDSource{Discovery: disc, Dynamic: dyn, Recognizers: topology.BuiltinRecognizers(), Every: time.Second}, store,
		clock.New(httpc, cfg.Host, reg), rep.sink, reg, rp)
	if err := w.Start(ctx); err != nil {
		t.Fatal(err)
	}

	const appKey = "Application.argoproj.io:argocd/cert-manager"
	roleKey := "ClusterRole:cert-manager-controller-approve%3Acert-manager-io"
	want := []string{
		roleKey + "|managed_by|" + appKey,
		"Deployment:cert-manager/cert-manager|managed_by|" + appKey,
		"Service:cert-manager/cert-manager|managed_by|" + appKey,
		"Pod:cert-manager/cert-manager-0|owned_by|Deployment:cert-manager/cert-manager",
	}
	testenv.Eventually(t, 20*time.Second, func() error {
		for _, id := range want {
			if !rep.hasEdge(id) {
				return fmt.Errorf("missing edge %s; have %v", id, rep.edgeIDs())
			}
		}
		if testutil.ToFloat64(rp.InvalidKeys().WithLabelValues("applications.argoproj.io", "ConfigMap")) == 0 ||
			testutil.ToFloat64(rp.InvalidKeys().WithLabelValues("applications.argoproj.io", "invalid")) == 0 {
			return fmt.Errorf("skipped entries not counted")
		}
		// 跳过的条目不影响新鲜度：全部 informer（含自定义资源）同步且没有 watch 错误
		if ok, msg := w.Fresh(); !ok {
			return fmt.Errorf("informers not fresh: %s", msg)
		}
		return nil
	})
	if n, ok := rep.node(roleKey); !ok || n.Name != roleName {
		t.Fatalf("ClusterRole node keeps its original name: %+v %v", n, ok)
	}
	for _, id := range rep.edgeIDs() {
		if strings.Contains(id, "Not_A_Label") || strings.Contains(id, "Bad Kind") {
			t.Fatalf("edge from a skipped entry: %s", id)
		}
	}

	// 之后的变化照常处理：Application 不再管理 Service，受管边被撤回
	app = must(dyn.Resource(appGVR).Namespace("argocd").Get(c, "cert-manager", metav1.GetOptions{}))
	if err := unstructured.SetNestedSlice(app.Object, []any{
		map[string]any{"group": "rbac.authorization.k8s.io", "version": "v1", "kind": "ClusterRole", "name": roleName},
		map[string]any{"group": "apps", "version": "v1", "kind": "Deployment", "namespace": "cert-manager", "name": "cert-manager"},
	}, "status", "resources"); err != nil {
		t.Fatal(err)
	}
	must(dyn.Resource(appGVR).Namespace("argocd").Update(c, app, metav1.UpdateOptions{}))
	testenv.Eventually(t, 10*time.Second, func() error {
		if rep.hasEdge("Service:cert-manager/cert-manager|managed_by|" + appKey) {
			return fmt.Errorf("managed_by edge to the Service still present")
		}
		if !rep.hasEdge(roleKey + "|managed_by|" + appKey) {
			return fmt.Errorf("ClusterRole edge lost")
		}
		return nil
	})
}

func installCRDs(t *testing.T, cfg *rest.Config) {
	t.Helper()
	if _, err := envtest.InstallCRDs(cfg, envtest.CRDInstallOptions{Paths: []string{testenv.CRDDir()}, ErrorIfPathMissing: true}); err != nil {
		t.Fatal(err)
	}
}

func TestWatcherBuildsTopologyFromLiveCluster(t *testing.T) {
	cfg, _ := testenv.StartKube(t, false)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cs := kubernetes.NewForConfigOrDie(cfg)
	dyn := dynamic.NewForConfigOrDie(cfg)
	disc := discovery.NewDiscoveryClientForConfigOrDie(cfg)
	c := context.Background()

	for _, n := range []*corev1.Namespace{ns("app", map[string]string{"team": "app"}), ns("db", map[string]string{"team": "db"}), ns("kube-system", nil), ns("argocd", nil), ns("flux-system", nil)} {
		if _, err := cs.CoreV1().Namespaces().Create(c, n, metav1.CreateOptions{}); err != nil && !strings.Contains(err.Error(), "already exists") {
			t.Fatal(err)
		}
	}
	must(cs.CoreV1().Nodes().Create(c, &corev1.Node{ObjectMeta: metav1.ObjectMeta{Name: "n1", Labels: map[string]string{"zone": "a"}}}, metav1.CreateOptions{}))
	for _, s := range []*corev1.Service{svc("db", "pg-rw"), svc("app", "cache"), svc("app", "search"), svc("app", "api")} {
		must(cs.CoreV1().Services(s.Namespace).Create(c, s, metav1.CreateOptions{}))
	}
	must(cs.CoreV1().ConfigMaps("app").Create(c, &corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Namespace: "app", Name: "app-config"},
		Data: map[string]string{"upstream": "http://search.app.svc.cluster.local:9200/_bulk", "mode": "fast"}}, metav1.CreateOptions{}))
	dep := must(cs.AppsV1().Deployments("app").Create(c, &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{Namespace: "app", Name: "api"},
		Spec: appsv1.DeploymentSpec{Selector: &metav1.LabelSelector{MatchLabels: map[string]string{"app": "api"}},
			Template: corev1.PodTemplateSpec{ObjectMeta: metav1.ObjectMeta{Labels: map[string]string{"app": "api"}},
				Spec: corev1.PodSpec{Containers: []corev1.Container{{Name: "c", Image: "x"}}}}},
	}, metav1.CreateOptions{}))
	rs := must(cs.AppsV1().ReplicaSets("app").Create(c, &appsv1.ReplicaSet{
		ObjectMeta: metav1.ObjectMeta{Namespace: "app", Name: "api-rs", OwnerReferences: []metav1.OwnerReference{ctrlRef("apps/v1", "Deployment", "api", dep.UID)}},
		Spec: appsv1.ReplicaSetSpec{Selector: &metav1.LabelSelector{MatchLabels: map[string]string{"app": "api"}},
			Template: corev1.PodTemplateSpec{ObjectMeta: metav1.ObjectMeta{Labels: map[string]string{"app": "api"}},
				Spec: corev1.PodSpec{Containers: []corev1.Container{{Name: "c", Image: "x"}}}}},
	}, metav1.CreateOptions{}))
	must(cs.CoreV1().PersistentVolumeClaims("app").Create(c, &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{Namespace: "app", Name: "api-data"},
		Spec: corev1.PersistentVolumeClaimSpec{VolumeName: "pv-1", AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteOnce},
			Resources: corev1.VolumeResourceRequirements{Requests: corev1.ResourceList{corev1.ResourceStorage: mustQty("1Gi")}}},
	}, metav1.CreateOptions{}))
	must(cs.CoreV1().PersistentVolumes().Create(c, &corev1.PersistentVolume{
		ObjectMeta: metav1.ObjectMeta{Name: "pv-1"},
		Spec: corev1.PersistentVolumeSpec{Capacity: corev1.ResourceList{corev1.ResourceStorage: mustQty("1Gi")}, AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteOnce},
			PersistentVolumeSource: corev1.PersistentVolumeSource{CSI: &corev1.CSIPersistentVolumeSource{Driver: "driver.example.io", VolumeHandle: "vol-1"}}},
	}, metav1.CreateOptions{}))
	must(cs.CoreV1().Pods("kube-system").Create(c, &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Namespace: "kube-system", Name: "csi-node-abc"},
		Spec: corev1.PodSpec{NodeName: "n1", Containers: []corev1.Container{
			{Name: "csi-node-driver-registrar", Image: "registry.k8s.io/sig-storage/csi-node-driver-registrar:v2.13.0",
				Args: []string{"--csi-address=/csi/csi.sock", "--kubelet-registration-path=/var/lib/kubelet/plugins/driver.example.io/csi.sock"}},
			{Name: "plugin", Image: "example/driver"}}},
	}, metav1.CreateOptions{}))
	pod := must(cs.CoreV1().Pods("app").Create(c, &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Namespace: "app", Name: "api-1", Labels: map[string]string{"app": "api"},
			OwnerReferences: []metav1.OwnerReference{ctrlRef("apps/v1", "ReplicaSet", "api-rs", rs.UID)}},
		Spec: corev1.PodSpec{NodeName: "n1",
			Containers: []corev1.Container{{Name: "c", Image: "x",
				Env: []corev1.EnvVar{
					{Name: "DB_HOST", Value: "pg-rw.db.svc:5432"},
					{Name: "LOG_LEVEL", Value: "info"},
					{Name: "CACHE", Value: "cache:6379"},
					{Name: "PG_PASSWORD", ValueFrom: &corev1.EnvVarSource{SecretKeyRef: &corev1.SecretKeySelector{LocalObjectReference: corev1.LocalObjectReference{Name: "pg-app"}, Key: "password"}}},
				},
				EnvFrom: []corev1.EnvFromSource{{ConfigMapRef: &corev1.ConfigMapEnvSource{LocalObjectReference: corev1.LocalObjectReference{Name: "app-config"}}}},
			}},
			Volumes: []corev1.Volume{{Name: "data", VolumeSource: corev1.VolumeSource{PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{ClaimName: "api-data"}}}},
		},
	}, metav1.CreateOptions{}))
	pod.Status.PodIP = "10.0.0.7"
	pod.Status.PodIPs = []corev1.PodIP{{IP: "10.0.0.7"}}
	must(cs.CoreV1().Pods("app").UpdateStatus(c, pod, metav1.UpdateOptions{}))
	must(cs.DiscoveryV1().EndpointSlices("app").Create(c, &discoveryv1.EndpointSlice{
		ObjectMeta:  metav1.ObjectMeta{Namespace: "app", Name: "api-xyz", Labels: map[string]string{discoveryv1.LabelServiceName: "api"}},
		AddressType: discoveryv1.AddressTypeIPv4,
		Endpoints:   []discoveryv1.Endpoint{{Addresses: []string{"10.0.0.7"}, TargetRef: &corev1.ObjectReference{Kind: "Pod", Namespace: "app", Name: "api-1", UID: pod.UID}}},
	}, metav1.CreateOptions{}))
	pathType := networkingv1.PathTypePrefix
	must(cs.NetworkingV1().Ingresses("app").Create(c, &networkingv1.Ingress{
		ObjectMeta: metav1.ObjectMeta{Namespace: "app", Name: "web"},
		Spec: networkingv1.IngressSpec{Rules: []networkingv1.IngressRule{{Host: "api.example.test", IngressRuleValue: networkingv1.IngressRuleValue{HTTP: &networkingv1.HTTPIngressRuleValue{
			Paths: []networkingv1.HTTPIngressPath{{Path: "/", PathType: &pathType, Backend: networkingv1.IngressBackend{Service: &networkingv1.IngressServiceBackend{Name: "api", Port: networkingv1.ServiceBackendPort{Number: 80}}}}}}}}}},
	}, metav1.CreateOptions{}))
	must(cs.NetworkingV1().NetworkPolicies("app").Create(c, &networkingv1.NetworkPolicy{
		ObjectMeta: metav1.ObjectMeta{Namespace: "app", Name: "api-egress"},
		Spec: networkingv1.NetworkPolicySpec{PodSelector: metav1.LabelSelector{MatchLabels: map[string]string{"app": "api"}},
			PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeEgress},
			Egress: []networkingv1.NetworkPolicyEgressRule{{To: []networkingv1.NetworkPolicyPeer{
				{NamespaceSelector: &metav1.LabelSelector{MatchLabels: map[string]string{"team": "db"}}, PodSelector: &metav1.LabelSelector{MatchLabels: map[string]string{"cnpg.io/cluster": "pg"}}},
				{IPBlock: &networkingv1.IPBlock{CIDR: "0.0.0.0/0"}},
			}}}},
	}, metav1.CreateOptions{}))

	// 时钟参考：envtest 的 apiserver 与本机同钟，偏差应在测量误差之内
	httpc, err := rest.HTTPClientFor(cfg)
	if err != nil {
		t.Fatal(err)
	}
	reg := prometheus.NewRegistry()
	clk := clock.New(httpc, cfg.Host, reg)
	reading, err := clk.Measure(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if d := reading.Offset; d < -reading.Uncertainty-50*time.Millisecond || d > reading.Uncertainty+50*time.Millisecond || reading.Uncertainty > 400*time.Millisecond {
		t.Fatalf("apiserver clock reading off for a same-host apiserver: %+v", reading)
	}

	rep := newReplica(t)
	store := topology.NewStore("c1")
	w := New(cs, &CRDSource{Discovery: disc, Dynamic: dyn, Recognizers: topology.BuiltinRecognizers(), Every: time.Second}, store, clk, rep.sink, reg,
		topology.NewReporter(reg, quietLog()))
	if err := w.Start(ctx); err != nil {
		t.Fatal(err)
	}
	if ok, msg := w.Fresh(); !ok {
		t.Fatalf("informers not fresh after start: %s", msg)
	}

	want := []string{
		"Pod:app/api-1|owned_by|ReplicaSet:app/api-rs",
		"ReplicaSet:app/api-rs|owned_by|Deployment:app/api",
		"Pod:app/api-1|runs_on|Node:n1",
		"Pod:app/api-1|mounts|PersistentVolumeClaim:app/api-data",
		"PersistentVolumeClaim:app/api-data|bound_to|PersistentVolume:pv-1",
		"PersistentVolume:pv-1|provisioned_by|CSIDriver:driver.example.io",
		"PersistentVolume:pv-1|csi_node_plugin|Pod:kube-system/csi-node-abc",
		"Deployment:app/api|references|Service:db/pg-rw",
		"Deployment:app/api|references|Service:app/cache",
		"Deployment:app/api|references|Service:app/search",
		"Deployment:app/api|references|Secret:app/pg-app",
		"Deployment:app/api|references|ConfigMap:app/app-config",
		"Service:app/api|selects|Pod:app/api-1",
		"Ingress:app/web|routes_to|Service:app/api",
	}
	testenv.Eventually(t, 10*time.Second, func() error {
		for _, id := range want {
			if !rep.hasEdge(id) {
				return fmt.Errorf("missing edge %s; have %v", id, rep.edgeIDs())
			}
		}
		return nil
	})
	for _, id := range rep.edgeIDs() {
		if strings.Contains(id, "Service:app/info") || strings.Contains(id, "mode") {
			t.Fatalf("plain config value turned into an edge: %s", id)
		}
	}
	e, _ := rep.edge("Deployment:app/api|references|Service:db/pg-rw")
	if e.Provenance != topology.ProvConfigRef || e.Confidence != 0.7 || e.Evidence != "env DB_HOST" {
		t.Fatalf("config ref edge: %+v", e)
	}
	e, _ = rep.edge("Deployment:app/api|references|Service:app/search")
	if e.Evidence != "envFrom ConfigMap app-config" && e.Evidence != "ConfigMap app-config key upstream" {
		t.Fatalf("configmap ref evidence: %+v", e)
	}
	if n, ok := rep.node("Node:n1"); !ok || n.UID == nil || n.Labels["zone"] != "a" {
		t.Fatalf("own Node node: %+v", n)
	}
	if n, _ := rep.node("CSIDriver:driver.example.io"); !n.Hub {
		t.Fatalf("CSI driver must be a hub: %+v", n)
	}
	// Pod 节点经事件流带上容器镜像（ADR 0104 §13 的第 2 档）；其他节点不带
	if n, _ := rep.node("Pod:app/api-1"); fmt.Sprint(n.Images) != "[x]" {
		t.Fatalf("pod images %v", n.Images)
	}
	if n, _ := rep.node("Node:n1"); n.Images != nil {
		t.Fatalf("node images %v", n.Images)
	}
	// 首次列举的对象以创建时间为 valid_from
	for _, ev := range rep.events {
		if ev.Op == topology.OpNodeUpsert && ev.Node.Key == "Pod:app/api-1" {
			if ev.ValidFrom.After(pod.CreationTimestamp.Add(time.Second)) {
				t.Fatalf("initial pod valid_from %s is later than its creation %s", ev.ValidFrom, pod.CreationTimestamp)
			}
			break
		}
	}

	// 自定义资源在 reader 启动之后才安装：下一次资源发现补上 informer
	installCRDs(t, cfg)
	gvr := func(g, v, r string) schema.GroupVersionResource {
		return schema.GroupVersionResource{Group: g, Version: v, Resource: r}
	}
	clusterGVR := gvr("postgresql.cnpg.io", "v1", "clusters")
	cl := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "postgresql.cnpg.io/v1", "kind": "Cluster",
		"metadata": map[string]any{"namespace": "db", "name": "pg"},
		"spec":     map[string]any{"instances": int64(2), "storage": map[string]any{"size": "1Gi"}},
	}}
	cl = must(dyn.Resource(clusterGVR).Namespace("db").Create(c, cl, metav1.CreateOptions{}))
	if err := unstructured.SetNestedField(cl.Object, map[string]any{"currentPrimary": "pg-1", "instanceNames": []any{"pg-1", "pg-2"}}, "status"); err != nil {
		t.Fatal(err)
	}
	must(dyn.Resource(clusterGVR).Namespace("db").UpdateStatus(c, cl, metav1.UpdateOptions{}))
	must(cs.CoreV1().Pods("db").Create(c, &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Namespace: "db", Name: "pg-1", Labels: map[string]string{"cnpg.io/cluster": "pg"},
			OwnerReferences: []metav1.OwnerReference{ctrlRef("postgresql.cnpg.io/v1", "Cluster", "pg", cl.GetUID())}},
		Spec: corev1.PodSpec{NodeName: "n1", Containers: []corev1.Container{{Name: "postgres", Image: "pg"}}},
	}, metav1.CreateOptions{}))

	route := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "gateway.networking.k8s.io/v1", "kind": "HTTPRoute",
		"metadata": map[string]any{"namespace": "app", "name": "r"},
		"spec": map[string]any{
			"parentRefs": []any{map[string]any{"name": "gw"}},
			"rules":      []any{map[string]any{"backendRefs": []any{map[string]any{"name": "api", "port": int64(80)}}}},
		},
	}}
	must(dyn.Resource(gvr("gateway.networking.k8s.io", "v1", "httproutes")).Namespace("app").Create(c, route, metav1.CreateOptions{}))

	appGVR := gvr("argoproj.io", "v1alpha1", "applications")
	app := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "argoproj.io/v1alpha1", "kind": "Application",
		"metadata": map[string]any{"namespace": "argocd", "name": "app"},
		"spec": map[string]any{
			"project":     "default",
			"source":      map[string]any{"repoURL": "https://git.example.test/app.git", "path": "deploy"},
			"destination": map[string]any{"server": "https://kubernetes.default.svc", "namespace": "app"},
		},
	}}
	app = must(dyn.Resource(appGVR).Namespace("argocd").Create(c, app, metav1.CreateOptions{}))
	if err := unstructured.SetNestedSlice(app.Object, []any{map[string]any{"group": "apps", "version": "v1", "kind": "Deployment", "namespace": "app", "name": "api"}}, "status", "resources"); err != nil {
		t.Fatal(err)
	}
	// Argo CD 的 Application CRD 没有 status 子资源，status 随对象一起更新
	must(dyn.Resource(appGVR).Namespace("argocd").Update(c, app, metav1.UpdateOptions{}))

	ksGVR := gvr("kustomize.toolkit.fluxcd.io", "v1", "kustomizations")
	ks := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "kustomize.toolkit.fluxcd.io/v1", "kind": "Kustomization",
		"metadata": map[string]any{"namespace": "flux-system", "name": "apps"},
		"spec": map[string]any{"interval": "10m", "prune": true, "path": "./apps",
			"sourceRef": map[string]any{"kind": "GitRepository", "name": "flux-system"}},
	}}
	ks = must(dyn.Resource(ksGVR).Namespace("flux-system").Create(c, ks, metav1.CreateOptions{}))
	if err := unstructured.SetNestedField(ks.Object, map[string]any{"inventory": map[string]any{"entries": []any{
		map[string]any{"id": "app_cache__Service", "v": "v1"},
		map[string]any{"id": "app_api_apps_Deployment", "v": "v1"},
	}}}, "status"); err != nil {
		t.Fatal(err)
	}
	must(dyn.Resource(ksGVR).Namespace("flux-system").UpdateStatus(c, ks, metav1.UpdateOptions{}))

	crdWant := []string{
		"Service:db/pg-rw|operator_convention|Cluster.postgresql.cnpg.io:db/pg",
		"Service:db/pg-ro|operator_convention|Cluster.postgresql.cnpg.io:db/pg",
		"Cluster.postgresql.cnpg.io:db/pg|primary|Pod:db/pg-1",
		"Cluster.postgresql.cnpg.io:db/pg|replica|Pod:db/pg-2",
		"Pod:db/pg-1|owned_by|Cluster.postgresql.cnpg.io:db/pg",
		"HTTPRoute.gateway.networking.k8s.io:app/r|routes_to|Service:app/api",
		"HTTPRoute.gateway.networking.k8s.io:app/r|attached_to|Gateway.gateway.networking.k8s.io:app/gw",
		"Deployment:app/api|managed_by|Application.argoproj.io:argocd/app",
		"Service:app/cache|managed_by|Kustomization.kustomize.toolkit.fluxcd.io:flux-system/apps",
		"Deployment:app/api|managed_by|Kustomization.kustomize.toolkit.fluxcd.io:flux-system/apps",
		// pg-1 的顶层 owner 是 CNPG Cluster；NetworkPolicy 出站边因此指向 Cluster
		"Deployment:app/api|egress_to|Cluster.postgresql.cnpg.io:db/pg",
	}
	testenv.Eventually(t, 20*time.Second, func() error {
		for _, id := range crdWant {
			if !rep.hasEdge(id) {
				return fmt.Errorf("missing edge %s; have %v", id, rep.edgeIDs())
			}
		}
		return nil
	})
	e, _ = rep.edge("Deployment:app/api|egress_to|Cluster.postgresql.cnpg.io:db/pg")
	if e.Provenance != topology.ProvNetworkPolicy || e.Confidence != 0.6 {
		t.Fatalf("network policy edge: %+v", e)
	}

	// ConfigMap 不再引用 search：派生的配置引用边被撤回
	cm, err := cs.CoreV1().ConfigMaps("app").Get(c, "app-config", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	cm.Data = map[string]string{"mode": "fast"}
	must(cs.CoreV1().ConfigMaps("app").Update(c, cm, metav1.UpdateOptions{}))
	testenv.Eventually(t, 10*time.Second, func() error {
		if rep.hasEdge("Deployment:app/api|references|Service:app/search") {
			return fmt.Errorf("config ref edge to search still present")
		}
		return nil
	})

	// 删除 Pod：节点与它贡献的边被删除，墓碑可按 IP 和键解析
	if err := cs.CoreV1().Pods("app").Delete(c, "api-1", metav1.DeleteOptions{GracePeriodSeconds: ptr.To[int64](0)}); err != nil {
		t.Fatal(err)
	}
	testenv.Eventually(t, 10*time.Second, func() error {
		if _, ok := rep.node("Pod:app/api-1"); ok && rep.hasEdge("Pod:app/api-1|runs_on|Node:n1") {
			return fmt.Errorf("pod still present")
		}
		return nil
	})
	ts, ok := w.Tombstones().ByPodIP("10.0.0.7", time.Time{})
	if !ok || ts.Node.Key != "Pod:app/api-1" || ts.NodeName != "n1" || ts.RootOwner != "Deployment:app/api" {
		t.Fatalf("tombstone by ip: %+v %v", ts, ok)
	}
	if _, ok := w.Tombstones().ByKey("Pod:app/api-1", ts.DeletedAt.Add(-time.Millisecond)); !ok {
		t.Fatalf("tombstone by key at a time the pod existed")
	}
	if _, ok := w.Tombstones().ByKey("Pod:app/api-1", ts.DeletedAt.Add(time.Minute)); ok {
		t.Fatalf("tombstone matched a time after deletion")
	}
	if w.Tombstones().Expire(ts.DeletedAt.Add(TombstoneTTL+time.Second)) != 0 {
		t.Fatalf("tombstones not expired after 24h")
	}

	// 事件流重放的结果必须与 Store 快照完全一致
	testenv.Eventually(t, 10*time.Second, func() error {
		snap := store.Snapshot(time.Now())
		rep.mu.Lock()
		defer rep.mu.Unlock()
		if len(snap.Nodes) != len(rep.nodes) || len(snap.Edges) != len(rep.edges) {
			return fmt.Errorf("snapshot %d nodes / %d edges, replica %d / %d", len(snap.Nodes), len(snap.Edges), len(rep.nodes), len(rep.edges))
		}
		for _, n := range snap.Nodes {
			if got, ok := rep.nodes[n.Node.Key]; !ok || fmt.Sprint(got) != fmt.Sprint(n.Node) {
				return fmt.Errorf("node %s differs: replica %+v, snapshot %+v", n.Node.Key, got, n.Node)
			}
		}
		for _, e := range snap.Edges {
			if got, ok := rep.edges[e.Edge.ID()]; !ok || got != e.Edge {
				return fmt.Errorf("edge %s differs", e.Edge.ID())
			}
		}
		if snap.Seq != rep.lastSeq {
			return fmt.Errorf("snapshot seq %d, replica %d", snap.Seq, rep.lastSeq)
		}
		return nil
	})
}

// Package kube 运行只读 informer，把集群对象转换成拓扑事件，并维护 24 小时墓碑。
// reader 的 ServiceAccount 只有 get/list/watch，且不含 Secret；Secret 名称只从 Pod spec 的引用中得到。
package kube

import (
	"context"
	"fmt"
	"runtime/debug"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	appsv1 "k8s.io/api/apps/v1"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	discoveryv1 "k8s.io/api/discovery/v1"
	networkingv1 "k8s.io/api/networking/v1"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/informers"
	"k8s.io/client-go/kubernetes"
	listersappsv1 "k8s.io/client-go/listers/apps/v1"
	listersbatchv1 "k8s.io/client-go/listers/batch/v1"
	listerscorev1 "k8s.io/client-go/listers/core/v1"
	"k8s.io/client-go/tools/cache"

	"github.com/Zzhihon/SreNautix/internal/spoke/reader/topology"
)

// Clock 给出事件时间（apiserver 参考时间）。
type Clock interface{ Now() time.Time }

// Sink 接收拓扑事件。调用方保证按调用顺序处理；Sink 不得阻塞。
type Sink func([]topology.Event)

const (
	podNodeIndex  = "spec.nodeName"
	recomputeTick = 2 * time.Second
	freshnessTick = 10 * time.Second
)

// Watcher 运行全部 informer 并维护拓扑。
type Watcher struct {
	cs    kubernetes.Interface
	store *topology.Store
	clock Clock
	sink  Sink
	tomb  *Tombstones
	m     *metrics
	rep   *topology.Reporter

	// applyMu 保证 store.Apply 与 sink 的调用顺序一致，事件序号因此按投递顺序单调递增
	applyMu sync.Mutex

	factory informers.SharedInformerFactory
	pods    listerscorev1.PodLister
	podIdx  cache.Indexer
	nss     listerscorev1.NamespaceLister
	svcs    listerscorev1.ServiceLister
	cms     listerscorev1.ConfigMapLister
	pvcs    listerscorev1.PersistentVolumeClaimLister
	pvs     listerscorev1.PersistentVolumeLister
	rss     listersappsv1.ReplicaSetLister
	jobs    listersbatchv1.JobLister
	nps     cache.Indexer

	fresh *freshness
	crds  *crdWatcher

	dirtyMu  sync.Mutex
	dirtyPod bool
	dirtyNP  bool
	synced   bool
}

// New 创建 Watcher。rep 记录提取时跳过的对象。
func New(cs kubernetes.Interface, crds *CRDSource, store *topology.Store, clock Clock, sink Sink, reg prometheus.Registerer, rep *topology.Reporter) *Watcher {
	w := &Watcher{cs: cs, store: store, clock: clock, sink: sink, tomb: NewTombstones(), m: newMetrics(reg), rep: rep}
	w.fresh = newFreshness(w.m)
	w.factory = informers.NewSharedInformerFactory(cs, 0)
	if crds != nil {
		w.crds = newCRDWatcher(crds, w)
	}
	return w
}

// Store 返回拓扑存储。
func (w *Watcher) Store() *topology.Store { return w.store }

// Tombstones 返回墓碑表。
func (w *Watcher) Tombstones() *Tombstones { return w.tomb }

type typed struct {
	name     string
	kind     string
	informer cache.SharedIndexInformer
	// extract 为 nil 的对象不贡献拓扑，只用作派生贡献的查询来源
	extract func(obj any) topology.Contribution
	// affects 列出这种对象变化后需要重算的派生贡献
	affectsPods, affectsNP bool
}

// Start 启动 informer 并等待首次同步。之后的变化通过 Sink 输出。
func (w *Watcher) Start(ctx context.Context) error {
	f := w.factory
	podInf := f.Core().V1().Pods().Informer()
	if err := podInf.AddIndexers(cache.Indexers{podNodeIndex: func(obj any) ([]string, error) {
		return []string{obj.(*corev1.Pod).Spec.NodeName}, nil
	}}); err != nil {
		return err
	}
	npInf := f.Networking().V1().NetworkPolicies().Informer()
	w.pods = f.Core().V1().Pods().Lister()
	w.podIdx = podInf.GetIndexer()
	w.nss = f.Core().V1().Namespaces().Lister()
	w.svcs = f.Core().V1().Services().Lister()
	w.cms = f.Core().V1().ConfigMaps().Lister()
	w.pvcs = f.Core().V1().PersistentVolumeClaims().Lister()
	w.pvs = f.Core().V1().PersistentVolumes().Lister()
	w.rss = f.Apps().V1().ReplicaSets().Lister()
	w.jobs = f.Batch().V1().Jobs().Lister()
	w.nps = npInf.GetIndexer()

	generic := func(kind string) func(any) topology.Contribution {
		return func(obj any) topology.Contribution { return topology.Generic(kind, obj.(metav1.Object)) }
	}
	list := []typed{
		{name: "pods", kind: "Pod", informer: podInf, affectsPods: true, affectsNP: true,
			extract: func(o any) topology.Contribution { return topology.Pod(w, o.(*corev1.Pod)) }},
		{name: "nodes", kind: "Node", informer: f.Core().V1().Nodes().Informer(), extract: generic("Node")},
		{name: "namespaces", kind: "Namespace", informer: f.Core().V1().Namespaces().Informer(), affectsNP: true},
		{name: "services", kind: "Service", informer: f.Core().V1().Services().Informer(), extract: generic("Service"), affectsPods: true},
		{name: "configmaps", kind: "ConfigMap", informer: f.Core().V1().ConfigMaps().Informer(), affectsPods: true},
		{name: "persistentvolumeclaims", kind: "PersistentVolumeClaim", informer: f.Core().V1().PersistentVolumeClaims().Informer(), affectsPods: true,
			extract: func(o any) topology.Contribution { return topology.PVC(o.(*corev1.PersistentVolumeClaim)) }},
		{name: "persistentvolumes", kind: "PersistentVolume", informer: f.Core().V1().PersistentVolumes().Informer(), affectsPods: true,
			extract: func(o any) topology.Contribution { return topology.PV(o.(*corev1.PersistentVolume)) }},
		{name: "replicasets", kind: "ReplicaSet", informer: f.Apps().V1().ReplicaSets().Informer(), extract: generic("ReplicaSet"), affectsPods: true, affectsNP: true},
		{name: "deployments", kind: "Deployment", informer: f.Apps().V1().Deployments().Informer(), extract: generic("Deployment")},
		{name: "statefulsets", kind: "StatefulSet", informer: f.Apps().V1().StatefulSets().Informer(), extract: generic("StatefulSet")},
		{name: "daemonsets", kind: "DaemonSet", informer: f.Apps().V1().DaemonSets().Informer(), extract: generic("DaemonSet")},
		{name: "jobs", kind: "Job", informer: f.Batch().V1().Jobs().Informer(), extract: generic("Job"), affectsPods: true, affectsNP: true},
		{name: "cronjobs", kind: "CronJob", informer: f.Batch().V1().CronJobs().Informer(), extract: generic("CronJob")},
		{name: "endpointslices", kind: "EndpointSlice", informer: f.Discovery().V1().EndpointSlices().Informer(),
			extract: func(o any) topology.Contribution { return topology.EndpointSlice(o.(*discoveryv1.EndpointSlice)) }},
		{name: "ingresses", kind: "Ingress", informer: f.Networking().V1().Ingresses().Informer(),
			extract: func(o any) topology.Contribution { return topology.Ingress(o.(*networkingv1.Ingress)) }},
		{name: "networkpolicies", kind: "NetworkPolicy", informer: npInf,
			extract: func(o any) topology.Contribution {
				return topology.NetworkPolicyEgress(w, o.(*networkingv1.NetworkPolicy))
			}},
	}
	for _, t := range list {
		if err := w.register(t); err != nil {
			return err
		}
	}
	f.Start(ctx.Done())
	for typ, ok := range f.WaitForCacheSync(ctx.Done()) {
		if !ok {
			return fmt.Errorf("kube: informer for %v did not sync", typ)
		}
	}
	for _, t := range list {
		w.fresh.markSynced(t.name)
	}
	// 首次同步完成后，派生贡献（配置引用、CSI node plugin、NetworkPolicy）依赖的对象都已在缓存中，按创建时间整体重算一次
	w.recompute(true, true, true)
	w.dirtyMu.Lock()
	w.synced = true
	w.dirtyMu.Unlock()

	go w.loop(ctx, list)
	if w.crds != nil {
		go w.crds.run(ctx)
	}
	return nil
}

func (w *Watcher) register(t typed) error {
	if err := t.informer.SetTransform(stripManagedFields); err != nil {
		return err
	}
	if err := t.informer.SetWatchErrorHandler(func(_ *cache.Reflector, err error) {
		w.fresh.watchError(t.name, err)
	}); err != nil {
		return err
	}
	w.fresh.track(t.name, t.informer)
	_, err := t.informer.AddEventHandler(cache.ResourceEventHandlerDetailedFuncs{
		AddFunc: func(obj any, initial bool) {
			at := w.clock.Now()
			if initial {
				at = obj.(metav1.Object).GetCreationTimestamp().UTC()
			}
			w.upsert(t, obj, at)
		},
		UpdateFunc: func(_, obj any) { w.upsert(t, obj, w.clock.Now()) },
		DeleteFunc: func(obj any) { w.remove(t, obj) },
	})
	return err
}

func stripManagedFields(obj any) (any, error) {
	if m, err := meta.Accessor(obj); err == nil {
		m.SetManagedFields(nil)
	}
	return obj, nil
}

func contributorID(kind string, obj metav1.Object) (string, error) {
	return topology.Key(kind, obj.GetNamespace(), obj.GetName())
}

func (w *Watcher) upsert(t typed, obj any, at time.Time) {
	w.fresh.event(t.name)
	if t.extract != nil {
		w.contribute(t.name, t.kind, obj.(metav1.Object), func() topology.Contribution { return t.extract(obj) }, at)
	}
	w.markDirty(t.affectsPods, t.affectsNP)
}

// contribute 提取一个对象的贡献并写入存储。对象自己的键无法生成时整个对象跳过；贡献中的问题（某个引用的键无法生成、
// 某个字段无法解析）只跳过对应的节点和边。两者都交给 Reporter 计数并限速记录警告，单个对象的问题不会让 reader 退出。
func (w *Watcher) contribute(source, kind string, obj metav1.Object, extract func() topology.Contribution, at time.Time) {
	id, err := contributorID(kind, obj)
	if err != nil {
		w.rep.Report(source, []topology.Problem{topology.KeyProblem(err)})
		return
	}
	c, ok := w.extract(source, kind, obj, extract)
	if !ok {
		return
	}
	w.rep.Report(source, c.Problems)
	w.apply(id, c, at)
}

// extract 调用提取函数。提取函数是只读的纯函数；它因为某个对象的异常内容出错（panic）时，这个对象保留上一次的贡献，
// 错误连同调用栈交给 Reporter，其余对象照常处理。
func (w *Watcher) extract(source, kind string, obj metav1.Object, extract func() topology.Contribution) (c topology.Contribution, ok bool) {
	defer func() {
		if r := recover(); r != nil {
			w.rep.Report(source, []topology.Problem{{Kind: kind, Namespace: obj.GetNamespace(), Name: obj.GetName(),
				Reason: fmt.Sprintf("extractor panic: %v\n%s", r, debug.Stack())}})
			c, ok = topology.Contribution{}, false
		}
	}()
	return extract(), true
}

func (w *Watcher) remove(t typed, obj any) {
	w.fresh.event(t.name)
	if d, ok := obj.(cache.DeletedFinalStateUnknown); ok {
		obj = d.Obj
	}
	mo := obj.(metav1.Object)
	now := w.clock.Now()
	// 键无法生成的对象从未进入存储，也不留墓碑
	if id, err := contributorID(t.kind, mo); err == nil {
		if t.extract != nil {
			w.applyMu.Lock()
			w.emit(w.store.Remove(id, now))
			w.applyMu.Unlock()
		}
		w.addTombstone(t.kind, obj, now)
	}
	w.markDirty(t.affectsPods, t.affectsNP)
}

func (w *Watcher) addTombstone(kind string, obj any, now time.Time) {
	mo := obj.(metav1.Object)
	n, err := topology.ObjectNode(kind, mo)
	if err != nil {
		return
	}
	ts := Tombstone{Node: n, CreatedAt: mo.GetCreationTimestamp().UTC(), DeletedAt: now}
	if p, ok := obj.(*corev1.Pod); ok {
		ts.PodIP = p.Status.PodIP
		ts.NodeName = p.Spec.NodeName
		ts.RootOwner = w.rootOwnerOf(p)
	}
	w.tomb.Add(ts)
}

// rootOwnerOf 从 Pod 自己的 ownerReferences 出发求顶层 owner；Pod 已从缓存删除时仍然可用。顶层 owner 无法生成合法的键时返回空串。
func (w *Watcher) rootOwnerOf(p *corev1.Pod) string {
	kind, name := "Pod", p.Name
	for _, ref := range p.OwnerReferences {
		if ref.Controller != nil && *ref.Controller {
			kind, name = topology.KindName(groupOf(ref.APIVersion), ref.Kind), ref.Name
			break
		}
	}
	k, err := topology.RootOwner(w, kind, p.Namespace, name)
	if err != nil {
		return ""
	}
	return k
}

func (w *Watcher) apply(contributor string, c topology.Contribution, at time.Time) {
	w.applyMu.Lock()
	defer w.applyMu.Unlock()
	w.emit(w.store.Apply(contributor, c, at))
}

func (w *Watcher) emit(evs []topology.Event) {
	if len(evs) == 0 {
		return
	}
	for _, e := range evs {
		w.m.events.WithLabelValues(string(e.Op)).Inc()
	}
	n, e := w.store.Counts()
	w.m.nodes.Set(float64(n))
	w.m.edges.Set(float64(e))
	w.sink(evs)
}

func (w *Watcher) markDirty(pods, np bool) {
	w.dirtyMu.Lock()
	defer w.dirtyMu.Unlock()
	w.dirtyPod = w.dirtyPod || pods
	w.dirtyNP = w.dirtyNP || np
}

// recompute 重算派生贡献。initial 为 true 时用对象的创建时间作为 valid_from。
func (w *Watcher) recompute(pods, nps, initial bool) {
	if pods {
		all, err := w.pods.List(labels.Everything())
		if err != nil {
			panic(err)
		}
		for _, p := range all {
			at := w.clock.Now()
			if initial {
				at = p.CreationTimestamp.UTC()
			}
			w.contribute("pods", "Pod", p, func() topology.Contribution { return topology.Pod(w, p) }, at)
		}
	}
	if nps {
		for _, o := range w.nps.List() {
			np := o.(*networkingv1.NetworkPolicy)
			at := w.clock.Now()
			if initial {
				at = np.CreationTimestamp.UTC()
			}
			w.contribute("networkpolicies", "NetworkPolicy", np, func() topology.Contribution { return topology.NetworkPolicyEgress(w, np) }, at)
		}
	}
}

func (w *Watcher) loop(ctx context.Context, list []typed) {
	recompute := time.NewTicker(recomputeTick)
	fresh := time.NewTicker(freshnessTick)
	expire := time.NewTicker(time.Minute)
	defer recompute.Stop()
	defer fresh.Stop()
	defer expire.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-recompute.C:
			w.dirtyMu.Lock()
			pods, nps := w.dirtyPod, w.dirtyNP
			w.dirtyPod, w.dirtyNP = false, false
			w.dirtyMu.Unlock()
			w.recompute(pods, nps, false)
		case <-fresh.C:
			w.fresh.poll()
		case <-expire.C:
			w.m.tombstones.Set(float64(w.tomb.Expire(w.clock.Now())))
		}
	}
}

// Fresh 返回 informer 新鲜度条件：全部 informer 已同步，并且没有未恢复的 watch 错误。
func (w *Watcher) Fresh() (bool, string) { return w.fresh.status() }

// ── topology.Lookup ──────────────────────────────────────────

func groupOf(apiVersion string) string {
	for i := range len(apiVersion) {
		if apiVersion[i] == '/' {
			return apiVersion[:i]
		}
	}
	return ""
}

func controllerRef(refs []metav1.OwnerReference) (topology.OwnerRef, bool) {
	for _, r := range refs {
		if r.Controller != nil && *r.Controller {
			return topology.OwnerRef{Kind: topology.KindName(groupOf(r.APIVersion), r.Kind), Name: r.Name, UID: string(r.UID)}, true
		}
	}
	return topology.OwnerRef{}, false
}

// ControllerOf 实现 topology.Lookup。
func (w *Watcher) ControllerOf(kind, namespace, name string) (topology.OwnerRef, bool) {
	var refs []metav1.OwnerReference
	switch kind {
	case "Pod":
		p, err := w.pods.Pods(namespace).Get(name)
		if err != nil {
			return topology.OwnerRef{}, false
		}
		refs = p.OwnerReferences
	case "ReplicaSet":
		rs, err := w.rss.ReplicaSets(namespace).Get(name)
		if err != nil {
			return topology.OwnerRef{}, false
		}
		refs = rs.OwnerReferences
	case "Job":
		j, err := w.jobs.Jobs(namespace).Get(name)
		if err != nil {
			return topology.OwnerRef{}, false
		}
		refs = j.OwnerReferences
	default:
		return topology.OwnerRef{}, false
	}
	return controllerRef(refs)
}

// ServiceExists 实现 topology.Lookup。
func (w *Watcher) ServiceExists(namespace, name string) bool {
	_, err := w.svcs.Services(namespace).Get(name)
	return err == nil
}

// ConfigMap 实现 topology.Lookup。
func (w *Watcher) ConfigMap(namespace, name string) (*corev1.ConfigMap, bool) {
	cm, err := w.cms.ConfigMaps(namespace).Get(name)
	return cm, err == nil
}

// PVC 实现 topology.Lookup。
func (w *Watcher) PVC(namespace, name string) (*corev1.PersistentVolumeClaim, bool) {
	p, err := w.pvcs.PersistentVolumeClaims(namespace).Get(name)
	return p, err == nil
}

// PV 实现 topology.Lookup。
func (w *Watcher) PV(name string) (*corev1.PersistentVolume, bool) {
	p, err := w.pvs.Get(name)
	return p, err == nil
}

// CSINodePlugin 实现 topology.Lookup。
func (w *Watcher) CSINodePlugin(driver, node string) (*corev1.Pod, bool) {
	objs, err := w.podIdx.ByIndex(podNodeIndex, node)
	if err != nil {
		panic(err)
	}
	for _, o := range objs {
		p := o.(*corev1.Pod)
		if topology.IsCSINodePlugin(p, driver) {
			return p, true
		}
	}
	return nil, false
}

// Namespaces 实现 topology.Lookup。
func (w *Watcher) Namespaces(selector labels.Selector) []string {
	list, err := w.nss.List(selector)
	if err != nil {
		panic(err)
	}
	out := make([]string, 0, len(list))
	for _, n := range list {
		out = append(out, n.Name)
	}
	return out
}

// Pods 实现 topology.Lookup。
func (w *Watcher) Pods(namespace string, selector labels.Selector) []*corev1.Pod {
	list, err := w.pods.Pods(namespace).List(selector)
	if err != nil {
		panic(err)
	}
	return list
}

// PodByIP 返回当前使用该 IP 的 Pod（hostNetwork Pod 除外）。
func (w *Watcher) PodByIP(ip string) (*corev1.Pod, bool) {
	all, err := w.pods.List(labels.Everything())
	if err != nil {
		panic(err)
	}
	for _, p := range all {
		if p.Status.PodIP == ip && !p.Spec.HostNetwork {
			return p, true
		}
	}
	return nil, false
}

// Object 返回缓存中的对象（Pod、Node、Service、PVC、PV、ReplicaSet、Job 及其上层工作负载）。
func (w *Watcher) Object(kind, namespace, name string) (metav1.Object, bool) {
	var obj runtime.Object
	var err error
	f := w.factory
	switch kind {
	case "Pod":
		obj, err = w.pods.Pods(namespace).Get(name)
	case "Node":
		obj, err = f.Core().V1().Nodes().Lister().Get(name)
	case "Service":
		obj, err = w.svcs.Services(namespace).Get(name)
	case "PersistentVolumeClaim":
		obj, err = w.pvcs.PersistentVolumeClaims(namespace).Get(name)
	case "PersistentVolume":
		obj, err = w.pvs.Get(name)
	case "ReplicaSet":
		obj, err = w.rss.ReplicaSets(namespace).Get(name)
	case "Deployment":
		var d *appsv1.Deployment
		d, err = f.Apps().V1().Deployments().Lister().Deployments(namespace).Get(name)
		obj = d
	case "StatefulSet":
		obj, err = f.Apps().V1().StatefulSets().Lister().StatefulSets(namespace).Get(name)
	case "DaemonSet":
		obj, err = f.Apps().V1().DaemonSets().Lister().DaemonSets(namespace).Get(name)
	case "Job":
		obj, err = w.jobs.Jobs(namespace).Get(name)
	case "CronJob":
		var cj *batchv1.CronJob
		cj, err = f.Batch().V1().CronJobs().Lister().CronJobs(namespace).Get(name)
		obj = cj
	default:
		return nil, false
	}
	if err != nil {
		return nil, false
	}
	return obj.(metav1.Object), true
}

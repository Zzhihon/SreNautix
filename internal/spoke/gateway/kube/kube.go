// Package kube 是 gateway 的 Kubernetes 客户端：固定的客户端限速（适配 APF），记录 apiserver 的 429，
// 读取 Pod 属主、就绪副本与 PDB 余量，经 Eviction API 驱逐，测量与 apiserver 的时钟偏差。
package kube

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	policyv1 "k8s.io/api/policy/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

// 客户端限速：gateway 的写入稀少，限速低于 client-go 的默认值之上一点，APF 中由小份保底承载（DESIGN §7.5）。
const (
	ClientQPS   = 10
	ClientBurst = 20
)

// Throttle 记录 apiserver 最近一次返回 429 的时间（Eviction 被 PDB 拒绝的 429 不计）。
type Throttle struct {
	mu   sync.Mutex
	last time.Time
}

// Since 返回最近一次 429 的时间；没有时为零值。
func (t *Throttle) Since() time.Time {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.last
}

type throttleRT struct {
	next http.RoundTripper
	t    *Throttle
}

func (r *throttleRT) RoundTrip(req *http.Request) (*http.Response, error) {
	resp, err := r.next.RoundTrip(req)
	if err == nil && resp.StatusCode == http.StatusTooManyRequests && !strings.HasSuffix(req.URL.Path, "/eviction") {
		r.t.mu.Lock()
		r.t.last = time.Now()
		r.t.mu.Unlock()
	}
	return resp, err
}

// Client 是 gateway 的客户端。
type Client struct {
	Cfg      *rest.Config
	Core     kubernetes.Interface
	Dyn      dynamic.Interface
	Throttle *Throttle
}

// New 复制 cfg 并设置限速、单次调用上限与 429 记录。
func New(cfg *rest.Config, timeout time.Duration) (*Client, error) {
	c := rest.CopyConfig(cfg)
	c.QPS, c.Burst, c.Timeout = ClientQPS, ClientBurst, timeout
	th := &Throttle{}
	c.Wrap(func(rt http.RoundTripper) http.RoundTripper { return &throttleRT{next: rt, t: th} })
	core, err := kubernetes.NewForConfig(c)
	if err != nil {
		return nil, err
	}
	dyn, err := dynamic.NewForConfig(c)
	if err != nil {
		return nil, err
	}
	return &Client{Cfg: c, Core: core, Dyn: dyn, Throttle: th}, nil
}

// IsNotFound 透出 apierrors.IsNotFound。
func IsNotFound(err error) bool { return apierrors.IsNotFound(err) }

// ClockSkew 测量本地时间与 apiserver 的 Date 响应头之差（本地减 apiserver，按往返中点计）。Date 精度为 1 秒。
func (c *Client) ClockSkew(ctx context.Context) (time.Duration, error) {
	hc, err := rest.HTTPClientFor(c.Cfg)
	if err != nil {
		return 0, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(c.Cfg.Host, "/")+"/version", nil)
	if err != nil {
		return 0, err
	}
	start := time.Now()
	resp, err := hc.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	end := time.Now()
	date, err := http.ParseTime(resp.Header.Get("Date"))
	if err != nil {
		return 0, fmt.Errorf("apiserver Date header: %w", err)
	}
	mid := start.Add(end.Sub(start) / 2)
	// Date 截断到秒：取该秒的中点作为 apiserver 时间
	return mid.Sub(date.Add(500 * time.Millisecond)), nil
}

// ── Pod 与属主 ────────────────────────────────────────────────────

// PodReady 返回 Ready 条件与其最近一次变化时间。
func PodReady(p *corev1.Pod) (bool, time.Time) {
	for _, c := range p.Status.Conditions {
		if c.Type == corev1.PodReady {
			return c.Status == corev1.ConditionTrue, c.LastTransitionTime.Time
		}
	}
	return false, p.CreationTimestamp.Time
}

// Workload 是 Pod 的属主工作负载。
type Workload struct {
	Kind              string
	Namespace         string
	Name              string
	UID               types.UID
	Desired           int32
	Ready             int32
	RolloutInProgress bool
	Selector          labels.Selector
}

// Key 返回 <ns>/<Kind>/<name>。
func (w Workload) Key() string { return w.Namespace + "/" + w.Kind + "/" + w.Name }

func controllerOf(refs []metav1.OwnerReference) *metav1.OwnerReference {
	for i := range refs {
		if refs[i].Controller != nil && *refs[i].Controller {
			return &refs[i]
		}
	}
	return nil
}

// ErrNotWorkload 表示 Pod 没有属主控制器，或属主不是 Deployment、StatefulSet、DaemonSet、ReplicaSet。
var ErrNotWorkload = errors.New("pod is not managed by a workload controller")

// OwnerWorkload 沿 controller ownerReference 找到 Deployment、StatefulSet、DaemonSet 或 ReplicaSet。
func (c *Client) OwnerWorkload(ctx context.Context, p *corev1.Pod) (Workload, error) {
	ref := controllerOf(p.OwnerReferences)
	if ref == nil {
		return Workload{}, fmt.Errorf("%w: pod %s/%s has no controller", ErrNotWorkload, p.Namespace, p.Name)
	}
	switch ref.Kind {
	case "ReplicaSet":
		rs, err := c.Core.AppsV1().ReplicaSets(p.Namespace).Get(ctx, ref.Name, metav1.GetOptions{})
		if err != nil {
			return Workload{}, fmt.Errorf("replicaset %s: %w", ref.Name, err)
		}
		if dref := controllerOf(rs.OwnerReferences); dref != nil {
			if dref.Kind != "Deployment" {
				return Workload{}, fmt.Errorf("%w: replicaset %s is owned by %s", ErrNotWorkload, rs.Name, dref.Kind)
			}
			return c.GetWorkload(ctx, p.Namespace, "Deployment", dref.Name)
		}
		return c.GetWorkload(ctx, p.Namespace, "ReplicaSet", rs.Name)
	case "StatefulSet", "DaemonSet":
		return c.GetWorkload(ctx, p.Namespace, ref.Kind, ref.Name)
	}
	return Workload{}, fmt.Errorf("%w: pod %s/%s is owned by %s %s", ErrNotWorkload, p.Namespace, p.Name, ref.Kind, ref.Name)
}

func replicas(r *int32) int32 {
	if r == nil {
		return 1
	}
	return *r
}

// GetWorkload 读取工作负载并判断是否有进行中的 rollout。
func (c *Client) GetWorkload(ctx context.Context, ns, kind, name string) (Workload, error) {
	w := Workload{Kind: kind, Namespace: ns, Name: name}
	var sel *metav1.LabelSelector
	switch kind {
	case "Deployment":
		d, err := c.Core.AppsV1().Deployments(ns).Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			return w, err
		}
		w.UID, w.Ready, sel, w.Desired = d.UID, d.Status.ReadyReplicas, d.Spec.Selector, replicas(d.Spec.Replicas)
		w.RolloutInProgress = d.Status.ObservedGeneration < d.Generation || d.Status.UpdatedReplicas < w.Desired ||
			d.Status.Replicas > d.Status.UpdatedReplicas
	case "StatefulSet":
		s, err := c.Core.AppsV1().StatefulSets(ns).Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			return w, err
		}
		w.UID, w.Ready, sel, w.Desired = s.UID, s.Status.ReadyReplicas, s.Spec.Selector, replicas(s.Spec.Replicas)
		w.RolloutInProgress = s.Status.ObservedGeneration < s.Generation ||
			(s.Spec.UpdateStrategy.Type != appsv1.OnDeleteStatefulSetStrategyType &&
				(s.Status.CurrentRevision != s.Status.UpdateRevision || s.Status.UpdatedReplicas < w.Desired))
	case "DaemonSet":
		d, err := c.Core.AppsV1().DaemonSets(ns).Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			return w, err
		}
		w.UID, w.Ready, sel, w.Desired = d.UID, d.Status.NumberReady, d.Spec.Selector, d.Status.DesiredNumberScheduled
		w.RolloutInProgress = d.Status.ObservedGeneration < d.Generation || d.Status.UpdatedNumberScheduled < w.Desired
	case "ReplicaSet":
		r, err := c.Core.AppsV1().ReplicaSets(ns).Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			return w, err
		}
		w.UID, w.Ready, sel, w.Desired = r.UID, r.Status.ReadyReplicas, r.Spec.Selector, replicas(r.Spec.Replicas)
		w.RolloutInProgress = r.Status.ObservedGeneration < r.Generation
	default:
		return w, fmt.Errorf("workload kind %q is not supported", kind)
	}
	s, err := metav1.LabelSelectorAsSelector(sel)
	if err != nil {
		return w, fmt.Errorf("%s %s selector: %w", kind, name, err)
	}
	w.Selector = s
	return w, nil
}

// PodsOf 返回控制器链指向该工作负载的 Pod。
func (c *Client) PodsOf(ctx context.Context, w Workload) ([]corev1.Pod, error) {
	list, err := c.Core.CoreV1().Pods(w.Namespace).List(ctx, metav1.ListOptions{LabelSelector: w.Selector.String()})
	if err != nil {
		return nil, fmt.Errorf("list pods of %s: %w", w.Key(), err)
	}
	var out []corev1.Pod
	for i := range list.Items {
		p := &list.Items[i]
		owner, err := c.OwnerWorkload(ctx, p)
		if errors.Is(err, ErrNotWorkload) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if owner.Kind == w.Kind && owner.Name == w.Name {
			out = append(out, *p)
		}
	}
	return out, nil
}

// ReadyPods 返回列表中就绪且未在删除的 Pod 数。
func ReadyPods(pods []corev1.Pod, exclude types.UID) int32 {
	var n int32
	for i := range pods {
		if pods[i].UID == exclude || pods[i].DeletionTimestamp != nil {
			continue
		}
		if ok, _ := PodReady(&pods[i]); ok {
			n++
		}
	}
	return n
}

// PDBHeadroom 判断驱逐 pod 是否在每个匹配的 PDB 的余量之内：目标未就绪时不占用余量（与 apiserver 的判定一致）。
func (c *Client) PDBHeadroom(ctx context.Context, pod *corev1.Pod) (bool, string, error) {
	list, err := c.Core.PolicyV1().PodDisruptionBudgets(pod.Namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return false, "", fmt.Errorf("list pdbs: %w", err)
	}
	ready, _ := PodReady(pod)
	var details []string
	ok := true
	for i := range list.Items {
		pdb := &list.Items[i]
		sel, err := metav1.LabelSelectorAsSelector(pdb.Spec.Selector)
		if err != nil || !sel.Matches(labels.Set(pod.Labels)) {
			continue
		}
		fits := pdb.Status.DisruptionsAllowed >= 1 || (!ready && pdb.Status.CurrentHealthy >= pdb.Status.DesiredHealthy)
		if pdb.Status.ObservedGeneration < pdb.Generation {
			fits = false
		}
		details = append(details, fmt.Sprintf("%s disruptionsAllowed=%d", pdb.Name, pdb.Status.DisruptionsAllowed))
		ok = ok && fits
	}
	if len(details) == 0 {
		return true, "no PodDisruptionBudget selects the pod", nil
	}
	return ok, strings.Join(details, ", "), nil
}

// ErrEvictionBlocked 表示 PDB 不允许驱逐（API 返回 429）。
var ErrEvictionBlocked = errors.New("eviction blocked by a PodDisruptionBudget")

// Evict 经 Eviction API 驱逐 Pod，带 UID 前置条件；PDB 不允许时返回 ErrEvictionBlocked，从不改用删除。
func (c *Client) Evict(ctx context.Context, ns, name string, uid types.UID, dryRun bool) error {
	opts := &metav1.DeleteOptions{Preconditions: &metav1.Preconditions{UID: &uid}}
	if dryRun {
		opts.DryRun = []string{metav1.DryRunAll}
	}
	err := c.Core.CoreV1().Pods(ns).EvictV1(ctx, &policyv1.Eviction{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns}, DeleteOptions: opts})
	if apierrors.IsTooManyRequests(err) {
		return fmt.Errorf("%w: %v", ErrEvictionBlocked, err)
	}
	if err != nil {
		return fmt.Errorf("evict pod %s/%s: %w", ns, name, err)
	}
	return nil
}

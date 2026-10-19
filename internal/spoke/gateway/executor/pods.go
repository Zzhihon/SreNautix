package executor

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"

	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/assertion"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/audit"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/execution"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/kube"
)

// minReadyOthers 是 pod_restart 可重建条件中，控制器除目标外必须保留的就绪副本数（DESIGN §9.1）。
const minReadyOthers = 2

func getPod(ctx context.Context, d *Deps, ns, name string) (*corev1.Pod, error) {
	p, err := d.Kube.Core.CoreV1().Pods(ns).Get(ctx, name, metav1.GetOptions{})
	if isNotFound(err) {
		return nil, fmt.Errorf("%w: pod %s/%s", ErrTargetNotFound, ns, name)
	}
	if err != nil {
		return nil, fmt.Errorf("pod %s/%s: %w", ns, name, err)
	}
	return p, nil
}

func podTarget(p *corev1.Pod) execution.TargetRef {
	return execution.TargetRef{Version: "v1", Kind: "Pod", Resource: "pods", Namespace: p.Namespace, Name: p.Name, UID: string(p.UID)}
}

// evict 驱逐一个 Pod 并记录写入。
func evict(ctx context.Context, d *Deps, x *Exec, p *corev1.Pod, uid types.UID) error {
	err := d.Kube.Evict(ctx, p.Namespace, p.Name, uid, false)
	if werr := x.Wrote(ctx, audit.Target{Resource: "pods", Subresource: "eviction", Namespace: p.Namespace, Name: p.Name, UID: string(uid)}, "create", err); werr != nil {
		return werr
	}
	return err
}

// podGoneOrReplaced 表示原 UID 的 Pod 已不存在或正在删除。
func podGoneOrReplaced(ctx context.Context, d *Deps, ns, name, uid string) (bool, error) {
	p, err := d.Kube.Core.CoreV1().Pods(ns).Get(ctx, name, metav1.GetOptions{})
	if isNotFound(err) {
		return true, nil
	}
	if err != nil {
		return false, err
	}
	return string(p.UID) != uid || p.DeletionTimestamp != nil, nil
}

// ── pod_restart ──────────────────────────────────────────────────

type podRestart struct{ d *Deps }

type podParams struct {
	Namespace string `json:"namespace"`
	Pod       string `json:"pod"`
}

type podSnapshot struct {
	PodUID        string   `json:"podUid"`
	Ready         bool     `json:"ready"`
	OwnerKind     string   `json:"ownerKind"`
	OwnerName     string   `json:"ownerName"`
	OwnerPodUIDs  []string `json:"ownerPodUids"`
	ReadyBefore   int32    `json:"readyBefore"`
	DesiredBefore int32    `json:"desiredBefore"`
}

// Resolve 核对可重建条件：由控制器管理、除目标外至少 2 个就绪副本、每个匹配的 PDB 都有余量。
// 三个条件都满足时等级为 reversible_recreatable，否则为 irreversible（执行时重新核对）。
func (e *podRestart) Resolve(ctx context.Context, params json.RawMessage) (*Resolved, error) {
	var p podParams
	if err := decode(params, &p); err != nil {
		return nil, err
	}
	pod, err := getPod(ctx, e.d, p.Namespace, p.Pod)
	if err != nil {
		return nil, err
	}
	ready, _ := kube.PodReady(pod)
	snap := podSnapshot{PodUID: string(pod.UID), Ready: ready}
	w, werr := e.d.Kube.OwnerWorkload(ctx, pod)
	if werr != nil && !errors.Is(werr, kube.ErrNotWorkload) {
		return nil, werr
	}
	managed := werr == nil
	var others int32
	domain := "workload:" + p.Namespace + "/Pod/" + p.Pod
	if managed {
		pods, err := e.d.Kube.PodsOf(ctx, w)
		if err != nil {
			return nil, err
		}
		others = kube.ReadyPods(pods, pod.UID)
		snap.OwnerKind, snap.OwnerName, snap.ReadyBefore, snap.DesiredBefore = w.Kind, w.Name, kube.ReadyPods(pods, ""), w.Desired
		for _, op := range pods {
			snap.OwnerPodUIDs = append(snap.OwnerPodUIDs, string(op.UID))
		}
		domain = "workload:" + w.Key()
	}
	headroom, pdbDetail, err := e.d.Kube.PDBHeadroom(ctx, pod)
	if err != nil {
		return nil, err
	}
	recreatable := managed && others >= minReadyOthers && headroom
	level := assertion.LevelIrreversible
	if recreatable {
		level = assertion.LevelReversibleRecreatable
	}
	s, err := toMap(snap)
	if err != nil {
		return nil, err
	}
	nodes := []string{}
	if pod.Spec.NodeName != "" {
		nodes = append(nodes, pod.Spec.NodeName)
	}
	return &Resolved{
		Target: podTarget(pod), ResourceVersion: pod.ResourceVersion, Domain: domain, Level: level, BlastRadius: 1, Nodes: nodes,
		Prechecks: []execution.CheckResult{
			check("controller_managed", "k8s", true, "由控制器管理=%v %s", managed, errString(werr)),
			check("ready_replicas", "k8s", true, "除目标外就绪副本 %d（可重建要求至少 %d）", others, minReadyOthers),
			check("pdb_headroom", "pdb", headroom, "%s", pdbDetail),
		},
		Snapshot: s,
	}, nil
}

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func (e *podRestart) Execute(ctx context.Context, x *Exec) error {
	var p podParams
	if err := decode(x.Params, &p); err != nil {
		return err
	}
	pod, err := getPod(ctx, e.d, p.Namespace, p.Pod)
	if err != nil {
		return err
	}
	return evict(ctx, e.d, x, pod, types.UID(x.AE.Spec.Target.UID))
}

func (e *podRestart) Observe(ctx context.Context, x *Exec) (Observation, string, error) {
	var p podParams
	if err := decode(x.Params, &p); err != nil {
		return NotApplied, "", err
	}
	gone, err := podGoneOrReplaced(ctx, e.d, p.Namespace, p.Pod, x.AE.Spec.Target.UID)
	if err != nil {
		return NotApplied, "", err
	}
	if gone {
		return Applied, "原 Pod 已被驱逐", nil
	}
	return NotApplied, "原 Pod 仍在运行", nil
}

func (e *podRestart) Verify(ctx context.Context, x *Exec) ([]execution.CheckResult, error) {
	var p podParams
	if err := decode(x.Params, &p); err != nil {
		return nil, err
	}
	var s podSnapshot
	if err := fromMap(x.Snapshot, &s); err != nil {
		return nil, err
	}
	gone, err := podGoneOrReplaced(ctx, e.d, p.Namespace, p.Pod, s.PodUID)
	if err != nil {
		return nil, err
	}
	checks := []execution.CheckResult{check("evicted", "k8s", gone, "原 Pod %s 已移除=%v", s.PodUID, gone)}
	if s.OwnerKind == "" {
		return checks, nil
	}
	w, err := e.d.Kube.GetWorkload(ctx, p.Namespace, s.OwnerKind, s.OwnerName)
	if err != nil {
		return nil, err
	}
	pods, err := e.d.Kube.PodsOf(ctx, w)
	if err != nil {
		return nil, err
	}
	before := map[string]bool{}
	for _, u := range s.OwnerPodUIDs {
		before[u] = true
	}
	newReady := false
	for i := range pods {
		if ok, _ := kube.PodReady(&pods[i]); ok && !before[string(pods[i].UID)] {
			newReady = true
		}
	}
	want := s.ReadyBefore
	if !s.Ready {
		want++
	}
	if want > w.Desired {
		want = w.Desired
	}
	ready := kube.ReadyPods(pods, "")
	return append(checks,
		check("replacement_ready", "k8s", newReady, "控制器有新的就绪 Pod=%v", newReady),
		check("ready_restored", "k8s", ready >= want, "就绪副本 %d，驱逐前 %d，要求 %d", ready, s.ReadyBefore, want),
	), nil
}

func (e *podRestart) Undo(context.Context, *Exec) (string, error) { return "", ErrNoUndo }

func (e *podRestart) Compensation(*Exec) *execution.Compensation { return nil }

// ── workload_rolling_restart ─────────────────────────────────────

type rollingRestart struct{ d *Deps }

type rollingSnapshot struct {
	PodUIDs []string `json:"podUids"`
	Names   []string `json:"names"`
	Desired int32    `json:"desired"`
}

// podReadyTimeout 是逐个驱逐时每个 Pod 被替换并就绪的上限。
const podReadyTimeout = 10 * time.Minute

func (e *rollingRestart) workload(ctx context.Context, params json.RawMessage) (kube.Workload, error) {
	var p nsKindName
	if err := decode(params, &p); err != nil {
		return kube.Workload{}, err
	}
	w, err := e.d.Kube.GetWorkload(ctx, p.Namespace, p.Kind, p.Name)
	if isNotFound(err) {
		return w, fmt.Errorf("%w: %s %s/%s", ErrTargetNotFound, p.Kind, p.Namespace, p.Name)
	}
	return w, err
}

func (e *rollingRestart) Resolve(ctx context.Context, params json.RawMessage) (*Resolved, error) {
	w, err := e.workload(ctx, params)
	if err != nil {
		return nil, err
	}
	pods, err := e.d.Kube.PodsOf(ctx, w)
	if err != nil {
		return nil, err
	}
	snap := rollingSnapshot{Desired: w.Desired}
	var nodes []string
	headroom := true
	var detail string
	for i := range pods {
		snap.PodUIDs = append(snap.PodUIDs, string(pods[i].UID))
		snap.Names = append(snap.Names, pods[i].Name)
		if pods[i].Spec.NodeName != "" {
			nodes = append(nodes, pods[i].Spec.NodeName)
		}
		ok, d, err := e.d.Kube.PDBHeadroom(ctx, &pods[i])
		if err != nil {
			return nil, err
		}
		headroom, detail = headroom && ok, d
	}
	s, err := toMap(snap)
	if err != nil {
		return nil, err
	}
	gvr := deploymentsGVR
	if w.Kind == "StatefulSet" {
		gvr = statefulSetsGVR
	}
	rv, err := resourceVersion(ctx, e.d, gvr, w.Namespace, w.Name)
	if err != nil {
		return nil, err
	}
	return &Resolved{
		Target:          execution.TargetRef{Group: "apps", Version: "v1", Kind: w.Kind, Resource: gvr.Resource, Namespace: w.Namespace, Name: w.Name, UID: string(w.UID)},
		ResourceVersion: rv, Domain: "workload:" + w.Key(), Level: assertion.LevelIrreversible,
		NeedsH: !headroom, BlastRadius: int64(len(pods)), Nodes: nodes, Snapshot: s,
		Prechecks: []execution.CheckResult{
			check("no_rollout", "k8s", !w.RolloutInProgress, "进行中的 rollout=%v", w.RolloutInProgress),
			check("pdb_headroom", "pdb", true, "PDB 余量=%v（没有余量时需要 H 档）%s", headroom, detail),
		},
	}, nil
}

func resourceVersion(ctx context.Context, d *Deps, gvr schema.GroupVersionResource, ns, name string) (string, error) {
	obj, err := d.Kube.Dyn.Resource(gvr).Namespace(ns).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return "", err
	}
	return obj.GetResourceVersion(), nil
}

// Execute 逐个驱逐：每一步先把 Pod UID 持久化到 status.progress，再驱逐，等它被替换且就绪数回到期望值。
func (e *rollingRestart) Execute(ctx context.Context, x *Exec) error {
	var s rollingSnapshot
	if err := fromMap(x.Snapshot, &s); err != nil {
		return err
	}
	w, err := e.workload(ctx, x.Params)
	if err != nil {
		return err
	}
	for i, uid := range s.PodUIDs {
		pod, err := getPod(ctx, e.d, w.Namespace, s.Names[i])
		if errors.Is(err, ErrTargetNotFound) || (err == nil && string(pod.UID) != uid) {
			continue
		}
		if err != nil {
			return err
		}
		if err := x.Progress(ctx, uid); err != nil {
			return err
		}
		if err := evict(ctx, e.d, x, pod, types.UID(uid)); err != nil {
			return err
		}
		if err := e.waitReady(ctx, w, types.UID(uid)); err != nil {
			return err
		}
	}
	return nil
}

func (e *rollingRestart) waitReady(ctx context.Context, w kube.Workload, gone types.UID) error {
	deadline := e.d.Now().Add(podReadyTimeout)
	for {
		cur, err := e.d.Kube.GetWorkload(ctx, w.Namespace, w.Kind, w.Name)
		if err != nil {
			return err
		}
		pods, err := e.d.Kube.PodsOf(ctx, cur)
		if err != nil {
			return err
		}
		present := false
		for i := range pods {
			if pods[i].UID == gone {
				present = true
			}
		}
		if !present && kube.ReadyPods(pods, gone) >= cur.Desired {
			return nil
		}
		if !e.d.Now().Before(deadline) {
			return fmt.Errorf("%s did not return to %d ready pods within %s", w.Key(), cur.Desired, podReadyTimeout)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(e.d.Poll):
		}
	}
}

// Observe：已开始的步骤与快照对照；全部被替换为 Applied，部分被替换为 Partial（由人判断），一个都没有为 NotApplied。
func (e *rollingRestart) Observe(ctx context.Context, x *Exec) (Observation, string, error) {
	var s rollingSnapshot
	if err := fromMap(x.Snapshot, &s); err != nil {
		return NotApplied, "", err
	}
	replaced := 0
	for i, uid := range s.PodUIDs {
		gone, err := podGoneOrReplaced(ctx, e.d, x.AE.Spec.Target.Namespace, s.Names[i], uid)
		if err != nil {
			return NotApplied, "", err
		}
		if gone {
			replaced++
		}
	}
	detail := fmt.Sprintf("已替换 %d/%d 个 Pod，已开始的步骤 %d", replaced, len(s.PodUIDs), len(x.AE.Status.Progress))
	switch {
	case replaced == len(s.PodUIDs):
		return Applied, detail, nil
	case replaced == 0 && len(x.AE.Status.Progress) == 0:
		return NotApplied, detail, nil
	}
	return Partial, detail, nil
}

func (e *rollingRestart) Verify(ctx context.Context, x *Exec) ([]execution.CheckResult, error) {
	var s rollingSnapshot
	if err := fromMap(x.Snapshot, &s); err != nil {
		return nil, err
	}
	w, err := e.workload(ctx, x.Params)
	if err != nil {
		return nil, err
	}
	pods, err := e.d.Kube.PodsOf(ctx, w)
	if err != nil {
		return nil, err
	}
	old := map[string]bool{}
	for _, u := range s.PodUIDs {
		old[u] = true
	}
	remaining := 0
	for _, p := range pods {
		if old[string(p.UID)] {
			remaining++
		}
	}
	ready := kube.ReadyPods(pods, "")
	return []execution.CheckResult{
		check("all_replaced", "k8s", remaining == 0, "仍未替换的 Pod %d 个", remaining),
		check("ready", "k8s", ready >= w.Desired, "就绪 %d/%d", ready, w.Desired),
	}, nil
}

func (e *rollingRestart) Undo(context.Context, *Exec) (string, error) { return "", ErrNoUndo }

func (e *rollingRestart) Compensation(*Exec) *execution.Compensation { return nil }

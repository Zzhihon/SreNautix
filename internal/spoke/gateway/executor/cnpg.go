package executor

import (
	"context"
	"encoding/json"
	"fmt"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"

	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/assertion"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/audit"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/execution"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/kube"
)

var clustersGVR = schema.GroupVersionResource{Group: "postgresql.cnpg.io", Version: "v1", Resource: "clusters"}

// CNPG 的标签与阶段（cloudnative-pg pkg/utils、api/v1）。
const (
	labelCNPGCluster      = "cnpg.io/cluster"
	labelCNPGInstanceRole = "cnpg.io/instanceRole"
	annotationCNPGFenced  = "cnpg.io/fencedInstances"
	phaseHealthy          = "Cluster in healthy state"
	phaseSwitchover       = "Switchover in progress"
)

func getCluster(ctx context.Context, d *Deps, ns, name string) (*unstructured.Unstructured, error) {
	c, err := d.Kube.Dyn.Resource(clustersGVR).Namespace(ns).Get(ctx, name, metav1.GetOptions{})
	if isNotFound(err) {
		return nil, fmt.Errorf("%w: cluster %s/%s", ErrTargetNotFound, ns, name)
	}
	if err != nil {
		return nil, fmt.Errorf("cluster %s/%s: %w", ns, name, err)
	}
	return c, nil
}

func fenced(c *unstructured.Unstructured, instance string) bool {
	v, ok := c.GetAnnotations()[annotationCNPGFenced]
	if !ok {
		return false
	}
	var list []string
	if json.Unmarshal([]byte(v), &list) != nil {
		return true
	}
	for _, s := range list {
		if s == "*" || s == instance {
			return true
		}
	}
	return false
}

// ── cnpg_replica_restart ─────────────────────────────────────────

type cnpgReplicaRestart struct{ d *Deps }

type cnpgInstanceParams struct {
	Namespace string `json:"namespace"`
	Cluster   string `json:"cluster"`
	Instance  string `json:"instance"`
}

func (e *cnpgReplicaRestart) Resolve(ctx context.Context, params json.RawMessage) (*Resolved, error) {
	var p cnpgInstanceParams
	if err := decode(params, &p); err != nil {
		return nil, err
	}
	cl, err := getCluster(ctx, e.d, p.Namespace, p.Cluster)
	if err != nil {
		return nil, err
	}
	pod, err := getPod(ctx, e.d, p.Namespace, p.Instance)
	if err != nil {
		return nil, err
	}
	primary := nestedString(cl.Object, "status", "currentPrimary")
	role := pod.Labels[labelCNPGInstanceRole]
	pp, err := getPod(ctx, e.d, p.Namespace, primary)
	if err != nil {
		return nil, err
	}
	primaryReady, _ := kube.PodReady(pp)
	replicas, err := e.d.Kube.Core.CoreV1().Pods(p.Namespace).List(ctx, metav1.ListOptions{
		LabelSelector: labelCNPGCluster + "=" + p.Cluster + "," + labelCNPGInstanceRole + "=replica"})
	if err != nil {
		return nil, err
	}
	var others []string
	for i := range replicas.Items {
		if ok, _ := kube.PodReady(&replicas.Items[i]); ok && replicas.Items[i].Name != p.Instance {
			others = append(others, replicas.Items[i].Name)
		}
	}
	nodes := []string{}
	if pod.Spec.NodeName != "" {
		nodes = append(nodes, pod.Spec.NodeName)
	}
	return &Resolved{
		Target: podTarget(pod), ResourceVersion: pod.ResourceVersion, Domain: "pg:" + p.Namespace + "/" + p.Cluster,
		Level: assertion.LevelIrreversible, BlastRadius: 1, Nodes: nodes, PGCluster: &[2]string{p.Namespace, p.Cluster},
		Snapshot: map[string]any{"podUid": string(pod.UID)},
		Prechecks: []execution.CheckResult{
			check("instance_of_cluster", "k8s", pod.Labels[labelCNPGCluster] == p.Cluster, "%s=%s", labelCNPGCluster, pod.Labels[labelCNPGCluster]),
			check("target_is_replica", "k8s", role == "replica" && p.Instance != primary, "角色 %s，当前主库 %s", role, primary),
			check("primary_ready", "k8s", primaryReady, "主库 %s 就绪=%v", primary, primaryReady),
			check("other_replica_ready", "k8s", len(others) >= 1, "除目标外就绪的副本：%v", others),
		},
	}, nil
}

func (e *cnpgReplicaRestart) Execute(ctx context.Context, x *Exec) error {
	var p cnpgInstanceParams
	if err := decode(x.Params, &p); err != nil {
		return err
	}
	pod, err := getPod(ctx, e.d, p.Namespace, p.Instance)
	if err != nil {
		return err
	}
	return evict(ctx, e.d, x, pod, types.UID(x.AE.Spec.Target.UID))
}

func (e *cnpgReplicaRestart) Observe(ctx context.Context, x *Exec) (Observation, string, error) {
	var p cnpgInstanceParams
	if err := decode(x.Params, &p); err != nil {
		return NotApplied, "", err
	}
	gone, err := podGoneOrReplaced(ctx, e.d, p.Namespace, p.Instance, x.AE.Spec.Target.UID)
	if err != nil {
		return NotApplied, "", err
	}
	if gone {
		return Applied, "实例 Pod 已被驱逐", nil
	}
	return NotApplied, "实例 Pod 仍在运行", nil
}

func (e *cnpgReplicaRestart) Verify(ctx context.Context, x *Exec) ([]execution.CheckResult, error) {
	var p cnpgInstanceParams
	if err := decode(x.Params, &p); err != nil {
		return nil, err
	}
	pod, err := e.d.Kube.Core.CoreV1().Pods(p.Namespace).Get(ctx, p.Instance, metav1.GetOptions{})
	if isNotFound(err) {
		return []execution.CheckResult{check("instance_ready", "k8s", false, "实例 Pod 尚未重建")}, nil
	}
	if err != nil {
		return nil, err
	}
	ready, _ := kube.PodReady(pod)
	replaced := string(pod.UID) != x.AE.Spec.Target.UID
	return []execution.CheckResult{check("instance_ready", "k8s", replaced && ready && pod.Labels[labelCNPGInstanceRole] == "replica",
		"重建=%v 就绪=%v 角色=%s", replaced, ready, pod.Labels[labelCNPGInstanceRole])}, nil
}

func (e *cnpgReplicaRestart) Undo(context.Context, *Exec) (string, error) { return "", ErrNoUndo }

func (e *cnpgReplicaRestart) Compensation(*Exec) *execution.Compensation { return nil }

// ── cnpg_switchover ──────────────────────────────────────────────

type cnpgSwitchover struct{ d *Deps }

type switchoverParams struct {
	Namespace      string `json:"namespace"`
	Cluster        string `json:"cluster"`
	TargetInstance string `json:"target_instance"`
}

func (e *cnpgSwitchover) Resolve(ctx context.Context, params json.RawMessage) (*Resolved, error) {
	var p switchoverParams
	if err := decode(params, &p); err != nil {
		return nil, err
	}
	cl, err := getCluster(ctx, e.d, p.Namespace, p.Cluster)
	if err != nil {
		return nil, err
	}
	pod, err := getPod(ctx, e.d, p.Namespace, p.TargetInstance)
	if err != nil {
		return nil, err
	}
	primary := nestedString(cl.Object, "status", "currentPrimary")
	phase := nestedString(cl.Object, "status", "phase")
	member := false
	names, _, _ := unstructured.NestedStringSlice(cl.Object, "status", "instanceNames")
	for _, n := range names {
		if n == p.TargetInstance {
			member = true
		}
	}
	ready, _ := kube.PodReady(pod)
	var nodes []string
	for _, n := range names {
		if ip, err := e.d.Kube.Core.CoreV1().Pods(p.Namespace).Get(ctx, n, metav1.GetOptions{}); err == nil && ip.Spec.NodeName != "" {
			nodes = append(nodes, ip.Spec.NodeName)
		}
	}
	return &Resolved{
		Target:          execution.TargetRef{Group: "postgresql.cnpg.io", Version: "v1", Kind: "Cluster", Resource: "clusters", Namespace: p.Namespace, Name: p.Cluster, UID: string(cl.GetUID())},
		ResourceVersion: cl.GetResourceVersion(), Domain: "pg:" + p.Namespace + "/" + p.Cluster, Level: assertion.LevelCompensable,
		BlastRadius: 1, Nodes: nodes, PGCluster: &[2]string{p.Namespace, p.Cluster},
		Snapshot: map[string]any{"originalPrimary": primary},
		Prechecks: []execution.CheckResult{
			check("cluster_healthy", "k8s", phase == phaseHealthy, "phase=%q", phase),
			check("target_is_replica", "k8s", member && p.TargetInstance != primary && pod.Labels[labelCNPGInstanceRole] == "replica" && ready && !fenced(cl, p.TargetInstance),
				"目标在实例中=%v，角色=%s，就绪=%v，隔离=%v，当前主库 %s", member, pod.Labels[labelCNPGInstanceRole], ready, fenced(cl, p.TargetInstance), primary),
		},
	}, nil
}

// promote 与 kubectl cnpg promote 一致：以 resourceVersion 乐观锁 merge patch status 子资源。
func (e *cnpgSwitchover) promote(ctx context.Context, x *Exec, ns, name, instance, rv string) error {
	now := e.d.Now().UTC()
	patch, err := json.Marshal(map[string]any{
		"metadata": map[string]any{"resourceVersion": rv},
		"status": map[string]any{
			"targetPrimary": instance, "targetPrimaryTimestamp": now.Format(metav1.RFC3339Micro),
			"phase": phaseSwitchover, "phaseReason": "Switching over to " + instance,
		},
	})
	if err != nil {
		return err
	}
	_, err = e.d.Kube.Dyn.Resource(clustersGVR).Namespace(ns).Patch(ctx, name, types.MergePatchType, patch, metav1.PatchOptions{}, "status")
	if werr := x.Wrote(ctx, audit.Target{Group: "postgresql.cnpg.io", Resource: "clusters", Subresource: "status", Namespace: ns, Name: name, UID: x.AE.Spec.Target.UID}, "patch", err); werr != nil {
		return werr
	}
	if err != nil {
		return fmt.Errorf("promote %s in %s/%s: %w", instance, ns, name, err)
	}
	return nil
}

func (e *cnpgSwitchover) Execute(ctx context.Context, x *Exec) error {
	var p switchoverParams
	if err := decode(x.Params, &p); err != nil {
		return err
	}
	return e.promote(ctx, x, p.Namespace, p.Cluster, p.TargetInstance, snapshotString(x.Snapshot, "resourceVersion"))
}

func (e *cnpgSwitchover) Observe(ctx context.Context, x *Exec) (Observation, string, error) {
	var p switchoverParams
	if err := decode(x.Params, &p); err != nil {
		return NotApplied, "", err
	}
	cl, err := getCluster(ctx, e.d, p.Namespace, p.Cluster)
	if err != nil {
		return NotApplied, "", err
	}
	tp := nestedString(cl.Object, "status", "targetPrimary")
	if tp == p.TargetInstance {
		return Applied, "status.targetPrimary=" + tp, nil
	}
	return NotApplied, "status.targetPrimary=" + tp, nil
}

func (e *cnpgSwitchover) Verify(ctx context.Context, x *Exec) ([]execution.CheckResult, error) {
	var p switchoverParams
	if err := decode(x.Params, &p); err != nil {
		return nil, err
	}
	cl, err := getCluster(ctx, e.d, p.Namespace, p.Cluster)
	if err != nil {
		return nil, err
	}
	cur := nestedString(cl.Object, "status", "currentPrimary")
	phase := nestedString(cl.Object, "status", "phase")
	pod, err := getPod(ctx, e.d, p.Namespace, p.TargetInstance)
	if err != nil {
		return nil, err
	}
	ready, _ := kube.PodReady(pod)
	return []execution.CheckResult{check("promoted", "k8s",
		cur == p.TargetInstance && pod.Labels[labelCNPGInstanceRole] == "primary" && ready && phase == phaseHealthy,
		"currentPrimary=%s，目标角色=%s 就绪=%v，phase=%q", cur, pod.Labels[labelCNPGInstanceRole], ready, phase)}, nil
}

func (e *cnpgSwitchover) Undo(context.Context, *Exec) (string, error) { return "", ErrNoUndo }

// Compensation：切换回原主库，作为新的提议再次审批。
func (e *cnpgSwitchover) Compensation(x *Exec) *execution.Compensation {
	var p switchoverParams
	if decode(x.Params, &p) != nil {
		return nil
	}
	params, err := json.Marshal(map[string]any{"namespace": p.Namespace, "cluster": p.Cluster, "target_instance": snapshotString(x.Snapshot, "originalPrimary")})
	if err != nil {
		return nil
	}
	return &execution.Compensation{Action: "cnpg_switchover", Params: rawExt(params), Reason: "执行后校验失败，建议切换回原主库 " + snapshotString(x.Snapshot, "originalPrimary")}
}

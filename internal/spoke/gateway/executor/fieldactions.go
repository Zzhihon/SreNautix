package executor

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"

	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/execution"
)

func isNotFound(err error) bool { return apierrors.IsNotFound(err) }

var (
	deploymentsGVR    = schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: "deployments"}
	statefulSetsGVR   = schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: "statefulsets"}
	hpaGVR            = schema.GroupVersionResource{Group: "autoscaling", Version: "v2", Resource: "horizontalpodautoscalers"}
	cronJobsGVR       = schema.GroupVersionResource{Group: "batch", Version: "v1", Resource: "cronjobs"}
	nodesGVR          = schema.GroupVersionResource{Version: "v1", Resource: "nodes"}
	applicationsGVR   = schema.GroupVersionResource{Group: "argoproj.io", Version: "v1alpha1", Resource: "applications"}
	kustomizationsGVR = schema.GroupVersionResource{Group: "kustomize.toolkit.fluxcd.io", Version: "v1", Resource: "kustomizations"}
	helmReleasesGVR   = schema.GroupVersionResource{Group: "helm.toolkit.fluxcd.io", Version: "v2", Resource: "helmreleases"}
)

// AnnotationCordonedBy 标记 SreNautix 做的 cordon，取值为执行 ID；node_uncordon 只解除带这个注解的 cordon。
const AnnotationCordonedBy = "srenautix.io/cordoned-by"

type nsKindName struct {
	Namespace string `json:"namespace"`
	Kind      string `json:"kind"`
	Name      string `json:"name"`
}

func workloadTarget(params json.RawMessage) (fieldTarget, error) {
	var p nsKindName
	if err := decode(params, &p); err != nil {
		return fieldTarget{}, err
	}
	switch p.Kind {
	case "Deployment":
		return fieldTarget{GVR: deploymentsGVR, Kind: p.Kind, Namespace: p.Namespace, Name: p.Name}, nil
	case "StatefulSet":
		return fieldTarget{GVR: statefulSetsGVR, Kind: p.Kind, Namespace: p.Namespace, Name: p.Name}, nil
	}
	return fieldTarget{}, fmt.Errorf("unsupported workload kind %q", p.Kind)
}

func toInt(v any) int64 {
	switch n := v.(type) {
	case int64:
		return n
	case float64:
		return int64(n)
	case int:
		return int64(n)
	}
	return 0
}

func abs(n int64) int64 {
	if n < 0 {
		return -n
	}
	return n
}

// workloadNodes 返回工作负载的 Pod 所在节点（自我保护判断用）。
func workloadNodes(ctx context.Context, d *Deps, ns, kind, name string) ([]string, error) {
	w, err := d.Kube.GetWorkload(ctx, ns, kind, name)
	if err != nil {
		return nil, err
	}
	pods, err := d.Kube.PodsOf(ctx, w)
	if err != nil {
		return nil, err
	}
	var out []string
	for _, p := range pods {
		if p.Spec.NodeName != "" {
			out = append(out, p.Spec.NodeName)
		}
	}
	return out, nil
}

func workloadScale(d *Deps) *fieldAction {
	return &fieldAction{
		d:      d,
		locate: workloadTarget,
		plan: func(ctx context.Context, params json.RawMessage, obj *unstructured.Unstructured) ([]change, []execution.CheckResult, int64, string, []string, error) {
			var p struct {
				nsKindName
				Replicas int64 `json:"replicas"`
			}
			if err := decode(params, &p); err != nil {
				return nil, nil, 0, "", nil, err
			}
			cur, found, _ := unstructured.NestedInt64(obj.Object, "spec", "replicas")
			if !found {
				cur = 1
			}
			hpas, err := d.Kube.Core.AutoscalingV2().HorizontalPodAutoscalers(p.Namespace).List(ctx, metav1.ListOptions{})
			if err != nil {
				return nil, nil, 0, "", nil, err
			}
			var managedBy []string
			for _, h := range hpas.Items {
				if h.Spec.ScaleTargetRef.Kind == p.Kind && h.Spec.ScaleTargetRef.Name == p.Name {
					managedBy = append(managedBy, h.Name)
				}
			}
			nodes, err := workloadNodes(ctx, d, p.Namespace, p.Kind, p.Name)
			if err != nil {
				return nil, nil, 0, "", nil, err
			}
			checks := []execution.CheckResult{
				check("no_hpa", "k8s", len(managedBy) == 0, "以该工作负载为目标的 HPA：%v", managedBy),
			}
			return []change{{Path: []string{"spec", "replicas"}, Value: p.Replicas}}, checks, abs(p.Replicas - cur),
				"workload:" + p.Namespace + "/" + p.Kind + "/" + p.Name, nodes, nil
		},
		verifyExtra: func(ctx context.Context, params json.RawMessage, obj *unstructured.Unstructured) ([]execution.CheckResult, error) {
			want, _, _ := unstructured.NestedInt64(obj.Object, "spec", "replicas")
			ready, _, _ := unstructured.NestedInt64(obj.Object, "status", "readyReplicas")
			gen := obj.GetGeneration()
			observed, _, _ := unstructured.NestedInt64(obj.Object, "status", "observedGeneration")
			return []execution.CheckResult{check("replicas_ready", "k8s", ready >= want && observed >= gen,
				"就绪副本 %d，期望 %d，observedGeneration %d/%d", ready, want, observed, gen)}, nil
		},
	}
}

func hpaBounds(d *Deps) *fieldAction {
	return &fieldAction{
		d: d,
		locate: func(params json.RawMessage) (fieldTarget, error) {
			var p struct {
				Namespace string `json:"namespace"`
				Name      string `json:"name"`
			}
			if err := decode(params, &p); err != nil {
				return fieldTarget{}, err
			}
			return fieldTarget{GVR: hpaGVR, Kind: "HorizontalPodAutoscaler", Namespace: p.Namespace, Name: p.Name}, nil
		},
		plan: func(ctx context.Context, params json.RawMessage, obj *unstructured.Unstructured) ([]change, []execution.CheckResult, int64, string, []string, error) {
			var p struct {
				Namespace string `json:"namespace"`
				Name      string `json:"name"`
				Min       int64  `json:"min_replicas"`
				Max       int64  `json:"max_replicas"`
			}
			if err := decode(params, &p); err != nil {
				return nil, nil, 0, "", nil, err
			}
			curMin, found, _ := unstructured.NestedInt64(obj.Object, "spec", "minReplicas")
			if !found {
				curMin = 1
			}
			curMax, _, _ := unstructured.NestedInt64(obj.Object, "spec", "maxReplicas")
			kind := nestedString(obj.Object, "spec", "scaleTargetRef", "kind")
			name := nestedString(obj.Object, "spec", "scaleTargetRef", "name")
			blast := abs(p.Min - curMin)
			if b := abs(p.Max - curMax); b > blast {
				blast = b
			}
			var nodes []string
			if kind == "Deployment" || kind == "StatefulSet" {
				n, err := workloadNodes(ctx, d, p.Namespace, kind, name)
				if err != nil && !isNotFound(err) {
					return nil, nil, 0, "", nil, err
				}
				nodes = n
			}
			checks := []execution.CheckResult{check("bounds_valid", "k8s", p.Min <= p.Max, "min_replicas %d，max_replicas %d", p.Min, p.Max)}
			return []change{
					{Path: []string{"spec", "minReplicas"}, Value: p.Min},
					{Path: []string{"spec", "maxReplicas"}, Value: p.Max},
				}, checks, blast,
				"workload:" + p.Namespace + "/" + kind + "/" + name, nodes, nil
		},
	}
}

type nsName struct {
	Namespace string `json:"namespace"`
	Name      string `json:"name"`
}

// boolToggle 生成把一个布尔字段设为 on（false 时删除该字段）的动作；require 为执行前该字段必须处于的状态。
func boolToggle(d *Deps, locate func(json.RawMessage) (fieldTarget, error), path []string, on bool, domain func(fieldTarget) string) *fieldAction {
	return &fieldAction{
		d:      d,
		locate: locate,
		plan: func(ctx context.Context, params json.RawMessage, obj *unstructured.Unstructured) ([]change, []execution.CheckResult, int64, string, []string, error) {
			t, err := locate(params)
			if err != nil {
				return nil, nil, 0, "", nil, err
			}
			cur, _, _ := unstructured.NestedBool(obj.Object, path...)
			c := change{Path: path, Value: true}
			if !on {
				c = change{Path: path, Remove: true}
			}
			checks := []execution.CheckResult{check("state", "k8s", cur != on, "%v 当前为 %v", path, cur)}
			return []change{c}, checks, 1, domain(t), nil, nil
		},
	}
}

func rolloutToggle(d *Deps, pause bool) *fieldAction {
	locate := func(params json.RawMessage) (fieldTarget, error) {
		var p nsName
		if err := decode(params, &p); err != nil {
			return fieldTarget{}, err
		}
		return fieldTarget{GVR: deploymentsGVR, Kind: "Deployment", Namespace: p.Namespace, Name: p.Name}, nil
	}
	return boolToggle(d, locate, []string{"spec", "paused"}, pause, func(t fieldTarget) string {
		return "workload:" + t.Namespace + "/Deployment/" + t.Name
	})
}

func cronJobToggle(d *Deps, suspend bool) *fieldAction {
	locate := func(params json.RawMessage) (fieldTarget, error) {
		var p nsName
		if err := decode(params, &p); err != nil {
			return fieldTarget{}, err
		}
		return fieldTarget{GVR: cronJobsGVR, Kind: "CronJob", Namespace: p.Namespace, Name: p.Name}, nil
	}
	a := boolToggle(d, locate, []string{"spec", "suspend"}, suspend, func(t fieldTarget) string {
		return "workload:" + t.Namespace + "/CronJob/" + t.Name
	})
	if !suspend {
		// 恢复调度时写入 false（CronJob 的 suspend 默认值为 false）
		plan := a.plan
		a.plan = func(ctx context.Context, params json.RawMessage, obj *unstructured.Unstructured) ([]change, []execution.CheckResult, int64, string, []string, error) {
			_, checks, blast, domain, nodes, err := plan(ctx, params, obj)
			return []change{{Path: []string{"spec", "suspend"}, Value: false}}, checks, blast, domain, nodes, err
		}
	}
	return a
}

func fluxToggle(d *Deps, suspend bool) *fieldAction {
	locate := func(params json.RawMessage) (fieldTarget, error) {
		var p nsKindName
		if err := decode(params, &p); err != nil {
			return fieldTarget{}, err
		}
		switch p.Kind {
		case "Kustomization":
			return fieldTarget{GVR: kustomizationsGVR, Kind: p.Kind, Namespace: p.Namespace, Name: p.Name}, nil
		case "HelmRelease":
			return fieldTarget{GVR: helmReleasesGVR, Kind: p.Kind, Namespace: p.Namespace, Name: p.Name}, nil
		}
		return fieldTarget{}, fmt.Errorf("unsupported flux kind %q", p.Kind)
	}
	return boolToggle(d, locate, []string{"spec", "suspend"}, suspend, func(t fieldTarget) string {
		return "flux:" + t.Namespace + "/" + t.Kind + "/" + t.Name
	})
}

func autosyncToggle(d *Deps, enable bool) *fieldAction {
	locate := func(params json.RawMessage) (fieldTarget, error) {
		var p struct {
			Namespace   string `json:"namespace"`
			Application string `json:"application"`
		}
		if err := decode(params, &p); err != nil {
			return fieldTarget{}, err
		}
		return fieldTarget{GVR: applicationsGVR, Kind: "Application", Namespace: p.Namespace, Name: p.Application}, nil
	}
	path := []string{"spec", "syncPolicy", "automated", "enabled"}
	return &fieldAction{
		d:      d,
		locate: locate,
		plan: func(ctx context.Context, params json.RawMessage, obj *unstructured.Unstructured) ([]change, []execution.CheckResult, int64, string, []string, error) {
			t, err := locate(params)
			if err != nil {
				return nil, nil, 0, "", nil, err
			}
			_, automated, _ := unstructured.NestedMap(obj.Object, "spec", "syncPolicy", "automated")
			enabled, set, _ := unstructured.NestedBool(obj.Object, path...)
			current := automated && (!set || enabled)
			checks := []execution.CheckResult{
				check("automated_present", "k8s", automated, "spec.syncPolicy.automated 存在=%v", automated),
				check("state", "k8s", current != enable, "自动同步当前开启=%v", current),
			}
			return []change{{Path: path, Value: enable}}, checks, 1, "argocd:" + t.Namespace + "/" + t.Name, nil, nil
		},
	}
}

var executionIDPattern = regexp.MustCompile(`^[0-9a-f]{32}$`)

func nodeTarget(params json.RawMessage) (fieldTarget, error) {
	var p struct {
		Node string `json:"node"`
	}
	if err := decode(params, &p); err != nil {
		return fieldTarget{}, err
	}
	return fieldTarget{GVR: nodesGVR, Kind: "Node", Name: p.Node}, nil
}

func asNode(obj *unstructured.Unstructured) (*corev1.Node, error) {
	n := &corev1.Node{}
	if err := runtime.DefaultUnstructuredConverter.FromUnstructured(obj.Object, n); err != nil {
		return nil, err
	}
	return n, nil
}

func nodeCondition(n *corev1.Node, t corev1.NodeConditionType) corev1.ConditionStatus {
	for _, c := range n.Status.Conditions {
		if c.Type == t {
			return c.Status
		}
	}
	return corev1.ConditionUnknown
}

func isControlPlane(n *corev1.Node) bool {
	for _, l := range []string{"node-role.kubernetes.io/control-plane", "node-role.kubernetes.io/master"} {
		if _, ok := n.Labels[l]; ok {
			return true
		}
	}
	return false
}

// roleOf 返回节点的 node-role 标签集合，作为"同类节点"的依据。
func roleOf(n *corev1.Node) string {
	var roles []string
	for k := range n.Labels {
		if r, ok := strings.CutPrefix(k, "node-role.kubernetes.io/"); ok {
			roles = append(roles, r)
		}
	}
	sort.Strings(roles)
	return fmt.Sprint(roles)
}

func nodeCordon(d *Deps) *fieldAction {
	return &fieldAction{
		d:      d,
		locate: nodeTarget,
		plan: func(ctx context.Context, params json.RawMessage, obj *unstructured.Unstructured) ([]change, []execution.CheckResult, int64, string, []string, error) {
			n, err := asNode(obj)
			if err != nil {
				return nil, nil, 0, "", nil, err
			}
			nodes, err := d.Kube.Core.CoreV1().Nodes().List(ctx, metav1.ListOptions{})
			if err != nil {
				return nil, nil, 0, "", nil, err
			}
			var remain []string
			for i := range nodes.Items {
				o := &nodes.Items[i]
				if o.Name != n.Name && roleOf(o) == roleOf(n) && !o.Spec.Unschedulable && nodeCondition(o, corev1.NodeReady) == corev1.ConditionTrue {
					remain = append(remain, o.Name)
				}
			}
			checks := []execution.CheckResult{
				check("not_control_plane", "k8s", !isControlPlane(n), "节点角色 %s", roleOf(n)),
				check("schedulable", "k8s", !n.Spec.Unschedulable, "spec.unschedulable=%v", n.Spec.Unschedulable),
				check("capacity_remains", "k8s", len(remain) > 0, "cordon 后同类（%s）仍可调度的节点：%v", roleOf(n), remain),
			}
			return []change{
				{Path: []string{"spec", "unschedulable"}, Value: true},
				{Path: []string{"metadata", "annotations", AnnotationCordonedBy}, Value: executionIDValue},
			}, checks, 1, "node:" + n.Name, []string{n.Name}, nil
		},
	}
}

func nodeUncordon(d *Deps) *fieldAction {
	return &fieldAction{
		d:      d,
		locate: nodeTarget,
		plan: func(ctx context.Context, params json.RawMessage, obj *unstructured.Unstructured) ([]change, []execution.CheckResult, int64, string, []string, error) {
			n, err := asNode(obj)
			if err != nil {
				return nil, nil, 0, "", nil, err
			}
			by := n.Annotations[AnnotationCordonedBy]
			var pressures []corev1.NodeConditionType
			for _, t := range []corev1.NodeConditionType{corev1.NodeMemoryPressure, corev1.NodeDiskPressure, corev1.NodePIDPressure} {
				if nodeCondition(n, t) == corev1.ConditionTrue {
					pressures = append(pressures, t)
				}
			}
			checks := []execution.CheckResult{
				check("cordoned_by_srenautix", "k8s", n.Spec.Unschedulable && executionIDPattern.MatchString(by),
					"spec.unschedulable=%v，%s=%q（只解除 SreNautix 做的 cordon）", n.Spec.Unschedulable, AnnotationCordonedBy, by),
				check("node_ready", "k8s", nodeCondition(n, corev1.NodeReady) == corev1.ConditionTrue, "Ready=%s", nodeCondition(n, corev1.NodeReady)),
				check("no_pressure", "k8s", len(pressures) == 0, "资源压力：%v", pressures),
			}
			return []change{
				{Path: []string{"spec", "unschedulable"}, Remove: true},
				{Path: []string{"metadata", "annotations", AnnotationCordonedBy}, Remove: true},
			}, checks, 1, "node:" + n.Name, []string{n.Name}, nil
		},
	}
}

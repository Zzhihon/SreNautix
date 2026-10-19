package executor

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"

	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/audit"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/execution"
)

// change 是对一个字段的修改；Remove 为 true 时删除该字段。
type change struct {
	Path   []string `json:"path"`
	Value  any      `json:"value,omitempty"`
	Remove bool     `json:"remove,omitempty"`
}

// fieldState 是一个字段修改前的值。
type fieldState struct {
	Path    []string `json:"path"`
	Present bool     `json:"present"`
	Value   any      `json:"value,omitempty"`
}

// fieldSnapshot 是字段类动作的快照。
type fieldSnapshot struct {
	ResourceVersion string       `json:"resourceVersion"`
	Changes         []change     `json:"changes"`
	Before          []fieldState `json:"before"`
}

// fieldTarget 是字段类动作的目标定位。
type fieldTarget struct {
	GVR       schema.GroupVersionResource
	Kind      string
	Namespace string
	Name      string
}

// fieldAction 实现"把若干字段改成期望值、撤销时恢复原值"的可撤销动作：
// workload_scale、hpa_bounds_set、rollout_*、cronjob_*、node_*、argocd_autosync_*、flux_suspend/resume。
type fieldAction struct {
	d *Deps
	// locate 由参数确定目标。
	locate func(params json.RawMessage) (fieldTarget, error)
	// plan 返回期望的修改、预检、爆炸半径与冲突域。
	plan func(ctx context.Context, params json.RawMessage, obj *unstructured.Unstructured) (changes []change, checks []execution.CheckResult, blast int64, domain string, nodes []string, err error)
	// verifyExtra 在字段已为期望值之外追加的校验（例如副本就绪）。
	verifyExtra func(ctx context.Context, params json.RawMessage, obj *unstructured.Unstructured) ([]execution.CheckResult, error)
}

// executionIDValue 是取值为执行 ID 的字段在 plan 中的占位值（node_cordon 的 srenautix.io/cordoned-by），执行时替换。
const executionIDValue = "$(execution-id)"

func bind(changes []change, id string) []change {
	out := make([]change, len(changes))
	for i, c := range changes {
		if s, ok := c.Value.(string); ok && s == executionIDValue {
			c.Value = id
		}
		out[i] = c
	}
	return out
}

func (a *fieldAction) get(ctx context.Context, t fieldTarget) (*unstructured.Unstructured, error) {
	ri := a.d.Kube.Dyn.Resource(t.GVR)
	var obj *unstructured.Unstructured
	var err error
	if t.Namespace != "" {
		obj, err = ri.Namespace(t.Namespace).Get(ctx, t.Name, metav1.GetOptions{})
	} else {
		obj, err = ri.Get(ctx, t.Name, metav1.GetOptions{})
	}
	if err != nil {
		if isNotFound(err) {
			return nil, fmt.Errorf("%w: %s %s/%s", ErrTargetNotFound, t.Kind, t.Namespace, t.Name)
		}
		return nil, fmt.Errorf("get %s %s/%s: %w", t.Kind, t.Namespace, t.Name, err)
	}
	return obj, nil
}

func fieldValue(obj *unstructured.Unstructured, path []string) (any, bool) {
	v, found, err := unstructured.NestedFieldNoCopy(obj.Object, path...)
	if err != nil || !found {
		return nil, false
	}
	return v, true
}

// sameJSON 按 JSON 语义比较两个值（int64 与 float64 视为相等）。
func sameJSON(a, b any) bool {
	ja, err1 := json.Marshal(a)
	jb, err2 := json.Marshal(b)
	if err1 != nil || err2 != nil {
		return false
	}
	var va, vb any
	if json.Unmarshal(ja, &va) != nil || json.Unmarshal(jb, &vb) != nil {
		return false
	}
	return reflect.DeepEqual(va, vb)
}

func (a *fieldAction) Resolve(ctx context.Context, params json.RawMessage) (*Resolved, error) {
	t, err := a.locate(params)
	if err != nil {
		return nil, err
	}
	obj, err := a.get(ctx, t)
	if err != nil {
		return nil, err
	}
	changes, checks, blast, domain, nodes, err := a.plan(ctx, params, obj)
	if err != nil {
		return nil, err
	}
	snap := fieldSnapshot{ResourceVersion: obj.GetResourceVersion(), Changes: changes}
	differs := false
	for _, c := range changes {
		v, ok := fieldValue(obj, c.Path)
		snap.Before = append(snap.Before, fieldState{Path: c.Path, Present: ok, Value: v})
		if c.Remove == ok || (!c.Remove && !sameJSON(v, c.Value)) {
			differs = true
		}
	}
	checks = append(checks, check("changes_something", "k8s", differs, "期望的修改与当前值不同"))
	s, err := toMap(snap)
	if err != nil {
		return nil, err
	}
	return &Resolved{
		Target:          execution.TargetRef{Group: t.GVR.Group, Version: t.GVR.Version, Kind: t.Kind, Resource: t.GVR.Resource, Namespace: t.Namespace, Name: t.Name, UID: string(obj.GetUID())},
		ResourceVersion: obj.GetResourceVersion(), Domain: domain, BlastRadius: blast, Nodes: nodes, Prechecks: checks, Snapshot: s,
	}, nil
}

func toMap(v any) (map[string]any, error) {
	raw, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	var m map[string]any
	return m, json.Unmarshal(raw, &m)
}

func fromMap(m map[string]any, v any) error {
	raw, err := json.Marshal(m)
	if err != nil {
		return err
	}
	return json.Unmarshal(raw, v)
}

// patchOps 把修改转换为 JSON Patch：先测试 resourceVersion，再写注解与字段。
func patchOps(obj *unstructured.Unstructured, rv string, annotations map[string]string, changes []change) []map[string]any {
	ops := []map[string]any{testRV(rv)}
	ops = append(ops, annotationOps(obj, annotations)...)
	for _, c := range changes {
		_, present := fieldValue(obj, c.Path)
		switch {
		case c.Remove && present:
			ops = append(ops, map[string]any{"op": "remove", "path": pointer(c.Path)})
		case !c.Remove:
			ops = append(ops, ensureParents(obj, c.Path)...)
			ops = append(ops, map[string]any{"op": "add", "path": pointer(c.Path), "value": c.Value})
		}
	}
	return ops
}

// ensureParents 为不存在的父对象补上空对象（注解键除外，注解对象由 annotationOps 保证存在）。
func ensureParents(obj *unstructured.Unstructured, path []string) []map[string]any {
	var ops []map[string]any
	for i := 1; i < len(path); i++ {
		parent := path[:i]
		if len(parent) == 2 && parent[0] == "metadata" && parent[1] == "annotations" {
			continue
		}
		if _, ok := fieldValue(obj, parent); !ok {
			ops = append(ops, map[string]any{"op": "add", "path": pointer(parent), "value": map[string]any{}})
			// 后续的父对象在新建的空对象中，同样需要创建
			obj = obj.DeepCopy()
			_ = unstructured.SetNestedField(obj.Object, map[string]any{}, parent...)
		}
	}
	return ops
}

func (a *fieldAction) patch(ctx context.Context, x *Exec, t fieldTarget, ops []map[string]any) error {
	body, err := json.Marshal(ops)
	if err != nil {
		return err
	}
	ri := a.d.Kube.Dyn.Resource(t.GVR)
	if t.Namespace != "" {
		_, err = ri.Namespace(t.Namespace).Patch(ctx, t.Name, types.JSONPatchType, body, metav1.PatchOptions{})
	} else {
		_, err = ri.Patch(ctx, t.Name, types.JSONPatchType, body, metav1.PatchOptions{})
	}
	if werr := x.Wrote(ctx, audit.Target{Group: t.GVR.Group, Resource: t.GVR.Resource, Namespace: t.Namespace, Name: t.Name, UID: x.AE.Spec.Target.UID}, "patch", err); werr != nil {
		return werr
	}
	if err != nil {
		return fmt.Errorf("patch %s %s/%s: %w", t.Kind, t.Namespace, t.Name, err)
	}
	return nil
}

func (a *fieldAction) annotations(x *Exec) map[string]string {
	return map[string]string{execution.AnnotationExecutionID: x.ID()}
}

func (a *fieldAction) Execute(ctx context.Context, x *Exec) error {
	t, err := a.locate(x.Params)
	if err != nil {
		return err
	}
	var snap fieldSnapshot
	if err := fromMap(x.Snapshot, &snap); err != nil {
		return err
	}
	obj, err := a.get(ctx, t)
	if err != nil {
		return err
	}
	return a.patch(ctx, x, t, patchOps(obj, snap.ResourceVersion, a.annotations(x), bind(snap.Changes, x.ID())))
}

// applied 判断字段与注解是否都已是本次执行写入的值。
func (a *fieldAction) applied(obj *unstructured.Unstructured, x *Exec, changes []change) (bool, string) {
	if obj.GetAnnotations()[execution.AnnotationExecutionID] != x.ID() {
		return false, "对象上没有本次执行的注解"
	}
	for _, c := range bind(changes, x.ID()) {
		v, ok := fieldValue(obj, c.Path)
		if c.Remove == ok || (!c.Remove && !sameJSON(v, c.Value)) {
			return false, fmt.Sprintf("%s 当前为 %v", strings.Join(c.Path, "."), v)
		}
	}
	return true, "字段为执行写入的值"
}

func (a *fieldAction) Observe(ctx context.Context, x *Exec) (Observation, string, error) {
	t, err := a.locate(x.Params)
	if err != nil {
		return NotApplied, "", err
	}
	var snap fieldSnapshot
	if err := fromMap(x.Snapshot, &snap); err != nil {
		return NotApplied, "", err
	}
	obj, err := a.get(ctx, t)
	if err != nil {
		return NotApplied, "", err
	}
	ok, detail := a.applied(obj, x, snap.Changes)
	if ok {
		return Applied, detail, nil
	}
	return NotApplied, detail, nil
}

func (a *fieldAction) Verify(ctx context.Context, x *Exec) ([]execution.CheckResult, error) {
	t, err := a.locate(x.Params)
	if err != nil {
		return nil, err
	}
	var snap fieldSnapshot
	if err := fromMap(x.Snapshot, &snap); err != nil {
		return nil, err
	}
	obj, err := a.get(ctx, t)
	if err != nil {
		return nil, err
	}
	ok, detail := a.applied(obj, x, snap.Changes)
	checks := []execution.CheckResult{check("fields_applied", "k8s", ok, "%s", detail)}
	if a.verifyExtra != nil {
		extra, err := a.verifyExtra(ctx, x.Params, obj)
		if err != nil {
			return nil, err
		}
		checks = append(checks, extra...)
	}
	return checks, nil
}

// Undo 把字段恢复为执行前的值；字段已被别人改动时返回 ErrUndoConflict。
func (a *fieldAction) Undo(ctx context.Context, x *Exec) (string, error) {
	t, err := a.locate(x.Params)
	if err != nil {
		return "", err
	}
	var snap fieldSnapshot
	if err := fromMap(x.Snapshot, &snap); err != nil {
		return "", err
	}
	obj, err := a.get(ctx, t)
	if err != nil {
		return "", err
	}
	if ok, detail := a.applied(obj, x, snap.Changes); !ok {
		return "", fmt.Errorf("%w: %s", ErrUndoConflict, detail)
	}
	var restore []change
	for _, b := range snap.Before {
		restore = append(restore, change{Path: b.Path, Value: b.Value, Remove: !b.Present})
	}
	if err := a.patch(ctx, x, t, patchOps(obj, obj.GetResourceVersion(), map[string]string{execution.AnnotationExecutionID: x.ID()}, restore)); err != nil {
		return "", err
	}
	return "已恢复执行前的值", nil
}

func (a *fieldAction) Compensation(*Exec) *execution.Compensation { return nil }

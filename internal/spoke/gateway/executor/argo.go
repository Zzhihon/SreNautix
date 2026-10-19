package executor

import (
	"context"
	"encoding/json"
	"fmt"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/types"

	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/assertion"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/audit"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/execution"
)

type appParams struct {
	Namespace   string `json:"namespace"`
	Application string `json:"application"`
	Revision    string `json:"revision"`
}

func getApp(ctx context.Context, d *Deps, ns, name string) (*unstructured.Unstructured, error) {
	a, err := d.Kube.Dyn.Resource(applicationsGVR).Namespace(ns).Get(ctx, name, metav1.GetOptions{})
	if isNotFound(err) {
		return nil, fmt.Errorf("%w: application %s/%s", ErrTargetNotFound, ns, name)
	}
	if err != nil {
		return nil, fmt.Errorf("application %s/%s: %w", ns, name, err)
	}
	return a, nil
}

func appTarget(a *unstructured.Unstructured) execution.TargetRef {
	return execution.TargetRef{Group: "argoproj.io", Version: "v1alpha1", Kind: "Application", Resource: "applications",
		Namespace: a.GetNamespace(), Name: a.GetName(), UID: string(a.GetUID())}
}

// jsonPatch 对命名空间内的对象提交 JSON Patch 并记录写入。
func jsonPatch(ctx context.Context, d *Deps, x *Exec, t fieldTarget, uid string, ops []map[string]any) error {
	body, err := json.Marshal(ops)
	if err != nil {
		return err
	}
	_, err = d.Kube.Dyn.Resource(t.GVR).Namespace(t.Namespace).Patch(ctx, t.Name, types.JSONPatchType, body, metav1.PatchOptions{})
	if werr := x.Wrote(ctx, audit.Target{Group: t.GVR.Group, Resource: t.GVR.Resource, Namespace: t.Namespace, Name: t.Name, UID: uid}, "patch", err); werr != nil {
		return werr
	}
	if err != nil {
		return fmt.Errorf("patch %s %s/%s: %w", t.Kind, t.Namespace, t.Name, err)
	}
	return nil
}

// ── argocd_app_sync ──────────────────────────────────────────────

type argoSync struct{ d *Deps }

func (e *argoSync) Resolve(ctx context.Context, params json.RawMessage) (*Resolved, error) {
	var p appParams
	if err := decode(params, &p); err != nil {
		return nil, err
	}
	a, err := getApp(ctx, e.d, p.Namespace, p.Application)
	if err != nil {
		return nil, err
	}
	_, hasOp := a.Object["operation"]
	phase := nestedString(a.Object, "status", "operationState", "phase")
	_, multi, _ := unstructured.NestedSlice(a.Object, "spec", "sources")
	resolved := nestedString(a.Object, "status", "sync", "revision")
	resources, _, _ := unstructured.NestedSlice(a.Object, "status", "resources")
	return &Resolved{
		Target: appTarget(a), ResourceVersion: a.GetResourceVersion(), Domain: "argocd:" + p.Namespace + "/" + p.Application,
		Level: assertion.LevelIrreversible, BlastRadius: int64(len(resources)),
		Snapshot: map[string]any{"lastSyncedRevision": nestedString(a.Object, "status", "operationState", "syncResult", "revision")},
		Prechecks: []execution.CheckResult{
			check("no_operation", "k8s", !hasOp && phase != "Running" && phase != "Terminating", "operation 存在=%v，phase=%q", hasOp, phase),
			check("single_source", "k8s", !multi, "spec.sources 存在=%v", multi),
			check("revision_is_target", "k8s", p.Revision == resolved, "status.sync.revision=%s，提议 %s", resolved, p.Revision),
		},
	}, nil
}

func (e *argoSync) Execute(ctx context.Context, x *Exec) error {
	var p appParams
	if err := decode(x.Params, &p); err != nil {
		return err
	}
	a, err := getApp(ctx, e.d, p.Namespace, p.Application)
	if err != nil {
		return err
	}
	op := map[string]any{
		"initiatedBy": map[string]any{"username": "srenautix-gateway", "automated": false},
		"info":        []any{map[string]any{"name": "srenautix-execution-id", "value": x.ID()}},
		"sync":        map[string]any{"revision": p.Revision, "prune": false},
	}
	ops := []map[string]any{testRV(snapshotString(x.Snapshot, SnapshotResourceVersion))}
	ops = append(ops, annotationOps(a, map[string]string{execution.AnnotationExecutionID: x.ID()})...)
	ops = append(ops, map[string]any{"op": "add", "path": "/operation", "value": op})
	return jsonPatch(ctx, e.d, x, fieldTarget{GVR: applicationsGVR, Kind: "Application", Namespace: p.Namespace, Name: p.Application}, x.AE.Spec.Target.UID, ops)
}

func (e *argoSync) Observe(ctx context.Context, x *Exec) (Observation, string, error) {
	var p appParams
	if err := decode(x.Params, &p); err != nil {
		return NotApplied, "", err
	}
	a, err := getApp(ctx, e.d, p.Namespace, p.Application)
	if err != nil {
		return NotApplied, "", err
	}
	if a.GetAnnotations()[execution.AnnotationExecutionID] != x.ID() {
		return NotApplied, "Application 上没有本次执行的注解", nil
	}
	op := nestedString(a.Object, "operation", "sync", "revision")
	done := nestedString(a.Object, "status", "operationState", "operation", "sync", "revision")
	if op == p.Revision || done == p.Revision {
		return Applied, "同步操作已写入，revision " + p.Revision, nil
	}
	return NotApplied, "operation revision=" + op, nil
}

func (e *argoSync) Verify(ctx context.Context, x *Exec) ([]execution.CheckResult, error) {
	var p appParams
	if err := decode(x.Params, &p); err != nil {
		return nil, err
	}
	a, err := getApp(ctx, e.d, p.Namespace, p.Application)
	if err != nil {
		return nil, err
	}
	phase := nestedString(a.Object, "status", "operationState", "phase")
	rev := nestedString(a.Object, "status", "operationState", "syncResult", "revision")
	sync := nestedString(a.Object, "status", "sync", "status")
	health := nestedString(a.Object, "status", "health", "status")
	return []execution.CheckResult{check("synced", "k8s", phase == "Succeeded" && rev == p.Revision && sync == "Synced" && health == "Healthy",
		"operation=%s revision=%s sync=%s health=%s", phase, rev, sync, health)}, nil
}

func (e *argoSync) Undo(context.Context, *Exec) (string, error) { return "", ErrNoUndo }
func (e *argoSync) Compensation(*Exec) *execution.Compensation  { return nil }

// ── argocd_app_terminate_operation ───────────────────────────────

type argoTerminate struct{ d *Deps }

func (e *argoTerminate) Resolve(ctx context.Context, params json.RawMessage) (*Resolved, error) {
	var p appParams
	if err := decode(params, &p); err != nil {
		return nil, err
	}
	a, err := getApp(ctx, e.d, p.Namespace, p.Application)
	if err != nil {
		return nil, err
	}
	phase := nestedString(a.Object, "status", "operationState", "phase")
	return &Resolved{
		Target: appTarget(a), ResourceVersion: a.GetResourceVersion(), Domain: "argocd:" + p.Namespace + "/" + p.Application,
		Level: assertion.LevelIrreversible, BlastRadius: 1, Snapshot: map[string]any{},
		Prechecks: []execution.CheckResult{check("operation_running", "k8s", phase == "Running", "operationState.phase=%q", phase)},
	}, nil
}

// Execute 与 Argo CD API server 的 TerminateOperation 相同：把运行中的 operationState.phase 改为 Terminating。
func (e *argoTerminate) Execute(ctx context.Context, x *Exec) error {
	var p appParams
	if err := decode(x.Params, &p); err != nil {
		return err
	}
	a, err := getApp(ctx, e.d, p.Namespace, p.Application)
	if err != nil {
		return err
	}
	ops := []map[string]any{testRV(snapshotString(x.Snapshot, SnapshotResourceVersion))}
	ops = append(ops, annotationOps(a, map[string]string{execution.AnnotationExecutionID: x.ID()})...)
	ops = append(ops,
		map[string]any{"op": "test", "path": "/status/operationState/phase", "value": "Running"},
		map[string]any{"op": "replace", "path": "/status/operationState/phase", "value": "Terminating"})
	return jsonPatch(ctx, e.d, x, fieldTarget{GVR: applicationsGVR, Kind: "Application", Namespace: p.Namespace, Name: p.Application}, x.AE.Spec.Target.UID, ops)
}

func (e *argoTerminate) Observe(ctx context.Context, x *Exec) (Observation, string, error) {
	var p appParams
	if err := decode(x.Params, &p); err != nil {
		return NotApplied, "", err
	}
	a, err := getApp(ctx, e.d, p.Namespace, p.Application)
	if err != nil {
		return NotApplied, "", err
	}
	if a.GetAnnotations()[execution.AnnotationExecutionID] == x.ID() {
		return Applied, "Application 带本次执行的注解", nil
	}
	return NotApplied, "phase=" + nestedString(a.Object, "status", "operationState", "phase"), nil
}

func (e *argoTerminate) Verify(ctx context.Context, x *Exec) ([]execution.CheckResult, error) {
	var p appParams
	if err := decode(x.Params, &p); err != nil {
		return nil, err
	}
	a, err := getApp(ctx, e.d, p.Namespace, p.Application)
	if err != nil {
		return nil, err
	}
	phase := nestedString(a.Object, "status", "operationState", "phase")
	return []execution.CheckResult{check("terminated", "k8s", phase == "Failed" || phase == "Error", "operationState.phase=%q", phase)}, nil
}

func (e *argoTerminate) Undo(context.Context, *Exec) (string, error) { return "", ErrNoUndo }
func (e *argoTerminate) Compensation(*Exec) *execution.Compensation  { return nil }

// ── flux_reconcile ───────────────────────────────────────────────

type fluxReconcile struct{ d *Deps }

// AnnotationFluxRequest 是 Flux 的调和请求注解（fluxcd/pkg/apis/meta ReconcileRequestAnnotation）。
const AnnotationFluxRequest = "reconcile.fluxcd.io/requestedAt"

func fluxTarget(params json.RawMessage) (fieldTarget, error) {
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

func (e *fluxReconcile) get(ctx context.Context, t fieldTarget) (*unstructured.Unstructured, error) {
	o, err := e.d.Kube.Dyn.Resource(t.GVR).Namespace(t.Namespace).Get(ctx, t.Name, metav1.GetOptions{})
	if isNotFound(err) {
		return nil, fmt.Errorf("%w: %s %s/%s", ErrTargetNotFound, t.Kind, t.Namespace, t.Name)
	}
	return o, err
}

func (e *fluxReconcile) Resolve(ctx context.Context, params json.RawMessage) (*Resolved, error) {
	t, err := fluxTarget(params)
	if err != nil {
		return nil, err
	}
	o, err := e.get(ctx, t)
	if err != nil {
		return nil, err
	}
	suspended, _, _ := unstructured.NestedBool(o.Object, "spec", "suspend")
	return &Resolved{
		Target:          execution.TargetRef{Group: t.GVR.Group, Version: t.GVR.Version, Kind: t.Kind, Resource: t.GVR.Resource, Namespace: t.Namespace, Name: t.Name, UID: string(o.GetUID())},
		ResourceVersion: o.GetResourceVersion(), Domain: "flux:" + t.Namespace + "/" + t.Kind + "/" + t.Name,
		Level: assertion.LevelIrreversible, BlastRadius: 1, Snapshot: map[string]any{},
		Prechecks: []execution.CheckResult{check("not_suspended", "k8s", !suspended, "spec.suspend=%v", suspended)},
	}, nil
}

// Execute 把执行 ID 写入调和请求注解；Flux 处理后把同一个值写入 status.lastHandledReconcileAt。
func (e *fluxReconcile) Execute(ctx context.Context, x *Exec) error {
	t, err := fluxTarget(x.Params)
	if err != nil {
		return err
	}
	o, err := e.get(ctx, t)
	if err != nil {
		return err
	}
	ops := []map[string]any{testRV(snapshotString(x.Snapshot, SnapshotResourceVersion))}
	ops = append(ops, annotationOps(o, map[string]string{execution.AnnotationExecutionID: x.ID(), AnnotationFluxRequest: x.ID()})...)
	return jsonPatch(ctx, e.d, x, t, x.AE.Spec.Target.UID, ops)
}

func (e *fluxReconcile) Observe(ctx context.Context, x *Exec) (Observation, string, error) {
	t, err := fluxTarget(x.Params)
	if err != nil {
		return NotApplied, "", err
	}
	o, err := e.get(ctx, t)
	if err != nil {
		return NotApplied, "", err
	}
	if o.GetAnnotations()[AnnotationFluxRequest] == x.ID() {
		return Applied, "调和请求已写入", nil
	}
	return NotApplied, "调和请求注解为 " + o.GetAnnotations()[AnnotationFluxRequest], nil
}

func (e *fluxReconcile) Verify(ctx context.Context, x *Exec) ([]execution.CheckResult, error) {
	t, err := fluxTarget(x.Params)
	if err != nil {
		return nil, err
	}
	o, err := e.get(ctx, t)
	if err != nil {
		return nil, err
	}
	handled := nestedString(o.Object, "status", "lastHandledReconcileAt")
	conds, _, _ := unstructured.NestedSlice(o.Object, "status", "conditions")
	ready := ""
	for _, c := range conds {
		m, _ := c.(map[string]any)
		if m["type"] == "Ready" {
			ready, _ = m["status"].(string)
		}
	}
	return []execution.CheckResult{check("handled_ready", "k8s", handled == x.ID() && ready == "True",
		"lastHandledReconcileAt=%q，Ready=%s", handled, ready)}, nil
}

func (e *fluxReconcile) Undo(context.Context, *Exec) (string, error) { return "", ErrNoUndo }
func (e *fluxReconcile) Compensation(*Exec) *execution.Compensation  { return nil }

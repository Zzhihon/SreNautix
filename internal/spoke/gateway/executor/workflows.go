package executor

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"

	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/assertion"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/audit"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/execution"
)

var (
	workflowsGVR         = schema.GroupVersionResource{Group: "argoproj.io", Version: "v1alpha1", Resource: "workflows"}
	workflowTemplatesGVR = schema.GroupVersionResource{Group: "argoproj.io", Version: "v1alpha1", Resource: "workflowtemplates"}
)

// TemplateDigest 返回 sha256(JCS(WorkflowTemplate.spec))，与 gateway 策略 workflow_templates[].sha256 比较。
func TemplateDigest(t *unstructured.Unstructured) (string, error) {
	spec, _, err := unstructured.NestedMap(t.Object, "spec")
	if err != nil {
		return "", err
	}
	return assertion.HashValue(spec)
}

// ── workflow_submit ──────────────────────────────────────────────

type workflowSubmit struct{ d *Deps }

type submitParams struct {
	Namespace  string            `json:"namespace"`
	Template   string            `json:"template"`
	Parameters map[string]string `json:"parameters"`
}

// workflowName 是提交的 Workflow 的确定性名称：重复提交得到 AlreadyExists，不会产生第二个 Workflow。
func workflowName(template, executionID string) string {
	n := template
	if len(n) > 200 {
		n = n[:200]
	}
	return n + "-" + executionID[:16]
}

func (e *workflowSubmit) Resolve(ctx context.Context, params json.RawMessage) (*Resolved, error) {
	var p submitParams
	if err := decode(params, &p); err != nil {
		return nil, err
	}
	t, err := e.d.Kube.Dyn.Resource(workflowTemplatesGVR).Namespace(p.Namespace).Get(ctx, p.Template, metav1.GetOptions{})
	if isNotFound(err) {
		return nil, fmt.Errorf("%w: workflowtemplate %s/%s", ErrTargetNotFound, p.Namespace, p.Template)
	}
	if err != nil {
		return nil, err
	}
	digest, err := TemplateDigest(t)
	if err != nil {
		return nil, err
	}
	sa := nestedString(t.Object, "spec", "serviceAccountName")
	pol := e.d.Policy()
	entry, listed := pol.Template(p.Namespace, p.Template)
	checks := []execution.CheckResult{}
	if !listed {
		checks = append(checks, check("allowlisted", "policy", false, "模板 %s/%s 不在白名单中", p.Namespace, p.Template))
	} else {
		checks = append(checks,
			check("allowlisted", "policy", entry.SHA256 == digest && entry.ServiceAccount == sa,
				"模板内容 %s（白名单 %s），ServiceAccount %q（白名单 %q）", digest, entry.SHA256, sa, entry.ServiceAccount))
		perr := entry.CheckParameters(p.Parameters)
		checks = append(checks, check("parameters_schema", "policy", perr == nil, "%s", errString(perr)))
	}
	return &Resolved{
		Target: execution.TargetRef{Group: "argoproj.io", Version: "v1alpha1", Kind: "WorkflowTemplate", Resource: "workflowtemplates",
			Namespace: p.Namespace, Name: p.Template, UID: string(t.GetUID())},
		ResourceVersion: t.GetResourceVersion(), Domain: "workflow:" + p.Namespace + "/" + p.Template,
		Level: assertion.LevelIrreversible, BlastRadius: 1, Prechecks: checks,
		Snapshot: map[string]any{"templateDigest": digest},
	}, nil
}

func (e *workflowSubmit) Execute(ctx context.Context, x *Exec) error {
	var p submitParams
	if err := decode(x.Params, &p); err != nil {
		return err
	}
	names := make([]string, 0, len(p.Parameters))
	for k := range p.Parameters {
		names = append(names, k)
	}
	sort.Strings(names)
	var ps []any
	for _, n := range names {
		ps = append(ps, map[string]any{"name": n, "value": p.Parameters[n]})
	}
	name := workflowName(p.Template, x.ID())
	w := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "argoproj.io/v1alpha1", "kind": "Workflow",
		"metadata": map[string]any{"name": name, "namespace": p.Namespace,
			"labels":      map[string]any{execution.LabelExecutionID: x.ID()},
			"annotations": map[string]any{execution.AnnotationExecutionID: x.ID()}},
		"spec": map[string]any{"workflowTemplateRef": map[string]any{"name": p.Template}, "arguments": map[string]any{"parameters": ps}},
	}}
	_, err := e.d.Kube.Dyn.Resource(workflowsGVR).Namespace(p.Namespace).Create(ctx, w, metav1.CreateOptions{})
	if werr := x.Wrote(ctx, audit.Target{Group: "argoproj.io", Resource: "workflows", Namespace: p.Namespace, Name: name}, "create", err); werr != nil {
		return werr
	}
	if err != nil {
		return fmt.Errorf("create workflow %s/%s: %w", p.Namespace, name, err)
	}
	return nil
}

func (e *workflowSubmit) workflow(ctx context.Context, x *Exec) (*unstructured.Unstructured, error) {
	var p submitParams
	if err := decode(x.Params, &p); err != nil {
		return nil, err
	}
	return e.d.Kube.Dyn.Resource(workflowsGVR).Namespace(p.Namespace).Get(ctx, workflowName(p.Template, x.ID()), metav1.GetOptions{})
}

func (e *workflowSubmit) Observe(ctx context.Context, x *Exec) (Observation, string, error) {
	w, err := e.workflow(ctx, x)
	if apierrors.IsNotFound(err) {
		return NotApplied, "没有本次执行提交的 Workflow", nil
	}
	if err != nil {
		return NotApplied, "", err
	}
	return Applied, "Workflow " + w.GetName() + " 已提交", nil
}

func (e *workflowSubmit) Verify(ctx context.Context, x *Exec) ([]execution.CheckResult, error) {
	w, err := e.workflow(ctx, x)
	if err != nil {
		return nil, err
	}
	phase := nestedString(w.Object, "status", "phase")
	return []execution.CheckResult{check("succeeded", "k8s", phase == "Succeeded", "Workflow %s phase=%q", w.GetName(), phase)}, nil
}

func (e *workflowSubmit) Undo(context.Context, *Exec) (string, error) { return "", ErrNoUndo }
func (e *workflowSubmit) Compensation(*Exec) *execution.Compensation  { return nil }

// ── workflow_terminate ───────────────────────────────────────────

type workflowTerminate struct{ d *Deps }

type terminateParams struct {
	Namespace string `json:"namespace"`
	Workflow  string `json:"workflow"`
}

func (e *workflowTerminate) get(ctx context.Context, params json.RawMessage) (terminateParams, *unstructured.Unstructured, error) {
	var p terminateParams
	if err := decode(params, &p); err != nil {
		return p, nil, err
	}
	w, err := e.d.Kube.Dyn.Resource(workflowsGVR).Namespace(p.Namespace).Get(ctx, p.Workflow, metav1.GetOptions{})
	if isNotFound(err) {
		return p, nil, fmt.Errorf("%w: workflow %s/%s", ErrTargetNotFound, p.Namespace, p.Workflow)
	}
	return p, w, err
}

func (e *workflowTerminate) Resolve(ctx context.Context, params json.RawMessage) (*Resolved, error) {
	p, w, err := e.get(ctx, params)
	if err != nil {
		return nil, err
	}
	phase := nestedString(w.Object, "status", "phase")
	shutdown := nestedString(w.Object, "spec", "shutdown")
	return &Resolved{
		Target: execution.TargetRef{Group: "argoproj.io", Version: "v1alpha1", Kind: "Workflow", Resource: "workflows",
			Namespace: p.Namespace, Name: p.Workflow, UID: string(w.GetUID())},
		ResourceVersion: w.GetResourceVersion(), Domain: "workflow:" + p.Namespace + "/" + nestedString(w.Object, "spec", "workflowTemplateRef", "name"),
		Level: assertion.LevelIrreversible, BlastRadius: 1, Snapshot: map[string]any{},
		Prechecks: []execution.CheckResult{check("running", "k8s", (phase == "Running" || phase == "Pending" || phase == "") && shutdown == "",
			"phase=%q，spec.shutdown=%q", phase, shutdown)},
	}, nil
}

func (e *workflowTerminate) Execute(ctx context.Context, x *Exec) error {
	p, w, err := e.get(ctx, x.Params)
	if err != nil {
		return err
	}
	ops := []map[string]any{testRV(snapshotString(x.Snapshot, SnapshotResourceVersion))}
	ops = append(ops, annotationOps(w, map[string]string{execution.AnnotationExecutionID: x.ID()})...)
	ops = append(ops, map[string]any{"op": "add", "path": "/spec/shutdown", "value": "Terminate"})
	return jsonPatch(ctx, e.d, x, fieldTarget{GVR: workflowsGVR, Kind: "Workflow", Namespace: p.Namespace, Name: p.Workflow}, x.AE.Spec.Target.UID, ops)
}

func (e *workflowTerminate) Observe(ctx context.Context, x *Exec) (Observation, string, error) {
	_, w, err := e.get(ctx, x.Params)
	if err != nil {
		return NotApplied, "", err
	}
	s := nestedString(w.Object, "spec", "shutdown")
	if s == "Terminate" && w.GetAnnotations()[execution.AnnotationExecutionID] == x.ID() {
		return Applied, "spec.shutdown=Terminate", nil
	}
	return NotApplied, "spec.shutdown=" + s, nil
}

func (e *workflowTerminate) Verify(ctx context.Context, x *Exec) ([]execution.CheckResult, error) {
	_, w, err := e.get(ctx, x.Params)
	if err != nil {
		return nil, err
	}
	phase := nestedString(w.Object, "status", "phase")
	return []execution.CheckResult{check("ended", "k8s", phase == "Failed" || phase == "Error", "phase=%q", phase)}, nil
}

func (e *workflowTerminate) Undo(context.Context, *Exec) (string, error) { return "", ErrNoUndo }
func (e *workflowTerminate) Compensation(*Exec) *execution.Compensation  { return nil }

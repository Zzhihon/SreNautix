package admission_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	policyv1 "k8s.io/api/policy/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"sigs.k8s.io/yaml"

	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/admission"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/catalog"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/execution"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/policy"
	"github.com/Zzhihon/SreNautix/internal/spoke/testenv"
)

const (
	app    = "payments"
	execID = "0123456789abcdef0123456789abcdef"
	rev    = "0123456789abcdef0123456789abcdef01234567"
)

var opts = admission.Options{Username: testenv.GatewayUser, Prefix: "srenautix"}

type harness struct {
	t    *testing.T
	env  *testenv.Env
	f    *testenv.Fixtures
	core kubernetes.Interface
	dyn  dynamic.Interface
	out  *admission.Output
}

func gatewayPolicy(t *testing.T, cat *catalog.Catalog) *policy.Policy {
	doc := []byte(`
version: 1
cluster: test
approvers: []
actions:
  - id: workflow_submit
    namespaces: [` + app + `]
workflow_templates:
  - namespace: ` + app + `
    name: drain-queue
    sha256: sha256:0000000000000000000000000000000000000000000000000000000000000000
    service_account: drain
    parameters:
      queue: {enum: [orders, refunds]}
      reason: {pattern: '^[a-z ]+$', max_length: 40}
`)
	p, err := policy.Parse(doc, cat)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func setup(t *testing.T) *harness {
	env := testenv.Start(t, testenv.Options{Namespaces: []string{app}})
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	out, err := admission.Generate(cat, opts)
	if err != nil {
		t.Fatal(err)
	}
	allow, err := admission.WorkflowAllowlist(gatewayPolicy(t, cat), opts)
	if err != nil {
		t.Fatal(err)
	}
	var actions []string
	for _, a := range cat.Actions {
		actions = append(actions, a.ID)
	}
	docs, err := admission.Manifests(out, opts, testenv.Namespace, "srenautix-gateway", actions, "false", allow)
	if err != nil {
		t.Fatal(err)
	}
	for _, d := range docs {
		b, err := yaml.Marshal(d)
		if err != nil {
			t.Fatal(err)
		}
		env.Apply(t, b)
	}
	core, err := kubernetes.NewForConfig(env.Gateway())
	if err != nil {
		t.Fatal(err)
	}
	dyn, err := dynamic.NewForConfig(env.Gateway())
	if err != nil {
		t.Fatal(err)
	}
	h := &harness{t: t, env: env, f: env.Fixtures(t), core: core, dyn: dyn, out: out}
	// 等 apiserver 加载全部策略与 Binding：每个策略的自检探针都被拒绝
	for _, p := range append(out.Policies, allow) {
		h.eventuallyProbeDenied(p)
	}
	return h
}

func denied(err error, policyName string) bool {
	return err != nil && (apierrors.IsInvalid(err) || apierrors.IsForbidden(err)) &&
		strings.Contains(err.Error(), "ValidatingAdmissionPolicy '"+policyName+"'")
}

func (h *harness) expectDenied(short, what string, err error) {
	h.t.Helper()
	if !denied(err, "srenautix-gateway-"+short) {
		h.t.Fatalf("%s: want denial by %s, got %v", what, short, err)
	}
}

// expectDeniedByAny 用于同时违反多个策略的写入：apiserver 报告第一个拒绝它的策略，顺序不固定。
func (h *harness) expectDeniedByAny(shorts []string, what string, err error) {
	h.t.Helper()
	for _, s := range shorts {
		if denied(err, "srenautix-gateway-"+s) {
			return
		}
	}
	h.t.Fatalf("%s: want denial by one of %v, got %v", what, shorts, err)
}

func (h *harness) expectAllowed(what string, err error) {
	h.t.Helper()
	if err != nil {
		h.t.Fatalf("%s: %v", what, err)
	}
}

// probe 以 gateway 身份 dryRun 创建带探针标签的 ActionExecution。
func probe(dyn dynamic.Interface, short string) error {
	ae := map[string]any{
		"apiVersion": "srenautix.io/v1", "kind": "ActionExecution",
		"metadata": map[string]any{"name": execID, "namespace": testenv.Namespace, "labels": map[string]any{admission.ProbeLabel: short}},
		"spec": map[string]any{
			"executionId": execID, "ticketId": "probe", "proposalId": "00000000-0000-4000-8000-000000000000", "cluster": "probe",
			"action": "node_cordon", "level": "reversible", "tier": "L",
			"target":     map[string]any{"group": "", "version": "v1", "kind": "Node", "resource": "nodes", "name": "probe", "uid": "probe"},
			"params":     map[string]any{"node": "probe"},
			"paramsHash": "sha256:" + strings.Repeat("0", 64), "assertionHash": "sha256:" + strings.Repeat("0", 64),
			"canonVersion": "jcs-sha256-v1", "envelope": "{}",
			"approver":       map[string]any{"principal": "probe", "channel": "probe"},
			"incident":       map[string]any{"id": "probe", "version": int64(1), "rootComponent": "probe", "evidenceFingerprint": "probe"},
			"conflictDomain": "node:probe", "pulledAt": "2026-01-01T00:00:00Z", "approvalExpiresAt": "2026-01-01T00:00:00Z",
			"proposalExpiresAt": "2026-01-01T00:00:00Z",
		},
	}
	_, err := dyn.Resource(execution.GVR).Namespace(testenv.Namespace).Create(context.Background(),
		&unstructured.Unstructured{Object: ae}, metav1.CreateOptions{DryRun: []string{metav1.DryRunAll}})
	return err
}

func (h *harness) eventuallyProbeDenied(p admission.Policy) {
	h.t.Helper()
	testenv.Eventually(h.t, 30*time.Second, "probe denial by "+p.Name(), func() (bool, string) {
		err := probe(h.dyn, p.Short)
		return denied(err, p.Name()), errString(err)
	})
}

func errString(err error) string {
	if err == nil {
		return "allowed"
	}
	return err.Error()
}

var bg = context.Background()

func (h *harness) jsonPatch(gvr schema.GroupVersionResource, ns, name string, ops []map[string]any, sub ...string) error {
	b, err := json.Marshal(ops)
	if err != nil {
		h.t.Fatal(err)
	}
	var ri dynamic.ResourceInterface = h.dyn.Resource(gvr)
	if ns != "" {
		ri = h.dyn.Resource(gvr).Namespace(ns)
	}
	_, err = ri.Patch(bg, name, types.JSONPatchType, b, metav1.PatchOptions{}, sub...)
	return err
}

func (h *harness) mergePatch(gvr schema.GroupVersionResource, ns, name string, patch map[string]any, sub ...string) error {
	b, err := json.Marshal(patch)
	if err != nil {
		h.t.Fatal(err)
	}
	var ri dynamic.ResourceInterface = h.dyn.Resource(gvr)
	if ns != "" {
		ri = h.dyn.Resource(gvr).Namespace(ns)
	}
	_, err = ri.Patch(bg, name, types.MergePatchType, b, metav1.PatchOptions{}, sub...)
	return err
}

var (
	deploymentsGVR  = schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: "deployments"}
	statefulSetsGVR = schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: "statefulsets"}
	hpaGVR          = schema.GroupVersionResource{Group: "autoscaling", Version: "v2", Resource: "horizontalpodautoscalers"}
	cronJobsGVR     = schema.GroupVersionResource{Group: "batch", Version: "v1", Resource: "cronjobs"}
	nodesGVR        = schema.GroupVersionResource{Version: "v1", Resource: "nodes"}
)

func execAnnotation() map[string]any {
	return map[string]any{"annotations": map[string]any{admission.AnnotationExecutionID: execID}}
}

func TestGeneratedPolicies(t *testing.T) {
	h := setup(t)
	t.Run("pod eviction", h.testEviction)
	t.Run("deployments", h.testDeployments)
	t.Run("statefulsets", h.testStatefulSets)
	t.Run("hpa", h.testHPA)
	t.Run("cronjobs", h.testCronJobs)
	t.Run("nodes", h.testNodes)
	t.Run("cnpg switchover", h.testCNPG)
	t.Run("argocd applications", h.testApplications)
	t.Run("flux objects", h.testFlux)
	t.Run("workflows", h.testWorkflows)
	t.Run("freeze", h.testFreeze)
	t.Run("records stay writable", h.testRecords)
}

func (h *harness) testEviction(t *testing.T) {
	h.t, h.f.T = t, t
	dep := h.f.Deployment(app, "checkout", 3)
	rs := h.f.ReplicaSet(dep)
	pod := h.f.Pod(rs, "checkout-a", true)
	uid := pod.UID
	grace := int64(0)
	orphan := false
	background := metav1.DeletePropagationBackground
	evict := func(opts *metav1.DeleteOptions) error {
		return h.core.CoreV1().Pods(app).EvictV1(bg, &policyv1.Eviction{ObjectMeta: metav1.ObjectMeta{Name: pod.Name, Namespace: app}, DeleteOptions: opts})
	}
	for what, o := range map[string]*metav1.DeleteOptions{
		"no delete options":   nil,
		"no uid precondition": {},
		"zero grace period":   {Preconditions: &metav1.Preconditions{UID: &uid}, GracePeriodSeconds: &grace},
		"propagation policy":  {Preconditions: &metav1.Preconditions{UID: &uid}, PropagationPolicy: &background},
		"orphan dependents":   {Preconditions: &metav1.Preconditions{UID: &uid}, OrphanDependents: &orphan},
	} {
		h.expectDenied("pod-eviction", what, evict(o))
	}
	h.expectAllowed("eviction with uid precondition", evict(&metav1.DeleteOptions{Preconditions: &metav1.Preconditions{UID: &uid}}))
}

func (h *harness) testDeployments(t *testing.T) {
	h.t, h.f.T = t, t
	h.f.Deployment(app, "web", 2)
	h.expectAllowed("scale", h.mergePatch(deploymentsGVR, app, "web", map[string]any{"metadata": execAnnotation(), "spec": map[string]any{"replicas": 3}}))
	h.expectAllowed("pause", h.mergePatch(deploymentsGVR, app, "web", map[string]any{"spec": map[string]any{"paused": true}}))
	h.expectDenied("workload-deployments", "image change", h.jsonPatch(deploymentsGVR, app, "web", []map[string]any{
		{"op": "replace", "path": "/spec/template/spec/containers/0/image", "value": "registry.example/evil:latest"}}))
	h.expectDenied("workload-deployments", "label change", h.mergePatch(deploymentsGVR, app, "web", map[string]any{
		"metadata": map[string]any{"labels": map[string]any{"owner": "gateway"}}}))
	h.expectDenied("workload-deployments", "foreign annotation", h.mergePatch(deploymentsGVR, app, "web", map[string]any{
		"metadata": map[string]any{"annotations": map[string]any{"kubectl.kubernetes.io/restartedAt": "now"}}}))
	h.expectDenied("workload-deployments", "malformed execution id", h.mergePatch(deploymentsGVR, app, "web", map[string]any{
		"metadata": map[string]any{"annotations": map[string]any{admission.AnnotationExecutionID: "x"}}}))
	h.expectDenied("workload-deployments", "strategy change", h.mergePatch(deploymentsGVR, app, "web", map[string]any{
		"spec": map[string]any{"minReadySeconds": 30}}))
}

func (h *harness) testStatefulSets(t *testing.T) {
	h.t, h.f.T = t, t
	h.f.StatefulSet(app, "ledger", 3)
	h.expectAllowed("scale", h.mergePatch(statefulSetsGVR, app, "ledger", map[string]any{"metadata": execAnnotation(), "spec": map[string]any{"replicas": 2}}))
	h.expectDenied("workload-statefulsets", "template change", h.jsonPatch(statefulSetsGVR, app, "ledger", []map[string]any{
		{"op": "replace", "path": "/spec/template/spec/containers/0/image", "value": "registry.example/evil:latest"}}))
	h.expectDenied("workload-statefulsets", "minReadySeconds change", h.mergePatch(statefulSetsGVR, app, "ledger", map[string]any{
		"spec": map[string]any{"minReadySeconds": 30}}))
}

func (h *harness) testHPA(t *testing.T) {
	h.t, h.f.T = t, t
	h.f.Deployment(app, "api", 2)
	h.f.HPA(app, "api", "api", 2, 6)
	h.expectAllowed("bounds", h.mergePatch(hpaGVR, app, "api", map[string]any{"metadata": execAnnotation(), "spec": map[string]any{"minReplicas": 3, "maxReplicas": 10}}))
	h.expectDenied("hpa-bounds", "target change", h.mergePatch(hpaGVR, app, "api", map[string]any{
		"spec": map[string]any{"scaleTargetRef": map[string]any{"name": "other"}}}))
}

func (h *harness) testCronJobs(t *testing.T) {
	h.t, h.f.T = t, t
	h.f.CronJob(app, "report")
	h.expectAllowed("suspend", h.mergePatch(cronJobsGVR, app, "report", map[string]any{"metadata": execAnnotation(), "spec": map[string]any{"suspend": true}}))
	h.expectDenied("cronjob-suspend", "schedule change", h.mergePatch(cronJobsGVR, app, "report", map[string]any{
		"spec": map[string]any{"schedule": "* * * * *"}}))
}

func (h *harness) testNodes(t *testing.T) {
	h.t, h.f.T = t, t
	h.f.Node("worker-1", false, true)
	h.f.Node("cp-1", true, true)
	h.expectAllowed("cordon", h.mergePatch(nodesGVR, "", "worker-1", map[string]any{
		"metadata": map[string]any{"annotations": map[string]any{admission.AnnotationExecutionID: execID, admission.AnnotationCordonedBy: execID}},
		"spec":     map[string]any{"unschedulable": true}}))
	h.expectAllowed("uncordon", h.mergePatch(nodesGVR, "", "worker-1", map[string]any{
		"metadata": map[string]any{"annotations": map[string]any{admission.AnnotationCordonedBy: nil}},
		"spec":     map[string]any{"unschedulable": nil}}))
	h.expectDenied("node-scheduling", "cordon a control-plane node", h.mergePatch(nodesGVR, "", "cp-1", map[string]any{"spec": map[string]any{"unschedulable": true}}))
	h.expectDenied("node-scheduling", "label change", h.mergePatch(nodesGVR, "", "worker-1", map[string]any{
		"metadata": map[string]any{"labels": map[string]any{"node-role.kubernetes.io/control-plane": ""}}}))
	h.expectDenied("node-scheduling", "taint", h.mergePatch(nodesGVR, "", "worker-1", map[string]any{
		"spec": map[string]any{"taints": []any{map[string]any{"key": "x", "effect": "NoSchedule"}}}}))
	h.expectDenied("node-scheduling", "cordoned-by is not an execution id", h.mergePatch(nodesGVR, "", "worker-1", map[string]any{
		"metadata": map[string]any{"annotations": map[string]any{admission.AnnotationCordonedBy: "someone"}}}))
}

func (h *harness) testCNPG(t *testing.T) {
	h.t, h.f.T = t, t
	cl := h.f.CNPGCluster(app, "pg", "pg-1", []string{"pg-1", "pg-2", "pg-3"})
	h.expectDenied("cnpg-switchover", "target outside instances", h.mergePatch(testenv.ClusterGVR, app, "pg", map[string]any{
		"metadata": map[string]any{"resourceVersion": cl.GetResourceVersion()},
		"status":   map[string]any{"targetPrimary": "pg-9"}}, "status"))
	h.expectDenied("cnpg-switchover", "current primary rewrite", h.mergePatch(testenv.ClusterGVR, app, "pg", map[string]any{
		"status": map[string]any{"targetPrimary": "pg-2", "currentPrimary": "pg-2"}}, "status"))
	h.expectAllowed("promote", h.mergePatch(testenv.ClusterGVR, app, "pg", map[string]any{
		"status": map[string]any{"targetPrimary": "pg-2", "targetPrimaryTimestamp": time.Now().UTC().Format(metav1.RFC3339Micro),
			"phase": "Switchover in progress", "phaseReason": "Switching over to pg-2"}}, "status"))
}

func (h *harness) testApplications(t *testing.T) {
	h.t, h.f.T = t, t
	a := h.f.Application(app, "payments-app", rev, false, false)
	sync := func(op map[string]any) error {
		return h.jsonPatch(testenv.ApplicationGVR, app, a.GetName(), []map[string]any{{"op": "add", "path": "/operation", "value": op}})
	}
	op := func(mut func(s map[string]any)) map[string]any {
		s := map[string]any{"revision": rev, "prune": false}
		mut(s)
		return map[string]any{"initiatedBy": map[string]any{"username": "srenautix-gateway"}, "sync": s}
	}
	for what, o := range map[string]map[string]any{
		"sync to a branch":         op(func(s map[string]any) { s["revision"] = "main" }),
		"sync to a short SHA":      op(func(s map[string]any) { s["revision"] = rev[:12] }),
		"sync to an uppercase SHA": op(func(s map[string]any) { s["revision"] = strings.ToUpper(rev) }),
		"sync with revisions":      op(func(s map[string]any) { s["revisions"] = []any{rev} }),
		"sync with prune":          op(func(s map[string]any) { s["prune"] = true }),
		"sync with force":          op(func(s map[string]any) { s["syncStrategy"] = map[string]any{"apply": map[string]any{"force": true}} }),
		"sync with sync options":   op(func(s map[string]any) { s["syncOptions"] = []any{"Replace=true"} }),
		"sync without revision":    op(func(s map[string]any) { delete(s, "revision") }),
	} {
		h.expectDenied("argocd-applications", what, sync(o))
	}
	h.expectDenied("argocd-applications", "spec change", h.mergePatch(testenv.ApplicationGVR, app, a.GetName(), map[string]any{
		"spec": map[string]any{"source": map[string]any{"path": "apps/other"}}}))
	h.expectAllowed("pinned sync", sync(op(func(map[string]any) {})))
	running := h.f.Application(app, "running-app", rev, false, true)
	h.expectAllowed("terminate", h.jsonPatch(testenv.ApplicationGVR, app, running.GetName(), []map[string]any{
		{"op": "test", "path": "/status/operationState/phase", "value": "Running"},
		{"op": "replace", "path": "/status/operationState/phase", "value": "Terminating"}}))
	auto := h.f.Application(app, "auto-app", rev, true, false)
	h.expectAllowed("suspend autosync", h.mergePatch(testenv.ApplicationGVR, app, auto.GetName(), map[string]any{
		"metadata": execAnnotation(), "spec": map[string]any{"syncPolicy": map[string]any{"automated": map[string]any{"enabled": false}}}}))
	h.expectDenied("argocd-applications", "autosync prune toggled with enabled", h.mergePatch(testenv.ApplicationGVR, app, auto.GetName(), map[string]any{
		"spec": map[string]any{"syncPolicy": map[string]any{"automated": map[string]any{"enabled": true, "prune": true}}}}))
}

func (h *harness) testFlux(t *testing.T) {
	h.t, h.f.T = t, t
	h.f.Kustomization(app, "apps")
	h.f.HelmRelease(app, "redis")
	h.expectAllowed("suspend kustomization", h.mergePatch(testenv.KustomizationGVR, app, "apps", map[string]any{"metadata": execAnnotation(), "spec": map[string]any{"suspend": true}}))
	h.expectAllowed("suspend helmrelease", h.mergePatch(testenv.HelmReleaseGVR, app, "redis", map[string]any{"spec": map[string]any{"suspend": true}}))
	h.expectAllowed("reconcile request", h.mergePatch(testenv.KustomizationGVR, app, "apps", map[string]any{
		"metadata": map[string]any{"annotations": map[string]any{admission.AnnotationFluxRequest: "2026-10-20T08:00:00Z"}}}))
	h.expectDenied("flux-objects", "path change", h.mergePatch(testenv.KustomizationGVR, app, "apps", map[string]any{"spec": map[string]any{"path": "./other"}}))
	h.expectDenied("flux-objects", "values change", h.mergePatch(testenv.HelmReleaseGVR, app, "redis", map[string]any{"spec": map[string]any{"values": map[string]any{"x": 1}}}))
}

func workflow(template string, params map[string]string, mut func(map[string]any)) *unstructured.Unstructured {
	var ps []any
	for k, v := range params {
		ps = append(ps, map[string]any{"name": k, "value": v})
	}
	obj := map[string]any{
		"apiVersion": "argoproj.io/v1alpha1", "kind": "Workflow",
		"metadata": map[string]any{"generateName": template + "-", "namespace": app,
			"labels": map[string]any{execution.LabelExecutionID: execID}},
		"spec": map[string]any{"workflowTemplateRef": map[string]any{"name": template}, "arguments": map[string]any{"parameters": ps}},
	}
	if mut != nil {
		mut(obj)
	}
	return &unstructured.Unstructured{Object: obj}
}

func (h *harness) testWorkflows(t *testing.T) {
	h.t, h.f.T = t, t
	create := func(w *unstructured.Unstructured) (*unstructured.Unstructured, error) {
		return h.dyn.Resource(testenv.WorkflowGVR).Namespace(app).Create(bg, w, metav1.CreateOptions{})
	}
	good := map[string]string{"queue": "orders", "reason": "drain stuck jobs"}
	created, err := create(workflow("drain-queue", good, nil))
	h.expectAllowed("allowlisted template", err)
	for what, w := range map[string]*unstructured.Unstructured{
		"inline templates": workflow("drain-queue", good, func(o map[string]any) {
			o["spec"].(map[string]any)["templates"] = []any{map[string]any{"name": "x"}}
		}),
		"service account override": workflow("drain-queue", good, func(o map[string]any) {
			o["spec"].(map[string]any)["serviceAccountName"] = "admin"
		}),
		"cluster-scoped template": workflow("drain-queue", good, func(o map[string]any) {
			o["spec"].(map[string]any)["workflowTemplateRef"] = map[string]any{"name": "drain-queue", "clusterScope": true}
		}),
		"missing execution label": workflow("drain-queue", good, func(o map[string]any) {
			delete(o["metadata"].(map[string]any), "labels")
		}),
		"parameter from a ConfigMap": workflow("drain-queue", nil, func(o map[string]any) {
			o["spec"].(map[string]any)["arguments"] = map[string]any{"parameters": []any{
				map[string]any{"name": "queue", "valueFrom": map[string]any{"configMapKeyRef": map[string]any{"name": "x", "key": "y"}}},
				map[string]any{"name": "reason", "value": "x"}}}
		}),
		"artifacts": workflow("drain-queue", good, func(o map[string]any) {
			o["spec"].(map[string]any)["arguments"].(map[string]any)["artifacts"] = []any{map[string]any{"name": "a", "raw": map[string]any{"data": "x"}}}
		}),
	} {
		_, err := create(w)
		if what == "parameter from a ConfigMap" {
			// 没有 value 的参数同时违反白名单策略
			h.expectDeniedByAny([]string{"argo-workflows", admission.WorkflowAllowlistShort}, what, err)
			continue
		}
		h.expectDenied("argo-workflows", what, err)
	}
	for what, w := range map[string]*unstructured.Unstructured{
		"unknown template":     workflow("deploy-prod", good, nil),
		"value outside enum":   workflow("drain-queue", map[string]string{"queue": "payments", "reason": "x"}, nil),
		"value breaks pattern": workflow("drain-queue", map[string]string{"queue": "orders", "reason": "x; rm -rf /"}, nil),
		"value too long":       workflow("drain-queue", map[string]string{"queue": "orders", "reason": strings.Repeat("a", 41)}, nil),
		"extra parameter":      workflow("drain-queue", map[string]string{"queue": "orders", "reason": "x", "image": "evil"}, nil),
		"missing parameter":    workflow("drain-queue", map[string]string{"queue": "orders"}, nil),
		"duplicate parameter": workflow("drain-queue", nil, func(o map[string]any) {
			o["spec"].(map[string]any)["arguments"] = map[string]any{"parameters": []any{
				map[string]any{"name": "queue", "value": "orders"}, map[string]any{"name": "queue", "value": "refunds"}}}
		}),
	} {
		_, err := create(w)
		h.expectDenied(admission.WorkflowAllowlistShort, what, err)
	}
	h.expectAllowed("terminate", h.mergePatch(testenv.WorkflowGVR, app, created.GetName(), map[string]any{
		"metadata": execAnnotation(), "spec": map[string]any{"shutdown": "Terminate"}}))
	h.expectDenied("argo-workflows", "stop instead of terminate", h.mergePatch(testenv.WorkflowGVR, app, created.GetName(), map[string]any{
		"spec": map[string]any{"shutdown": "Stop"}}))
	h.expectDenied("argo-workflows", "argument rewrite", h.mergePatch(testenv.WorkflowGVR, app, created.GetName(), map[string]any{
		"spec": map[string]any{"shutdown": "Terminate", "arguments": map[string]any{"parameters": []any{map[string]any{"name": "queue", "value": "refunds"}}}}}))
}

func (h *harness) setFrozen(value *string) {
	h.t.Helper()
	cms := h.env.Core.CoreV1().ConfigMaps(testenv.Namespace)
	if value == nil {
		if err := cms.Delete(bg, "srenautix-freeze", metav1.DeleteOptions{}); err != nil {
			h.t.Fatal(err)
		}
		return
	}
	cm, err := cms.Get(bg, "srenautix-freeze", metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		cm.Name, cm.Namespace = "srenautix-freeze", testenv.Namespace
		cm.Data = map[string]string{"frozen": *value}
		_, err = cms.Create(bg, cm, metav1.CreateOptions{})
	} else if err == nil {
		cm.Data = map[string]string{"frozen": *value}
		_, err = cms.Update(bg, cm, metav1.UpdateOptions{})
	}
	if err != nil {
		h.t.Fatal(err)
	}
}

func (h *harness) testFreeze(t *testing.T) {
	h.t, h.f.T = t, t
	h.f.Deployment(app, "frozen-web", 2)
	scale := func(n int) error {
		return h.mergePatch(deploymentsGVR, app, "frozen-web", map[string]any{"spec": map[string]any{"replicas": n}})
	}
	frozen, active := "true", "false"
	h.setFrozen(&frozen)
	testenv.Eventually(t, 30*time.Second, "freeze denial", func() (bool, string) {
		err := scale(3)
		return denied(err, "srenautix-gateway-workload-deployments"), errString(err)
	})
	h.setFrozen(nil)
	testenv.Eventually(t, 30*time.Second, "denial without srenautix-freeze", func() (bool, string) {
		err := scale(3)
		return err != nil && apierrors.IsForbidden(err) || apierrors.IsInvalid(err), errString(err)
	})
	h.setFrozen(&active)
	testenv.Eventually(t, 30*time.Second, "unfrozen write", func() (bool, string) {
		err := scale(3)
		return err == nil, errString(err)
	})
}

func (h *harness) testRecords(t *testing.T) {
	h.t, h.f.T = t, t
	frozen := "true"
	h.setFrozen(&frozen)
	// 冻结时 gateway 仍可写入自己的 ActionExecution；探针仍被拒绝
	for _, p := range h.out.Policies {
		if err := probe(h.dyn, p.Short); !denied(err, p.Name()) {
			t.Fatalf("probe %s while frozen: %v", p.Short, err)
		}
	}
	if err := probe(h.dyn, "none"); err != nil {
		t.Fatalf("a regular ActionExecution is denied while frozen: %v", err)
	}
}

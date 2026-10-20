package engine_test

import (
	"context"
	"strings"
	"testing"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/utils/ptr"

	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/assertion"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/catalog"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/execution"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/executor"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/gwtest"
	"github.com/Zzhihon/SreNautix/internal/spoke/testenv"
	"github.com/Zzhihon/SreNautix/internal/spoke/tunnel"
)

const ns = gwtest.AppNS

func ref(t testing.TB, e *gwtest.Env, gvr schema.GroupVersionResource, kind, name string) tunnel.TargetRef {
	t.Helper()
	ri := e.Kube.Dyn.Resource(gvr)
	var obj *unstructured.Unstructured
	var err error
	if gvr.Resource == "nodes" {
		obj, err = ri.Get(bg, name, metav1.GetOptions{})
	} else {
		obj, err = ri.Namespace(ns).Get(bg, name, metav1.GetOptions{})
	}
	if err != nil {
		t.Fatal(err)
	}
	r := tunnel.TargetRef{Group: gvr.Group, Version: gvr.Version, Kind: kind, Name: name, UID: string(obj.GetUID())}
	if gvr.Resource != "nodes" {
		r.Namespace = ns
	}
	return r
}

var (
	deploymentsGVR = schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: "deployments"}
	hpaGVR         = schema.GroupVersionResource{Group: "autoscaling", Version: "v2", Resource: "horizontalpodautoscalers"}
	cronJobsGVR    = schema.GroupVersionResource{Group: "batch", Version: "v1", Resource: "cronjobs"}
	nodesGVR       = schema.GroupVersionResource{Version: "v1", Resource: "nodes"}
	podsGVR        = schema.GroupVersionResource{Version: "v1", Resource: "pods"}
)

// step 签发一张工单，等它进入校验，调用 control（扮演控制器写入 status），推进时钟越过校验时间窗，等它进入 final。
func step(t *testing.T, e *gwtest.Env, action string, params map[string]any, target tunnel.TargetRef, level, tier string,
	control func(id string), final string) *execution.ActionExecution {
	t.Helper()
	e.T, e.F.T = t, t
	tk := e.Ticket(e.Request(action, params, target, level, tier))
	id := e.Offer(tk)
	e.WaitPhase(tk.Proposal.ProposalID, execution.PhaseVerifying, 60*time.Second)
	if control != nil {
		control(id)
	}
	act, _ := e.Catalog.Get(action)
	e.Advance(act.VerifyWindow() + time.Second)
	e.WaitPhase(tk.Proposal.ProposalID, final, 60*time.Second)
	return e.Execution(id)
}

// setStatus 按控制器的方式写入没有 status 子资源的对象（Argo 的最小 CRD）。
func setStatus(t testing.TB, e *gwtest.Env, gvr schema.GroupVersionResource, name string, mutate func(map[string]any)) {
	t.Helper()
	o, err := e.Kube.Dyn.Resource(gvr).Namespace(ns).Get(bg, name, metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	st, _, _ := unstructured.NestedMap(o.Object, "status")
	if st == nil {
		st = map[string]any{}
	}
	mutate(st)
	o.Object["status"] = st
	if _, err := e.Kube.Dyn.Resource(gvr).Namespace(ns).Update(bg, o, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
}

func allActions(t testing.TB) []string {
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, a := range cat.Actions {
		if a.ID != "gitops_pr" {
			out = append(out, a.ID)
		}
	}
	return out
}

func TestExecutors(t *testing.T) {
	actions := allActions(t)
	e := gwtest.New(t, actions)
	tpl := e.F.WorkflowTemplate(ns, "drain-queue", "drain", []string{"queue"})
	digest, err := executor.TemplateDigest(tpl)
	if err != nil {
		t.Fatal(err)
	}
	e.WritePolicy(gwtest.DefaultPolicy(actions) + "workflow_templates:\n  - namespace: " + ns + "\n    name: drain-queue\n    sha256: " + digest +
		"\n    service_account: drain\n    parameters:\n      queue: {enum: [orders, refunds]}\n")
	e.InstallWorkflowAllowlist()
	e.Start(gwtest.Options{})
	L, H := assertion.TierL, assertion.TierH
	rev := assertion.LevelReversible
	irr := assertion.LevelIrreversible

	t.Run("hpa_bounds_set", func(t *testing.T) {
		e.F.T = t
		e.F.Deployment(ns, "api", 2)
		e.F.HPA(ns, "api", "api", 2, 6)
		step(t, e, "hpa_bounds_set", map[string]any{"namespace": ns, "name": "api", "min_replicas": 3, "max_replicas": 8},
			ref(t, e, hpaGVR, "HorizontalPodAutoscaler", "api"), rev, L, nil, execution.PhaseVerified)
		h, err := e.Kube.Core.AutoscalingV2().HorizontalPodAutoscalers(ns).Get(bg, "api", metav1.GetOptions{})
		if err != nil || *h.Spec.MinReplicas != 3 || h.Spec.MaxReplicas != 8 {
			t.Fatalf("hpa %v %v", h.Spec, err)
		}
	})

	t.Run("rollout_pause and rollout_resume", func(t *testing.T) {
		e.F.T = t
		e.F.Deployment(ns, "web", 2)
		p := map[string]any{"namespace": ns, "name": "web"}
		step(t, e, "rollout_pause", p, ref(t, e, deploymentsGVR, "Deployment", "web"), rev, L, nil, execution.PhaseVerified)
		step(t, e, "rollout_resume", p, ref(t, e, deploymentsGVR, "Deployment", "web"), rev, L, nil, execution.PhaseVerified)
		d, _ := e.Kube.Core.AppsV1().Deployments(ns).Get(bg, "web", metav1.GetOptions{})
		if d.Spec.Paused {
			t.Fatal("deployment is still paused")
		}
	})

	t.Run("cronjob_suspend and cronjob_resume", func(t *testing.T) {
		e.F.T = t
		e.F.CronJob(ns, "report")
		p := map[string]any{"namespace": ns, "name": "report"}
		step(t, e, "cronjob_suspend", p, ref(t, e, cronJobsGVR, "CronJob", "report"), rev, L, nil, execution.PhaseVerified)
		step(t, e, "cronjob_resume", p, ref(t, e, cronJobsGVR, "CronJob", "report"), rev, L, nil, execution.PhaseVerified)
		c, _ := e.Kube.Core.BatchV1().CronJobs(ns).Get(bg, "report", metav1.GetOptions{})
		if c.Spec.Suspend == nil || *c.Spec.Suspend {
			t.Fatalf("suspend %v", c.Spec.Suspend)
		}
	})

	t.Run("node_uncordon only releases its own cordon", func(t *testing.T) {
		e.F.T = t
		e.F.Node("spare-a", false, true)
		mine := e.F.Node("cordoned-mine", false, true)
		mine.Spec.Unschedulable = true
		mine.Annotations = map[string]string{executor.AnnotationCordonedBy: strings.Repeat("a", 32)}
		if _, err := e.Kube.Core.CoreV1().Nodes().Update(bg, mine, metav1.UpdateOptions{}); err != nil {
			t.Fatal(err)
		}
		step(t, e, "node_uncordon", map[string]any{"node": "cordoned-mine"}, ref(t, e, nodesGVR, "Node", "cordoned-mine"), rev, L, nil, execution.PhaseVerified)
		other := e.F.Node("cordoned-other", false, true)
		other.Spec.Unschedulable = true
		if _, err := e.Kube.Core.CoreV1().Nodes().Update(bg, other, metav1.UpdateOptions{}); err != nil {
			t.Fatal(err)
		}
		tk := e.Ticket(e.Request("node_uncordon", map[string]any{"node": "cordoned-other"}, ref(t, e, nodesGVR, "Node", "cordoned-other"), rev, L))
		e.Offer(tk)
		e.WaitPhase(tk.Proposal.ProposalID, execution.PhaseRejected, 60*time.Second)
		if _, reason, _ := e.Hub.PhaseOf(tk.Proposal.ProposalID); reason != "precheck_failed" {
			t.Fatalf("reason %s", reason)
		}
	})

	t.Run("workload_rolling_restart", func(t *testing.T) {
		e.F.T = t
		d := e.F.Deployment(ns, "batch", 2)
		rs := e.F.ReplicaSet(d)
		e.F.Pod(rs, "batch-a", true)
		e.F.Pod(rs, "batch-b", true)
		ctx, stop := context.WithCancel(context.Background())
		defer stop()
		go func() { // 扮演 ReplicaSet 控制器：Pod 少于期望时补一个就绪的
			n := 0
			for ctx.Err() == nil {
				pods, err := e.Kube.Core.CoreV1().Pods(ns).List(bg, metav1.ListOptions{LabelSelector: "app=batch"})
				if err == nil && len(pods.Items) < 2 {
					n++
					e.F.Pod(rs, "batch-r"+strings.Repeat("x", n), true)
				}
				time.Sleep(100 * time.Millisecond)
			}
		}()
		x := step(t, e, "workload_rolling_restart", map[string]any{"namespace": ns, "kind": "Deployment", "name": "batch"},
			ref(t, e, deploymentsGVR, "Deployment", "batch"), irr, L, nil, execution.PhaseVerified)
		if len(x.Status.Progress) != 2 {
			t.Fatalf("progress %v", x.Status.Progress)
		}
	})

	t.Run("cnpg_replica_restart", func(t *testing.T) {
		e.F.T = t
		e.F.CNPGCluster(ns, "pg", "pg-1", []string{"pg-1", "pg-2", "pg-3"})
		cl, _ := e.Kube.Dyn.Resource(testenv.ClusterGVR).Namespace(ns).Get(bg, "pg", metav1.GetOptions{})
		step(t, e, "cnpg_replica_restart", map[string]any{"namespace": ns, "cluster": "pg", "instance": "pg-3"},
			ref(t, e, podsGVR, "Pod", "pg-3"), irr, H, func(string) {
				// 扮演 CNPG：以同名重建实例 Pod
				owner := metav1.OwnerReference{APIVersion: "postgresql.cnpg.io/v1", Kind: "Cluster", Name: "pg", UID: cl.GetUID(), Controller: ptr.To(true)}
				e.F.OwnedPod(ns, "pg-3", map[string]string{"cnpg.io/cluster": "pg", "cnpg.io/instanceRole": "replica"}, &owner, true)
			}, execution.PhaseVerified)
	})

	t.Run("cnpg_switchover verified and compensation", func(t *testing.T) {
		e.F.T = t
		p := map[string]any{"namespace": ns, "cluster": "pg", "target_instance": "pg-2"}
		x := step(t, e, "cnpg_switchover", p, ref(t, e, testenv.ClusterGVR, "Cluster", "pg"), assertion.LevelCompensable, H, nil,
			execution.PhaseAwaitingCompensationApproval)
		if x.Status.Compensation == nil || x.Status.Compensation.Action != "cnpg_switchover" || !strings.Contains(string(x.Status.Compensation.Params.Raw), `"pg-1"`) {
			t.Fatalf("compensation %+v", x.Status.Compensation)
		}
		// 扮演 CNPG 完成切换后，再次切换回 pg-1 并通过校验
		e.F.SetStatus(testenv.ClusterGVR, ns, "pg", map[string]any{"instanceNames": []any{"pg-1", "pg-2", "pg-3"}, "currentPrimary": "pg-2",
			"targetPrimary": "pg-2", "phase": "Cluster in healthy state"})
		relabel := func(pod, role string) {
			pp, _ := e.Kube.Core.CoreV1().Pods(ns).Get(bg, pod, metav1.GetOptions{})
			pp.Labels["cnpg.io/instanceRole"] = role
			if _, err := e.Kube.Core.CoreV1().Pods(ns).Update(bg, pp, metav1.UpdateOptions{}); err != nil {
				t.Fatal(err)
			}
		}
		relabel("pg-2", "primary")
		relabel("pg-1", "replica")
		back := map[string]any{"namespace": ns, "cluster": "pg", "target_instance": "pg-1"}
		step(t, e, "cnpg_switchover", back, ref(t, e, testenv.ClusterGVR, "Cluster", "pg"), assertion.LevelCompensable, H, func(string) {
			e.F.SetStatus(testenv.ClusterGVR, ns, "pg", map[string]any{"instanceNames": []any{"pg-1", "pg-2", "pg-3"}, "currentPrimary": "pg-1",
				"targetPrimary": "pg-1", "phase": "Cluster in healthy state"})
			relabel("pg-1", "primary")
			relabel("pg-2", "replica")
		}, execution.PhaseVerified)
	})

	t.Run("argocd sync, terminate and autosync", func(t *testing.T) {
		e.F.T = t
		const rev40 = "0123456789abcdef0123456789abcdef01234567"
		e.F.Application(ns, "shop", rev40, false, false)
		step(t, e, "argocd_app_sync", map[string]any{"namespace": ns, "application": "shop", "revision": rev40},
			ref(t, e, testenv.ApplicationGVR, "Application", "shop"), irr, H, func(string) {
				setStatus(t, e, testenv.ApplicationGVR, "shop", func(s map[string]any) {
					s["sync"] = map[string]any{"status": "Synced", "revision": rev40}
					s["health"] = map[string]any{"status": "Healthy"}
					s["operationState"] = map[string]any{"phase": "Succeeded", "startedAt": time.Now().UTC().Format(time.RFC3339),
						"operation":  map[string]any{"sync": map[string]any{"revision": rev40}},
						"syncResult": map[string]any{"revision": rev40}}
				})
			}, execution.PhaseVerified)
		e.F.Application(ns, "stuck", rev40, false, true)
		step(t, e, "argocd_app_terminate_operation", map[string]any{"namespace": ns, "application": "stuck"},
			ref(t, e, testenv.ApplicationGVR, "Application", "stuck"), irr, L, func(string) {
				setStatus(t, e, testenv.ApplicationGVR, "stuck", func(s map[string]any) {
					s["operationState"].(map[string]any)["phase"] = "Failed"
				})
			}, execution.PhaseVerified)
		e.F.Application(ns, "auto", rev40, true, false)
		ap := map[string]any{"namespace": ns, "application": "auto"}
		step(t, e, "argocd_autosync_suspend", ap, ref(t, e, testenv.ApplicationGVR, "Application", "auto"), rev, L, nil, execution.PhaseVerified)
		step(t, e, "argocd_autosync_resume", ap, ref(t, e, testenv.ApplicationGVR, "Application", "auto"), rev, L, nil, execution.PhaseVerified)
	})

	t.Run("flux suspend, resume and reconcile", func(t *testing.T) {
		e.F.T = t
		e.F.Kustomization(ns, "apps")
		p := map[string]any{"namespace": ns, "kind": "Kustomization", "name": "apps"}
		step(t, e, "flux_suspend", p, ref(t, e, testenv.KustomizationGVR, "Kustomization", "apps"), rev, L, nil, execution.PhaseVerified)
		step(t, e, "flux_resume", p, ref(t, e, testenv.KustomizationGVR, "Kustomization", "apps"), rev, L, nil, execution.PhaseVerified)
		step(t, e, "flux_reconcile", p, ref(t, e, testenv.KustomizationGVR, "Kustomization", "apps"), irr, L, func(id string) {
			e.F.SetStatus(testenv.KustomizationGVR, ns, "apps", map[string]any{"lastHandledReconcileAt": id,
				"conditions": []any{map[string]any{"type": "Ready", "status": "True", "reason": "ReconciliationSucceeded", "message": "",
					"lastTransitionTime": time.Now().UTC().Format(time.RFC3339)}}})
		}, execution.PhaseVerified)
	})

	t.Run("workflow_submit and workflow_terminate", func(t *testing.T) {
		e.F.T = t
		tplRef := ref(t, e, testenv.TemplateGVR, "WorkflowTemplate", "drain-queue")
		var wf string
		step(t, e, "workflow_submit", map[string]any{"namespace": ns, "template": "drain-queue", "parameters": map[string]any{"queue": "orders"}},
			tplRef, irr, H, func(id string) {
				list, err := e.Kube.Dyn.Resource(testenv.WorkflowGVR).Namespace(ns).List(bg, metav1.ListOptions{LabelSelector: execution.LabelExecutionID + "=" + id})
				if err != nil || len(list.Items) != 1 {
					t.Fatalf("submitted workflows: %v %v", len(list.Items), err)
				}
				wf = list.Items[0].GetName()
				setStatus(t, e, testenv.WorkflowGVR, wf, func(s map[string]any) { s["phase"] = "Succeeded" })
			}, execution.PhaseVerified)
		// 不在白名单中的取值：预检拒绝，没有 Workflow 被创建
		tk := e.Ticket(e.Request("workflow_submit", map[string]any{"namespace": ns, "template": "drain-queue", "parameters": map[string]any{"queue": "payments"}},
			tplRef, irr, H))
		e.Offer(tk)
		e.WaitPhase(tk.Proposal.ProposalID, execution.PhaseRejected, 60*time.Second)

		running := &unstructured.Unstructured{Object: map[string]any{"apiVersion": "argoproj.io/v1alpha1", "kind": "Workflow",
			"metadata": map[string]any{"name": "long-run", "namespace": ns},
			"spec":     map[string]any{"workflowTemplateRef": map[string]any{"name": "drain-queue"}},
			"status":   map[string]any{"phase": "Running"}}}
		if _, err := e.Kube.Dyn.Resource(testenv.WorkflowGVR).Namespace(ns).Create(bg, running, metav1.CreateOptions{}); err != nil {
			t.Fatal(err)
		}
		step(t, e, "workflow_terminate", map[string]any{"namespace": ns, "workflow": "long-run"},
			ref(t, e, testenv.WorkflowGVR, "Workflow", "long-run"), irr, H, func(string) {
				setStatus(t, e, testenv.WorkflowGVR, "long-run", func(s map[string]any) { s["phase"] = "Failed" })
			}, execution.PhaseVerified)
	})

	t.Run("pod_restart verify failure goes to needs_human", func(t *testing.T) {
		e.F.T = t
		d := e.F.Deployment(ns, "lonely", 3)
		rs := e.F.ReplicaSet(d)
		p := e.F.Pod(rs, "lonely-a", true)
		e.F.Pod(rs, "lonely-b", true)
		e.F.Pod(rs, "lonely-c", true)
		x := step(t, e, "pod_restart", map[string]any{"namespace": ns, "pod": "lonely-a"},
			tunnel.TargetRef{Version: "v1", Kind: "Pod", Namespace: ns, Name: p.Name, UID: string(p.UID)},
			assertion.LevelReversibleRecreatable, L, nil, execution.PhaseNeedsHuman)
		if x.Status.Verification == nil || x.Status.Verification.Passed {
			t.Fatalf("verification %+v", x.Status.Verification)
		}
	})
}

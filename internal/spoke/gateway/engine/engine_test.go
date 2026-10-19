package engine_test

import (
	"context"
	"crypto/ed25519"
	"testing"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/assertion"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/audit"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/execution"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/executor"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/gwtest"
	"github.com/Zzhihon/SreNautix/internal/spoke/testenv"
	"github.com/Zzhihon/SreNautix/internal/spoke/tunnel"
)

var bg = context.Background()

func nodeRef(e *gwtest.Env, name string) tunnel.TargetRef {
	n, err := e.Kube.Core.CoreV1().Nodes().Get(bg, name, metav1.GetOptions{})
	if err != nil {
		e.T.Fatal(err)
	}
	return tunnel.TargetRef{Version: "v1", Kind: "Node", Name: name, UID: string(n.UID)}
}

func deployRef(e *gwtest.Env, ns, name string) tunnel.TargetRef {
	d, err := e.Kube.Core.AppsV1().Deployments(ns).Get(bg, name, metav1.GetOptions{})
	if err != nil {
		e.T.Fatal(err)
	}
	return tunnel.TargetRef{Group: "apps", Version: "v1", Kind: "Deployment", Namespace: ns, Name: name, UID: string(d.UID)}
}

func TestEngine(t *testing.T) {
	e := gwtest.New(t, gwtest.DefaultActions)
	e.F.Node("worker-1", false, true)
	e.F.Node("worker-2", false, true)
	g := e.Start(gwtest.Options{})

	t.Run("cordon is verified and audited", func(t *testing.T) {
		e.T, e.F.T = t, t
		tk := e.Ticket(e.Request("node_cordon", map[string]any{"node": "worker-1"}, nodeRef(e, "worker-1"), assertion.LevelReversible, assertion.TierL))
		id := e.Offer(tk)
		e.WaitPhase(tk.Proposal.ProposalID, execution.PhaseVerifying, 30*time.Second)
		n, err := e.Kube.Core.CoreV1().Nodes().Get(bg, "worker-1", metav1.GetOptions{})
		if err != nil {
			t.Fatal(err)
		}
		if !n.Spec.Unschedulable || n.Annotations[execution.AnnotationExecutionID] != id || n.Annotations[executor.AnnotationCordonedBy] != id {
			t.Fatalf("node after cordon: unschedulable=%v annotations=%v", n.Spec.Unschedulable, n.Annotations)
		}
		e.Advance(61 * time.Second)
		e.WaitPhase(tk.Proposal.ProposalID, execution.PhaseVerified, 30*time.Second)
		want := []string{"pulled", "prechecked", "executing", "verifying", "verified"}
		if got := e.Hub.Phases(id); !equal(got, want) {
			t.Fatalf("phases %v, want %v", got, want)
		}
		for _, ev := range e.Hub.Events(id) {
			if ev.EventID != assertion.EventID(id, ev.Seq) || ev.Audit == nil {
				t.Fatalf("event %+v", ev)
			}
		}
		// 重复下发同一工单不会产生第二次执行
		e.Hub.Redeliver(tk.TicketID)
		time.Sleep(3 * time.Second)
		if got := e.Hub.Phases(id); !equal(got, want) {
			t.Fatalf("phases after redelivery %v", got)
		}
		testenv.Eventually(t, 30*time.Second, "audit sink holds the execution", func() (bool, string) {
			recs := e.ReadSinkRecords(g.Audit)
			if err := audit.Verify(recs, e.SigningKey.Public().(ed25519.PublicKey)); err != nil {
				return false, err.Error()
			}
			writes := 0
			for _, r := range recs {
				if r.ExecutionID == id && r.Type == audit.TypeWrite {
					writes++
				}
			}
			return writes == 1, "writes in sink"
		})
	})

	t.Run("failed verification restores the replica count", func(t *testing.T) {
		e.T, e.F.T = t, t
		e.F.Deployment(gwtest.AppNS, "checkout", 2)
		params := map[string]any{"namespace": gwtest.AppNS, "kind": "Deployment", "name": "checkout", "replicas": 3,
			"verify": []any{map[string]any{"id": "never", "query": "vector(1)", "op": "lt", "threshold": 0}}}
		tk := e.Ticket(e.Request("workload_scale", params, deployRef(e, gwtest.AppNS, "checkout"), assertion.LevelReversible, assertion.TierL))
		id := e.Offer(tk)
		e.WaitPhase(tk.Proposal.ProposalID, execution.PhaseVerifying, 30*time.Second)
		d, err := e.Kube.Core.AppsV1().Deployments(gwtest.AppNS).Get(bg, "checkout", metav1.GetOptions{})
		if err != nil || *d.Spec.Replicas != 3 {
			t.Fatalf("replicas after scale: %v %v", d.Spec.Replicas, err)
		}
		e.F.SetDeploymentStatus(d, 3, 3)
		e.Advance(301 * time.Second)
		e.WaitPhase(tk.Proposal.ProposalID, execution.PhaseReverted, 30*time.Second)
		d, err = e.Kube.Core.AppsV1().Deployments(gwtest.AppNS).Get(bg, "checkout", metav1.GetOptions{})
		if err != nil || *d.Spec.Replicas != 2 {
			t.Fatalf("replicas after revert: %v %v", d.Spec.Replicas, err)
		}
		x := e.Execution(id)
		if x.Status.Verification == nil || x.Status.Verification.Passed {
			t.Fatalf("verification %+v", x.Status.Verification)
		}
	})
}

func equal(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

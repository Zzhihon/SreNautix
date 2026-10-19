package invariants

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/kubernetes"

	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/assertion"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/gwtest"
	"github.com/Zzhihon/SreNautix/internal/spoke/testenv"
	"github.com/Zzhihon/SreNautix/internal/spoke/tunnel"
)

var bg = context.Background()

func nodeRef(t testing.TB, e *gwtest.Env, name string) tunnel.TargetRef {
	t.Helper()
	n, err := e.Kube.Core.CoreV1().Nodes().Get(bg, name, metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	return tunnel.TargetRef{Version: "v1", Kind: "Node", Name: name, UID: string(n.UID)}
}

func podRef(p *corev1.Pod) tunnel.TargetRef {
	return tunnel.TargetRef{Version: "v1", Kind: "Pod", Namespace: p.Namespace, Name: p.Name, UID: string(p.UID)}
}

// cordonTicket 返回一张 cordon 节点的 L 档工单。
func cordonTicket(e *gwtest.Env, node string, mut func(*testenv.Request)) tunnel.Ticket {
	r := e.Request("node_cordon", map[string]any{"node": node}, nodeRef(e.T, e, node), assertion.LevelReversible, assertion.TierL)
	if mut != nil {
		mut(&r)
	}
	return e.Ticket(r)
}

func unschedulable(t testing.TB, e *gwtest.Env, node string) bool {
	t.Helper()
	n, err := e.Kube.Core.CoreV1().Nodes().Get(bg, node, metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	return n.Spec.Unschedulable
}

// gatewayCore 返回以 gateway ServiceAccount 身份访问 apiserver 的客户端（"失控 gateway"）。
func gatewayCore(t testing.TB, e *gwtest.Env) kubernetes.Interface {
	t.Helper()
	c, err := kubernetes.NewForConfig(e.Kube.Gateway())
	if err != nil {
		t.Fatal(err)
	}
	return c
}

// waitFinal 等提议进入终态之一，返回阶段、原因与 requires。
func waitFinal(t testing.TB, e *gwtest.Env, proposalID string, timeout time.Duration, phases ...string) (string, string, string) {
	t.Helper()
	testenv.Eventually(t, timeout, proposalID+" reaches one of "+strings.Join(phases, ","), func() (bool, string) {
		p, _, _ := e.Hub.PhaseOf(proposalID)
		for _, want := range phases {
			if p == want {
				return true, ""
			}
		}
		return false, e.Hub.Describe(proposalID)
	})
	return e.Hub.PhaseOf(proposalID)
}

// nodeWrites 返回 apiserver 审计日志中 gateway 对某个节点的成功写入次数。
func nodeWrites(t testing.TB, e *gwtest.Env, node string) int {
	t.Helper()
	n := 0
	for _, ev := range e.Kube.GatewayWrites(t) {
		if ev.ObjectRef.Resource == "nodes" && ev.ObjectRef.Name == node {
			n++
		}
	}
	return n
}

func mergePatchNode(c kubernetes.Interface, node string, patch map[string]any) error {
	b, err := json.Marshal(patch)
	if err != nil {
		return err
	}
	_, err = c.CoreV1().Nodes().Patch(bg, node, types.MergePatchType, b, metav1.PatchOptions{})
	return err
}

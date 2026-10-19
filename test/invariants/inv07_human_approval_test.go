package invariants

import (
	"fmt"
	"strings"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/assertion"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/catalog"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/execution"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/gwtest"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/policy"
	"github.com/Zzhihon/SreNautix/internal/spoke/testenv"
	"github.com/Zzhihon/SreNautix/internal/spoke/tunnel"
)

// 不变量 7：可补偿和不可逆动作一律人工审批（满足条件的可重建 Pod 重启除外）。
func TestInvariant07HumanApprovalForIrreversible(t *testing.T) {
	t.Run("auto execution of irreversible or compensable actions fails to load", func(t *testing.T) {
		cat, err := catalog.Load()
		if err != nil {
			t.Fatal(err)
		}
		for _, a := range cat.Actions {
			ns, autoNS := "    namespaces: [payments]\n", ", namespaces: [payments]"
			if !a.Target.Namespaced {
				ns, autoNS = "", ""
			}
			doc := fmt.Sprintf("version: 1\ncluster: c\napprovers: []\nactions:\n  - id: %s\n%s    auto_execution: {rules: [r]%s}\n", a.ID, ns, autoNS)
			_, err := policy.Parse([]byte(doc), cat)
			reversible := a.Level == assertion.LevelReversible || a.Level == assertion.LevelReversibleRecreatable
			if !reversible && (err == nil || !strings.Contains(err.Error(), "cannot be executed automatically")) {
				t.Errorf("%s (%s): policy with auto execution loaded: %v", a.ID, a.Level, err)
			}
			if reversible && err != nil {
				t.Errorf("%s (%s): %v", a.ID, a.Level, err)
			}
		}
	})

	t.Run("automatic pod restarts outside the recreatable conditions go to human approval", func(t *testing.T) {
		e := gwtest.New(t, gwtest.DefaultActions)
		e.Start(gwtest.Options{})
		autoRestart := func(p *corev1.Pod) tunnel.Ticket {
			r := e.Request("pod_restart", map[string]any{"namespace": p.Namespace, "pod": p.Name}, podRef(p),
				assertion.LevelReversibleRecreatable, assertion.TierL)
			r.Principal, r.Channel = "auto:stuck-pod", assertion.ChannelAuto
			return e.Ticket(r)
		}
		bare := e.F.OwnedPod(gwtest.AppNS, "bare", map[string]string{"app": "bare"}, nil, true)
		single := e.F.Deployment(gwtest.AppNS, "single", 1)
		singlePod := e.F.Pod(e.F.ReplicaSet(single), "single-a", true)
		tight := e.F.Deployment(gwtest.AppNS, "tight", 3)
		tightRS := e.F.ReplicaSet(tight)
		tightPod := e.F.Pod(tightRS, "tight-a", true)
		e.F.Pod(tightRS, "tight-b", true)
		e.F.Pod(tightRS, "tight-c", true)
		e.F.PDB(gwtest.AppNS, "tight", map[string]string{"app": "tight"}, 0, 3, 3, 3)
		for what, p := range map[string]*corev1.Pod{"bare pod": bare, "single replica": singlePod, "PDB without headroom": tightPod} {
			tk := autoRestart(p)
			e.Offer(tk)
			phase, reason, requires := waitFinal(t, e, tk.Proposal.ProposalID, 30*time.Second, execution.PhaseRejected, execution.PhaseVerifying, execution.PhaseExecuting)
			if phase != execution.PhaseRejected || reason != "level_mismatch" || requires != tunnel.RequiresHumanApproval {
				t.Errorf("%s: want rejected/level_mismatch requiring human approval, got %s/%s/%s", what, phase, reason, requires)
			}
			if _, err := e.Kube.Core.CoreV1().Pods(p.Namespace).Get(bg, p.Name, metav1.GetOptions{}); err != nil {
				t.Errorf("%s: pod was removed: %v", what, err)
			}
		}

		// 满足三个条件时自动执行
		ok := e.F.Deployment(gwtest.AppNS, "roomy", 3)
		okRS := e.F.ReplicaSet(ok)
		okPod := e.F.Pod(okRS, "roomy-a", false)
		e.F.Pod(okRS, "roomy-b", true)
		e.F.Pod(okRS, "roomy-c", true)
		e.F.PDB(gwtest.AppNS, "roomy", map[string]string{"app": "roomy"}, 1, 2, 2, 3)
		tk := autoRestart(okPod)
		e.Offer(tk)
		e.WaitPhase(tk.Proposal.ProposalID, execution.PhaseVerifying, 30*time.Second)
		testenv.Eventually(t, 10*time.Second, "pod evicted", func() (bool, string) {
			_, err := e.Kube.Core.CoreV1().Pods(gwtest.AppNS).Get(bg, okPod.Name, metav1.GetOptions{})
			return err != nil, fmt.Sprint(err)
		})
	})
}

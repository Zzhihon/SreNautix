package invariants

import (
	"testing"
	"time"

	admissionregistrationv1 "k8s.io/api/admissionregistration/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/yaml"

	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/admission"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/execution"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/gwtest"
	"github.com/Zzhihon/SreNautix/internal/spoke/testenv"
)

// 不变量 3：没有经过自检的准入策略就只提议。
// 删除一个准入 Binding，或把它改成 Warn，60 秒内 gateway 转为只提议：不再拉取工单，心跳上报 propose_only；恢复后重新执行。
func TestInvariant03NoSelfCheckNoExecution(t *testing.T) {
	e := gwtest.New(t, gwtest.DefaultActions)
	e.F.Node("worker-1", false, true)
	e.F.Node("worker-2", false, true)
	e.F.Node("worker-3", false, true)
	g := e.Start(gwtest.Options{})
	bindings := e.Kube.Core.AdmissionregistrationV1().ValidatingAdmissionPolicyBindings()
	name := gwtest.Prefix + "-gateway-node-scheduling"

	expectProposeOnly := func(what, node string) {
		t.Helper()
		testenv.Eventually(t, 60*time.Second, what+": gateway becomes proposal-only", func() (bool, string) {
			return g.Engine.ProposeOnly(), ""
		})
		testenv.Eventually(t, 10*time.Second, what+": heartbeat reports propose_only", func() (bool, string) {
			hb, ok := e.Hub.LastHeartbeat()
			return ok && hb.ProposeOnly, ""
		})
		tk := cordonTicket(e, node, nil)
		e.Offer(tk)
		time.Sleep(4 * time.Second)
		if evs := e.Hub.EventsForProposal(tk.Proposal.ProposalID); len(evs) != 0 {
			t.Fatalf("%s: proposal-only gateway handled a ticket: %s", what, e.Hub.Describe(tk.Proposal.ProposalID))
		}
		if unschedulable(t, e, node) {
			t.Fatalf("%s: node was cordoned", what)
		}
	}
	restore := func(doc []byte) {
		t.Helper()
		e.Kube.Apply(t, doc)
		testenv.Eventually(t, 60*time.Second, "gateway resumes", func() (bool, string) { return !g.Engine.ProposeOnly(), "" })
	}
	doc, err := yaml.Marshal(admission.Binding(name, testenv.Namespace))
	if err != nil {
		t.Fatal(err)
	}

	t.Run("binding deleted", func(t *testing.T) {
		if err := bindings.Delete(bg, name, metav1.DeleteOptions{}); err != nil {
			t.Fatal(err)
		}
		expectProposeOnly("binding deleted", "worker-1")
		restore(doc)
		// 恢复后，之前被扣住的工单得到执行
		e.WaitPhase(lastProposal(e), execution.PhasePulled, 30*time.Second)
	})

	t.Run("binding switched to Warn", func(t *testing.T) {
		b, err := bindings.Get(bg, name, metav1.GetOptions{})
		if err != nil {
			t.Fatal(err)
		}
		b.Spec.ValidationActions = []admissionregistrationv1.ValidationAction{admissionregistrationv1.Warn}
		if _, err := bindings.Update(bg, b, metav1.UpdateOptions{}); err != nil {
			t.Fatal(err)
		}
		expectProposeOnly("binding switched to Warn", "worker-2")
	})
}

// lastProposal 返回中心最近加入的工单的提议 ID。
func lastProposal(e *gwtest.Env) string { return e.Hub.LastOffered() }

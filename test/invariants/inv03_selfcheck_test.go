package invariants

import (
	"fmt"
	"testing"
	"time"

	admissionregistrationv1 "k8s.io/api/admissionregistration/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/yaml"

	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/admission"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/execution"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/gwtest"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/kube"
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

// probeCount 返回 apiserver 审计日志中 gateway 提交的准入探针数（dryRun 的 ActionExecution 创建）。
func probeCount(t *testing.T, e *gwtest.Env) int {
	t.Helper()
	n := 0
	for _, ev := range e.Kube.AuditEvents(t) {
		if ev.Username() == testenv.GatewayUser && ev.Verb == "create" && ev.DryRun() && ev.ObjectRef != nil && ev.ObjectRef.Resource == "actionexecutions" {
			n++
		}
	}
	return n
}

// 周期性自检的间隔较长时（ADR 0024），安全检查周期之间不再发探针；不变量 3 仍然成立：
// 执行前的自检拦下准入策略失效后的工单；失败之后每个安全检查周期都重新探测，恢复后立即继续执行；启用的策略集合变化时立即探测。
func TestInvariant03SelfCheckCadence(t *testing.T) {
	e := gwtest.New(t, gwtest.DefaultActions)
	e.F.Node("worker-1", false, true)
	e.F.Node("worker-2", false, true)
	g := e.Start(gwtest.Options{SelfCheckInterval: time.Hour})
	shorts := len(e.Admission.ProbeNames(e.Actions))

	// 启动时探测一次；之后的安全检查（每秒一次）沿用结果
	time.Sleep(time.Second)
	before := probeCount(t, e)
	if before < shorts {
		t.Fatalf("%d probes at start, want at least %d", before, shorts)
	}
	time.Sleep(5 * time.Second)
	if n := probeCount(t, e); n != before {
		t.Fatalf("periodic checks probed %d times within the interval", n-before)
	}

	// 删除一个 Binding：周期检查还没到，但执行前的自检拒绝工单，gateway 随即转为只提议
	bindings := e.Kube.Core.AdmissionregistrationV1().ValidatingAdmissionPolicyBindings()
	name := gwtest.Prefix + "-gateway-node-scheduling"
	doc, err := yaml.Marshal(admission.Binding(name, testenv.Namespace))
	if err != nil {
		t.Fatal(err)
	}
	if err := bindings.Delete(bg, name, metav1.DeleteOptions{}); err != nil {
		t.Fatal(err)
	}
	// 以 gateway 的身份确认 apiserver 已不再执行该策略（策略只约束 gateway 的 ServiceAccount）
	gw, err := kube.New(e.Kube.Gateway(), 15*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	testenv.Eventually(t, 30*time.Second, "binding removal is enforced by the apiserver", func() (bool, string) {
		err := execution.NewStore(gw.Dyn, testenv.Namespace).DryRunCreate(bg, admission.ProbeObject(testenv.Namespace, "node-scheduling"))
		return err == nil, fmt.Sprint(err)
	})
	tk := cordonTicket(e, "worker-1", nil)
	e.Offer(tk)
	phase, reason, _ := waitFinal(t, e, tk.Proposal.ProposalID, 30*time.Second, execution.PhaseRejected, execution.PhaseVerifying)
	if phase != execution.PhaseRejected || reason != "propose_only" {
		t.Fatalf("ticket after binding removal: %s/%s", phase, reason)
	}
	if unschedulable(t, e, "worker-1") {
		t.Fatal("node was cordoned without an enforced admission policy")
	}
	testenv.Eventually(t, 10*time.Second, "gateway becomes proposal-only", func() (bool, string) { return g.Engine.ProposeOnly(), "" })

	// 恢复 Binding：上一次自检失败，每个安全检查周期都重新探测，gateway 很快恢复
	e.Kube.Apply(t, doc)
	testenv.Eventually(t, 60*time.Second, "gateway resumes", func() (bool, string) { return !g.Engine.ProposeOnly(), conditionsText(g) })

	// 启用的策略集合变化（停用用到 pod-eviction 的动作）：立即重新探测
	settled := probeCount(t, e)
	time.Sleep(3 * time.Second)
	if n := probeCount(t, e); n != settled {
		t.Fatalf("periodic checks probed %d times after recovery", n-settled)
	}
	reduced := []string{"node_cordon", "node_uncordon", "workload_scale", "rollout_pause"}
	e.WritePolicy(gwtest.DefaultPolicy(reduced))
	want := len(e.Admission.ProbeNames(reduced))
	testenv.Eventually(t, 20*time.Second, "policy change triggers a self-check", func() (bool, string) {
		n := probeCount(t, e) - settled
		return n >= want, fmt.Sprintf("%d new probes, want %d", n, want)
	})
}

// conditionsText 返回 gateway 的状态条件，用于等待失败时的说明。
func conditionsText(g *gwtest.Gateway) string { return fmt.Sprint(g.Engine.Conditions()) }

// lastProposal 返回中心最近加入的工单的提议 ID。
func lastProposal(e *gwtest.Env) string { return e.Hub.LastOffered() }

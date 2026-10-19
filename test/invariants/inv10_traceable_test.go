package invariants

import (
	"context"
	"crypto/ed25519"
	"testing"
	"time"

	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/audit"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/execution"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/gwtest"
	"github.com/Zzhihon/SreNautix/internal/spoke/testenv"
)

// 不变量 10：每次写入都可追溯，审计导出到 PG 之外。
// apiserver 审计日志中 gateway 的每一次写入，在审计汇（MinIO，对象锁定）的执行链中都有对应的写入记录与审批人；
// 审计汇不可用时 gateway 不认领新的执行，恢复后继续。
func TestInvariant10TraceableWrites(t *testing.T) {
	e := gwtest.New(t, gwtest.DefaultActions)
	e.F.Node("worker-1", false, true)
	e.F.Node("worker-2", false, true)
	e.F.Node("worker-3", false, true)
	g := e.Start(gwtest.Options{})

	tk := cordonTicket(e, "worker-1", nil)
	e.Offer(tk)
	e.WaitPhase(tk.Proposal.ProposalID, execution.PhaseVerifying, 30*time.Second)
	e.Advance(61 * time.Second)
	e.WaitPhase(tk.Proposal.ProposalID, execution.PhaseVerified, 30*time.Second)

	pub := e.SigningKey.Public().(ed25519.PublicKey)
	testenv.Eventually(t, 30*time.Second, "every gateway write is in the audit sink", func() (bool, string) {
		if err := g.Audit.Flush(context.Background()); err != nil {
			return false, err.Error()
		}
		recs := e.ReadSinkRecords(g.Audit)
		if err := audit.Verify(recs, pub); err != nil {
			return false, err.Error()
		}
		writes := e.Kube.GatewayWrites(t)
		if len(writes) == 0 {
			return false, "no gateway writes in the apiserver audit log"
		}
		for _, w := range writes {
			found := false
			for _, r := range recs {
				if r.Type == audit.TypeWrite && r.Write.Outcome == "succeeded" && r.Target != nil &&
					r.Target.Resource == w.ObjectRef.Resource && r.Target.Name == w.ObjectRef.Name &&
					r.Approver != nil && r.Approver.Principal == gwtest.Approver {
					found = true
				}
			}
			if !found {
				return false, "apiserver write " + w.Verb + " " + w.ObjectRef.Resource + "/" + w.ObjectRef.Name + " is not in the sink"
			}
		}
		return true, ""
	})

	t.Run("sink unavailable", func(t *testing.T) {
		e.T, e.F.T = t, t
		e.MinIO.Stop()
		testenv.Eventually(t, 30*time.Second, "gateway becomes proposal-only", func() (bool, string) { return g.Engine.ProposeOnly(), "" })
		blocked := cordonTicket(e, "worker-2", nil)
		e.Offer(blocked)
		time.Sleep(4 * time.Second)
		if evs := e.Hub.EventsForProposal(blocked.Proposal.ProposalID); len(evs) != 0 || unschedulable(t, e, "worker-2") {
			t.Fatalf("gateway executed without an audit sink: %s", e.Hub.Describe(blocked.Proposal.ProposalID))
		}
		e.MinIO.Start()
		testenv.Eventually(t, 60*time.Second, "gateway resumes", func() (bool, string) { return !g.Engine.ProposeOnly(), "" })
		e.WaitPhase(blocked.Proposal.ProposalID, execution.PhaseVerifying, 30*time.Second)
	})
}

package invariants

import (
	"strings"
	"testing"
	"time"

	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/assertion"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/execution"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/gwtest"
	"github.com/Zzhihon/SreNautix/internal/spoke/testenv"
)

// 不变量 5：审批签名并绑定。
// 签名之后逐个篡改断言字段、签名有效但与工单绑定不一致、伪造的签名、早于恢复标记的审批，都被 gateway 拒绝，目标不被修改。
// 规范化与每个原因码的完整覆盖见 contract/gateway/v1/testvectors 与 internal/spoke/gateway/assertion。
func TestInvariant05SignedAndBound(t *testing.T) {
	e := gwtest.New(t, gwtest.DefaultActions)
	e.F.Node("worker-1", false, true)
	e.F.Node("worker-2", false, true)
	e.Start(gwtest.Options{})
	forger := testenv.NewApprover("service-test")
	forger.Key = testenv.NewApprover("attacker").Key

	tampered := map[string]any{
		"proposal_id": "6f1c2a8e-4b7d-4e2a-9c3f-1d2e3f4a5b6d", "action": "node_uncordon", "level": "irreversible", "tier": "H",
		"target_uid": "0b9c5e7a-3f1d-4c2b-8a6e-5d4c3b2a1f0f", "cluster": "other-cluster", "incident_version": 99,
		"root_component": "other/component", "approver_principal": "oidc:mallory@example.org", "channel": "telegram",
		"expires_at": "2099-01-01T00:00:00Z", "params_hash": "sha256:" + strings.Repeat("ab", 32),
		"evidence_fingerprint": "sha256:" + strings.Repeat("cd", 32),
	}
	type tc struct {
		name   string
		mut    func(*testenv.Request)
		reason string
		forged bool
	}
	var cases []tc
	for field, v := range tampered {
		cases = append(cases, tc{name: "tampered " + field, reason: assertion.ErrBadSignature,
			mut: func(r *testenv.Request) { r.Tamper = func(m map[string]any) { m[field] = v } }})
	}
	cases = append(cases,
		tc{name: "signed for another cluster", reason: assertion.ErrBindingCluster,
			mut: func(r *testenv.Request) { r.Mutate = func(a *assertion.Assertion) { a.Cluster = "other-cluster" } }},
		tc{name: "signed for other params", reason: assertion.ErrBindingParams,
			mut: func(r *testenv.Request) {
				r.Mutate = func(a *assertion.Assertion) { a.ParamsHash = tampered["params_hash"].(string) }
			}},
		tc{name: "signed for another target", reason: assertion.ErrBindingTarget,
			mut: func(r *testenv.Request) {
				r.Mutate = func(a *assertion.Assertion) { a.TargetUID = "0b9c5e7a-3f1d-4c2b-8a6e-5d4c3b2a1f0f" }
			}},
		tc{name: "signed for another incident version", reason: assertion.ErrBindingIncident,
			mut: func(r *testenv.Request) { r.Mutate = func(a *assertion.Assertion) { a.IncidentVersion = 99 } }},
		tc{name: "forged signature", reason: assertion.ErrBadSignature, forged: true},
	)
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			e.T, e.F.T = t, t
			r := e.Request("node_cordon", map[string]any{"node": "worker-1"}, nodeRef(t, e, "worker-1"), assertion.LevelReversible, assertion.TierL)
			if c.mut != nil {
				c.mut(&r)
			}
			a := e.Approver
			if c.forged {
				a = forger
			}
			tk := a.Ticket(t, e.Clock.Now(), r)
			e.Offer(tk)
			phase, reason, _ := waitFinal(t, e, tk.Proposal.ProposalID, 30*time.Second, execution.PhaseRejected, execution.PhaseVerifying, execution.PhaseExpired)
			if phase != execution.PhaseRejected || reason != c.reason {
				t.Fatalf("want rejected/%s, got %s/%s: %s", c.reason, phase, reason, e.Hub.Describe(tk.Proposal.ProposalID))
			}
			if unschedulable(t, e, "worker-1") {
				t.Fatal("node was cordoned")
			}
		})
	}

	t.Run("approval issued before the restore marker", func(t *testing.T) {
		e.T, e.F.T = t, t
		tk := cordonTicket(e, "worker-1", func(r *testenv.Request) { r.IssuedAt = e.Clock.Now().Add(-time.Minute) })
		e.Hub.SetRestoredAt(e.Clock.Now().Add(-30 * time.Second))
		time.Sleep(2 * time.Second) // 心跳把恢复标记带给 gateway
		e.Offer(tk)
		phase, reason, _ := waitFinal(t, e, tk.Proposal.ProposalID, 30*time.Second, execution.PhaseRejected, execution.PhaseVerifying)
		if phase != execution.PhaseRejected || reason != assertion.ErrIssuedBeforeRestore {
			t.Fatalf("got %s/%s", phase, reason)
		}
		// 恢复之后签发的审批照常执行
		ok := cordonTicket(e, "worker-1", nil)
		e.Offer(ok)
		e.WaitPhase(ok.Proposal.ProposalID, execution.PhaseVerifying, 30*time.Second)
		if !unschedulable(t, e, "worker-1") {
			t.Fatal("approval issued after the restore marker was not executed")
		}
	})
}

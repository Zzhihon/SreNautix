package invariants

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/assertion"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/execution"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/gwtest"
	"github.com/Zzhihon/SreNautix/internal/spoke/testenv"
)

// rounds 返回每个故障点的轮数：envtest 上默认 1 轮；Kind 入口设置 SRENAUTIX_INVARIANT8_ROUNDS 做大量随机轮次。
func rounds(t *testing.T) int {
	v := os.Getenv("SRENAUTIX_INVARIANT8_ROUNDS")
	if v == "" {
		return 1
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < 1 {
		t.Fatalf("SRENAUTIX_INVARIANT8_ROUNDS=%q", v)
	}
	return n
}

// 不变量 8：最多执行一次。
// 以子进程运行 gateway，在执行路径的各个故障点 kill -9；另一个 gateway 接管 Lease 后从 ActionExecution 恢复，
// 只观察、不重跑。以 apiserver 审计日志为准，每次执行对目标的写入不超过一次，且结局与观察一致。
func TestInvariant08AtMostOnce(t *testing.T) {
	e := gwtest.New(t, gwtest.DefaultActions)
	e.F.Node("spare-1", false, true)
	n := rounds(t)
	points := []struct {
		point   string
		applied bool
		final   string
	}{
		{"executing_written", false, execution.PhaseFailed},
		{"side_effect_done", true, execution.PhaseVerified},
		{"verifying_written", true, execution.PhaseVerified},
	}
	for round := 0; round < n; round++ {
		for _, p := range points {
			t.Run(fmt.Sprintf("%s round %d", p.point, round), func(t *testing.T) {
				e.T, e.F.T = t, t
				suffix := fmt.Sprintf("%d-%s", round, strings.ReplaceAll(p.point, "_", "-"))
				node := "kill-" + suffix
				e.F.Node(node, false, true)
				e.Clock.SetTime(time.Now().UTC())
				child := e.StartChild(gwtest.Options{Identity: "child-" + suffix}, p.point)
				r := e.Request("node_cordon", map[string]any{"node": node}, nodeRef(t, e, node), assertion.LevelReversible, assertion.TierL)
				tk := e.Approver.Ticket(t, time.Now().UTC(), r)
				id := e.Offer(tk)
				if !child.Exited(90 * time.Second) {
					t.Fatalf("child gateway did not reach fault point %s", p.point)
				}
				g := e.Start(gwtest.Options{Identity: "recover-" + suffix})
				if p.applied {
					testenv.Eventually(t, 60*time.Second, "recovery reaches verifying", func() (bool, string) {
						return e.Execution(id).Status.Phase == execution.PhaseVerifying, e.Execution(id).Status.Phase
					})
					e.Advance(10 * time.Minute)
				}
				e.WaitPhase(tk.Proposal.ProposalID, p.final, 60*time.Second)
				g.Stop(t)
				writes := nodeWrites(t, e, node)
				want := 0
				if p.applied {
					want = 1
				}
				if writes != want {
					t.Fatalf("apiserver audit log has %d gateway writes to %s, want %d", writes, node, want)
				}
				if got := unschedulable(t, e, node); got != p.applied {
					t.Fatalf("node unschedulable=%v, want %v", got, p.applied)
				}
				seen := map[int64]bool{}
				for _, ev := range e.Hub.Events(id) {
					if seen[ev.Seq] {
						t.Fatalf("hub accepted seq %d twice", ev.Seq)
					}
					seen[ev.Seq] = true
				}
			})
		}
	}
}

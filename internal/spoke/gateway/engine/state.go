package engine

import (
	"context"
	"fmt"
	"strings"
	"sync"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/util/retry"

	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/audit"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/execution"
)

// tr 是一次阶段迁移。
type tr struct {
	phase, reason, message, requires string
	// mutate 在写入前修改 status（在最新读取的对象上执行，可能因冲突重试多次）。
	mutate func(*execution.Status)
}

func (e *Engine) lockExec(id string) func() {
	m, _ := e.execMu.LoadOrStore(id, &sync.Mutex{})
	mu := m.(*sync.Mutex)
	mu.Lock()
	return mu.Unlock
}

func auditTarget(t execution.TargetRef) *audit.Target {
	return &audit.Target{Group: t.Group, Resource: t.Resource, Namespace: t.Namespace, Name: t.Name, UID: t.UID}
}

// transition 先把迁移追加到执行审计链（本地暂存 fsync），再写 ActionExecution 的 status 与 history。
// 审计链不可写时返回错误，迁移不发生。
func (e *Engine) transition(ctx context.Context, id string, t tr) (*execution.ActionExecution, error) {
	unlock := e.lockExec(id)
	defer unlock()
	cur, err := e.store.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	rec, err := e.d.Audit.Append(audit.Record{
		Type: audit.TypePhase, ExecutionID: id, ProposalID: cur.Spec.ProposalID, Action: cur.Spec.Action,
		Phase: t.phase, Reason: t.reason, Approver: &audit.Approver{Principal: cur.Spec.Approver.Principal, Channel: cur.Spec.Approver.Channel},
		AssertionHash: cur.Spec.AssertionHash, AttemptID: cur.Status.AttemptID, Target: auditTarget(cur.Spec.Target),
	})
	if err != nil {
		return nil, fmt.Errorf("audit %s %s: %w", id, t.phase, err)
	}
	at := metav1.NewTime(e.now())
	var out *execution.ActionExecution
	err = retry.RetryOnConflict(retry.DefaultRetry, func() error {
		x, err := e.store.Get(ctx, id)
		if err != nil {
			return err
		}
		if t.mutate != nil {
			t.mutate(&x.Status)
		}
		x.Status.Phase, x.Status.Reason, x.Status.Message = t.phase, t.reason, truncate(t.message, 4000)
		x.Status.History = append(x.Status.History, execution.HistoryEntry{
			Seq: x.LastSeq() + 1, Phase: t.phase, At: at, Reason: t.reason, Message: truncate(t.message, 1000), Requires: t.requires,
			AuditSeq: rec.Seq, AuditHash: rec.Hash,
		})
		if execution.Terminal(t.phase) {
			x.Status.FinishedAt = &at
		}
		out, err = e.store.UpdateStatus(ctx, x)
		return err
	})
	if err != nil {
		return nil, fmt.Errorf("status %s %s: %w", id, t.phase, err)
	}
	e.d.Metrics.Executions.WithLabelValues(cur.Spec.Action, t.phase).Inc()
	return out, nil
}

// update 只修改 status 的字段，不产生阶段迁移（例如分步动作的进度）。
func (e *Engine) update(ctx context.Context, id string, mutate func(*execution.Status)) (*execution.ActionExecution, error) {
	unlock := e.lockExec(id)
	defer unlock()
	var out *execution.ActionExecution
	err := retry.RetryOnConflict(retry.DefaultRetry, func() error {
		x, err := e.store.Get(ctx, id)
		if err != nil {
			return err
		}
		mutate(&x.Status)
		out, err = e.store.UpdateStatus(ctx, x)
		return err
	})
	return out, err
}

// wrote 把一次写入记录到执行审计链（与 apiserver 审计日志按 attempt_id、目标与时间关联）。
func (e *Engine) wrote(x *execution.ActionExecution) func(ctx context.Context, target audit.Target, verb string, err error) error {
	return func(ctx context.Context, target audit.Target, verb string, werr error) error {
		w := &audit.Write{Verb: verb, Outcome: "succeeded"}
		if werr != nil {
			w.Outcome, w.Detail = "failed", truncate(werr.Error(), 1000)
		}
		_, err := e.d.Audit.Append(audit.Record{
			Type: audit.TypeWrite, ExecutionID: x.Spec.ExecutionID, ProposalID: x.Spec.ProposalID, Action: x.Spec.Action,
			Approver:      &audit.Approver{Principal: x.Spec.Approver.Principal, Channel: x.Spec.Approver.Channel},
			AssertionHash: x.Spec.AssertionHash, AttemptID: x.Status.AttemptID, Target: &target, Write: w,
		})
		return err
	}
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return strings.ToValidUTF8(s[:n], "")
}

package engine

import (
	"context"
	"encoding/json"
	"log/slog"

	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/assertion"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/execution"
	"github.com/Zzhihon/SreNautix/internal/spoke/tunnel"
)

// events 把 ActionExecution 中尚未被中心确认的 history 转换为执行事件。
func (e *Engine) events(x *execution.ActionExecution) []tunnel.ExecutionEvent {
	var out []tunnel.ExecutionEvent
	for _, h := range x.Status.History {
		if h.Seq <= x.Status.PushedSeq {
			continue
		}
		ev := tunnel.ExecutionEvent{
			EventID: assertion.EventID(x.Name, h.Seq), ExecutionID: x.Name, TicketID: x.Spec.TicketID, ProposalID: x.Spec.ProposalID,
			Seq: h.Seq, Phase: h.Phase, At: assertion.FormatTime(h.At.Time), Reason: h.Reason, Message: h.Message, Requires: h.Requires,
		}
		if h.AuditSeq > 0 {
			ev.Audit = &tunnel.AuditRef{Seq: h.AuditSeq, Hash: h.AuditHash}
		}
		if h.Phase == execution.PhasePulled && x.Status.Phase == execution.PhasePulled {
			ev.QueuePosition = e.q.position(x.Name)
		}
		if h.Phase == execution.PhaseAwaitingCompensationApproval && x.Status.Compensation != nil {
			params := json.RawMessage(x.Status.Compensation.Params.Raw)
			if len(params) == 0 {
				params = json.RawMessage("{}")
			}
			ev.Compensation = &tunnel.Compensation{Action: x.Status.Compensation.Action, Params: params, Reason: x.Status.Compensation.Reason}
		}
		out = append(out, ev)
	}
	return out
}

// push 推送全部未确认的执行事件，中心接受后更新 status.pushedSeq；同时更新转人工的计数。
func (e *Engine) push(ctx context.Context) {
	list, err := e.store.List(ctx)
	if err != nil {
		slog.Error("list executions", "err", err)
		return
	}
	needsHuman := 0
	var batch []tunnel.ExecutionEvent
	last := map[string]int64{}
	for _, x := range list {
		if x.Status.Phase == execution.PhaseNeedsHuman || x.Status.Phase == execution.PhaseIndeterminate {
			needsHuman++
		}
		evs := e.events(x)
		if len(evs) == 0 {
			continue
		}
		if len(batch)+len(evs) > 500 {
			break
		}
		batch = append(batch, evs...)
		last[x.Name] = evs[len(evs)-1].Seq
	}
	e.d.Metrics.NeedsHuman.Set(float64(needsHuman))
	if len(batch) == 0 {
		return
	}
	if _, err := e.d.Hub.PushEvents(ctx, batch); err != nil {
		slog.Error("push execution events", "count", len(batch), "err", err)
		return
	}
	for id, seq := range last {
		if _, err := e.update(ctx, id, func(s *execution.Status) {
			if seq > s.PushedSeq {
				s.PushedSeq = seq
			}
		}); err != nil {
			slog.Error("record pushed seq", "id", id, "err", err)
		}
	}
}

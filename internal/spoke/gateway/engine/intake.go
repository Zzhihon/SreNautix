package engine

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"

	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/assertion"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/catalog"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/execution"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/executor"
	"github.com/Zzhihon/SreNautix/internal/spoke/tunnel"
)

// pullLoop 长轮询拉取工单；只提议、停机或失去主实例身份时不认领新工单。只提议的唯一原因是冻结时，
// 只拉取不写集群的 gitops_pr（ADR 0025），其余工单留在中心的队列中。
func (e *Engine) pullLoop(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}
		var only []string
		if e.ProposeOnly() {
			if only = e.acceptedActions(); len(only) == 0 {
				e.sleep(ctx, time.Second)
				continue
			}
		}
		batch, err := e.d.Hub.PullTickets(ctx, e.cfg.PullWait, 20, only...)
		if err != nil {
			if ctx.Err() == nil {
				slog.Error("pull tickets", "err", err)
				e.sleep(ctx, 2*time.Second)
			}
			continue
		}
		e.observeHub(batch.HubClock)
		skipped := false
		for _, t := range batch.Tickets {
			if ctx.Err() != nil {
				break
			}
			if !e.Accepts(t.Proposal.Action) {
				// 未处理的工单没有 pulled 事件，中心会再次下发
				skipped = true
				continue
			}
			if err := e.intake(ctx, t); err != nil {
				slog.Error("intake ticket", "ticket", t.TicketID, "proposal", t.Proposal.ProposalID, "err", err)
			}
		}
		if skipped {
			e.sleep(ctx, time.Second)
		}
		e.Wake()
	}
}

func (e *Engine) sleep(ctx context.Context, d time.Duration) {
	select {
	case <-ctx.Done():
	case <-time.After(d):
	}
}

// verdict 是工单在入队前的结论；nil 表示通过。
type verdict struct {
	phase, reason, requires, message string
}

func reject(reason, requires, format string, args ...any) *verdict {
	return &verdict{phase: execution.PhaseRejected, reason: reason, requires: requires, message: fmt.Sprintf(format, args...)}
}

// bindingVerdict 把断言校验的原因码映射为阶段。
func bindingVerdict(err error) *verdict {
	code := assertion.Code(err)
	switch code {
	case assertion.ErrExpired, assertion.ErrProposalExpired:
		return &verdict{phase: execution.PhaseExpired, reason: code, message: err.Error()}
	case "":
		return reject("assertion_invalid", "", "%v", err)
	}
	return reject(code, "", "%v", err)
}

// intake 校验一张工单并写入 ActionExecution：先创建（pulled），再按结论迁移到 rejected、expired、stale，
// 或进入冲突域队列。重复下发的工单遇到同名对象，直接返回。
func (e *Engine) intake(ctx context.Context, t tunnel.Ticket) error {
	var env struct {
		Assertion json.RawMessage `json:"assertion"`
	}
	if err := json.Unmarshal(t.Envelope, &env); err != nil || len(env.Assertion) == 0 {
		return e.orphan(ctx, t, "", "envelope_invalid", fmt.Sprint(err))
	}
	hash, err := assertion.Hash(env.Assertion)
	if err != nil {
		return e.orphan(ctx, t, "", "assertion_invalid", err.Error())
	}
	id := assertion.ExecutionID(t.Proposal.ProposalID, hash)
	if _, err := e.store.Get(ctx, id); err == nil {
		return nil
	} else if !apierrors.IsNotFound(err) {
		return err
	}
	keys := e.currentKeys()
	ver, verr := keys.Verify(t.Envelope, assertion.VerifyOptions{RequireWebAuthnForH: e.cfg.RequireWebAuthnForH})
	if verr != nil && assertion.Code(verr) == assertion.ErrSchema {
		return e.orphan(ctx, t, id, assertion.ErrSchema, verr.Error())
	}
	var a assertion.Assertion
	if err := json.Unmarshal(env.Assertion, &a); err != nil {
		return e.orphan(ctx, t, id, assertion.ErrSchema, err.Error())
	}
	act, known := e.d.Catalog.Get(t.Proposal.Action)
	ex := e.d.Executors[t.Proposal.Action]
	var res *executor.Resolved
	var resErr error
	domain := "unknown:" + t.Proposal.Action
	if known {
		res, resErr = ex.Resolve(ctx, t.Proposal.Params)
		if resErr != nil && !errors.Is(resErr, executor.ErrTargetNotFound) {
			return fmt.Errorf("resolve target: %w", resErr)
		}
		if res != nil {
			domain = res.Domain
		}
	}
	x, err := e.create(ctx, t, id, hash, a, act, domain)
	if apierrors.IsAlreadyExists(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if _, err := e.transition(ctx, id, tr{phase: execution.PhasePulled, reason: "received", message: "ticket " + t.TicketID}); err != nil {
		return err
	}
	v := e.check(ctx, t, ver, verr, a, act, res, resErr)
	if v != nil {
		e.d.Metrics.TicketsRejected.WithLabelValues(v.reason).Inc()
		_, err := e.transition(ctx, id, tr{phase: v.phase, reason: v.reason, requires: v.requires, message: v.message})
		return err
	}
	e.q.add(x.Spec.ConflictDomain, id)
	e.d.Metrics.QueueDepth.Set(float64(e.q.depth()))
	return nil
}

func (e *Engine) create(ctx context.Context, t tunnel.Ticket, id, hash string, a assertion.Assertion, act *catalog.Action, domain string) (*execution.ActionExecution, error) {
	approvalExp, err := assertion.ParseTime(a.ExpiresAt)
	if err != nil {
		return nil, err
	}
	proposalExp, err := assertion.ParseTime(t.Proposal.ProposalExpiresAt)
	if err != nil {
		return nil, fmt.Errorf("proposal_expires_at: %w", err)
	}
	target := execution.TargetRef{Group: t.Proposal.Target.Group, Version: t.Proposal.Target.Version, Kind: t.Proposal.Target.Kind,
		Namespace: t.Proposal.Target.Namespace, Name: t.Proposal.Target.Name, UID: t.Proposal.Target.UID}
	if act != nil {
		for _, k := range act.Target.All() {
			if k.Kind == target.Kind && k.Group == target.Group {
				target.Resource = k.Resource
			}
		}
	}
	return e.store.Create(ctx, &execution.ActionExecution{
		ObjectMeta: metav1.ObjectMeta{Name: id, Namespace: e.cfg.Namespace,
			Labels: map[string]string{"srenautix.io/action": t.Proposal.Action, "srenautix.io/proposal-id": t.Proposal.ProposalID}},
		Spec: execution.Spec{
			ExecutionID: id, TicketID: t.TicketID, ProposalID: t.Proposal.ProposalID, Cluster: e.cfg.Cluster,
			Action: t.Proposal.Action, Level: a.Level, Tier: a.Tier, Target: target,
			Params: runtime.RawExtension{Raw: t.Proposal.Params}, ParamsHash: a.ParamsHash, AssertionHash: hash,
			CanonVersion: a.CanonVersion, Envelope: string(t.Envelope),
			Approver: execution.Approver{Principal: a.ApproverPrincipal, Channel: a.Channel},
			Incident: execution.Incident{ID: t.Proposal.IncidentID, Version: t.Proposal.IncidentVersion,
				RootComponent: t.Proposal.RootComponent, EvidenceFingerprint: t.Proposal.EvidenceFingerprint},
			ConflictDomain: domain, PulledAt: metav1.NewTime(e.now()),
			ApprovalExpiresAt: metav1.NewTime(approvalExp), ProposalExpiresAt: metav1.NewTime(proposalExp),
		},
	})
}

// requiredLevel 返回按目标当前状态确定的等级与最低档位（DESIGN §9.1 自我保护、§9.2 爆炸半径）。
func (e *Engine) requiredLevel(act *catalog.Action, res *executor.Resolved) (level, tier string, self bool) {
	level = act.Level
	if res.Level != "" {
		level = res.Level
	}
	ns := res.Target.Namespace
	self = ns == e.cfg.Namespace || e.currentPolicy().IsSelfDependency(ns, res.Nodes, res.PGCluster, []string{e.cfg.NodeName})
	if self {
		level = assertion.LevelIrreversible
	}
	tier = act.MinTierFor(level)
	if self || res.NeedsH || res.BlastRadius > act.BlastRadius.LTierMax {
		tier = assertion.TierH
	}
	return level, tier, self
}

// check 依次核对签名、绑定与时效、动作启用、参数、目标、命名空间、审批人作用域、等级与档位、自动执行上限。
func (e *Engine) check(ctx context.Context, t tunnel.Ticket, ver *assertion.Verified, verr error, a assertion.Assertion,
	act *catalog.Action, res *executor.Resolved, resErr error) *verdict {
	if verr != nil {
		return reject(assertion.Code(verr), "", "%v", verr)
	}
	pexp, err := assertion.ParseTime(t.Proposal.ProposalExpiresAt)
	if err != nil {
		return reject("ticket_invalid", "", "proposal_expires_at: %v", err)
	}
	if err := assertion.CheckBinding(ver, assertion.Binding{
		ProposalID: t.Proposal.ProposalID, Action: t.Proposal.Action, Params: t.Proposal.Params, TargetUID: t.Proposal.Target.UID,
		Cluster: e.cfg.Cluster, IncidentVersion: t.Proposal.IncidentVersion, RootComponent: t.Proposal.RootComponent,
		EvidenceFingerprint: t.Proposal.EvidenceFingerprint, ProposalExpiresAt: pexp,
	}, e.now(), e.restoreMarker()); err != nil {
		return bindingVerdict(err)
	}
	if act == nil {
		return reject("action_unknown", "", "action %s is not in the catalog", t.Proposal.Action)
	}
	pol := e.currentPolicy()
	ap, enabled := pol.Action(act.ID)
	if !enabled {
		return reject("action_not_enabled", "", "action %s is not enabled by the gateway policy", act.ID)
	}
	if _, err := e.d.Catalog.ValidateParams(act, t.Proposal.Params); err != nil {
		return reject("invalid_params", "", "%v", err)
	}
	if errors.Is(resErr, executor.ErrTargetNotFound) {
		return &verdict{phase: execution.PhaseStale, reason: "target_not_found", message: resErr.Error()}
	}
	if res.Target.UID != a.TargetUID {
		return &verdict{phase: execution.PhaseStale, reason: "target_changed", message: fmt.Sprintf("target uid is now %s, approved %s", res.Target.UID, a.TargetUID)}
	}
	ns := res.Target.Namespace
	if !ap.NamespaceAllowed(ns) {
		return reject("namespace_not_enabled", "", "namespace %q is not enabled for %s", ns, act.ID)
	}
	auto := a.Channel == assertion.ChannelAuto
	humanIfAuto := ""
	if auto {
		humanIfAuto = tunnel.RequiresHumanApproval
	}
	if err := pol.CheckApprover(a.ApproverPrincipal, a.Channel, act.ID, ns, a.Tier); err != nil {
		return reject("approver_scope", humanIfAuto, "%v", err)
	}
	level, tier, self := e.requiredLevel(act, res)
	if a.Level != level {
		req := tunnel.RequiresReapproval
		if auto {
			req = tunnel.RequiresHumanApproval
		}
		return reject("level_mismatch", req, "approved level %s, target requires %s", a.Level, level)
	}
	if assertion.TierRank(a.Tier) < assertion.TierRank(tier) {
		req := tunnel.RequiresTierH
		if auto {
			req = tunnel.RequiresHumanApproval
		}
		return reject("tier_too_low", req, "approved tier %s, %s at blast radius %d requires %s", a.Tier, level, res.BlastRadius, tier)
	}
	if auto {
		if !act.AutoAllowed() || (level != assertion.LevelReversible && level != assertion.LevelReversibleRecreatable) || self {
			return reject("auto_not_allowed", tunnel.RequiresHumanApproval, "%s at level %s (self dependency %v) needs human approval", act.ID, level, self)
		}
		n, err := e.autoExecutionsLastHour(ctx)
		if err != nil {
			return reject("auto_cap_unavailable", tunnel.RequiresHumanApproval, "%v", err)
		}
		if n >= pol.MaxAutoPerHour() {
			return reject("auto_hourly_cap", tunnel.RequiresHumanApproval, "%d automatic executions in the last hour, cap %d", n, pol.MaxAutoPerHour())
		}
	}
	return nil
}

func (e *Engine) autoExecutionsLastHour(ctx context.Context) (int, error) {
	list, err := e.store.List(ctx)
	if err != nil {
		return 0, err
	}
	since := e.now().Add(-time.Hour)
	n := 0
	for _, x := range list {
		if x.Spec.Approver.Channel == assertion.ChannelAuto && x.Status.ExecutedAt != nil && x.Status.ExecutedAt.Time.After(since) {
			n++
		}
	}
	return n, nil
}

// orphan 处理无法写入 ActionExecution 的工单（信封不是合法的断言）：直接推送一个 rejected 事件。
func (e *Engine) orphan(ctx context.Context, t tunnel.Ticket, id, reason, msg string) error {
	e.d.Metrics.TicketsRejected.WithLabelValues(reason).Inc()
	if id == "" {
		h, err := assertion.HashValue(map[string]any{"ticket": t.TicketID, "envelope": string(t.Envelope)})
		if err != nil {
			return err
		}
		id = assertion.ExecutionID(t.Proposal.ProposalID, h)
	}
	_, err := e.d.Hub.PushEvents(ctx, []tunnel.ExecutionEvent{{
		EventID: assertion.EventID(id, 1), ExecutionID: id, TicketID: t.TicketID, ProposalID: t.Proposal.ProposalID, Seq: 1,
		Phase: execution.PhaseRejected, At: assertion.FormatTime(e.now()), Reason: reason, Message: truncate(msg, 4000),
	}})
	if err != nil {
		return fmt.Errorf("push rejected ticket %s: %w", t.TicketID, err)
	}
	return fmt.Errorf("ticket %s rejected: %s: %s", t.TicketID, reason, msg)
}

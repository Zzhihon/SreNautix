package engine

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"

	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/assertion"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/catalog"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/execution"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/executor"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/kube"
	"github.com/Zzhihon/SreNautix/internal/spoke/tunnel"
)

// dispatchLoop 为空闲的冲突域分配执行；停机后不再开始新的执行。
func (e *Engine) dispatchLoop(ctx, work context.Context) {
	t := time.NewTicker(time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-e.wake:
		case <-t.C:
		}
		for _, id := range e.q.next(e.cfg.MaxConcurrent) {
			e.start(work, id)
		}
		e.d.Metrics.QueueDepth.Set(float64(e.q.depth()))
	}
}

func (e *Engine) start(work context.Context, id string) {
	e.running.Add(1)
	go func() {
		defer e.running.Done()
		defer e.Wake()
		defer e.q.done(id)
		if err := e.run(work, id); err != nil {
			slog.Error("execution", "id", id, "err", err)
		}
	}()
}

func (e *Engine) stoppingNow() bool {
	select {
	case <-e.stopping:
		return true
	default:
		return false
	}
}

// run 按 ActionExecution 当前阶段推进一次执行。
func (e *Engine) run(ctx context.Context, id string) error {
	x, err := e.store.Get(ctx, id)
	if err != nil {
		return err
	}
	switch x.Status.Phase {
	case execution.PhasePulled, execution.PhasePrechecked:
		return e.precheckAndExecute(ctx, x)
	case execution.PhaseExecuting:
		return e.recoverExecuting(ctx, x)
	case execution.PhaseVerifying:
		return e.verifyPhase(ctx, x)
	case execution.PhaseVerifyFailed:
		return e.afterVerifyFailed(ctx, x)
	}
	return nil
}

func snapshotMap(x *execution.ActionExecution) (map[string]any, error) {
	if x.Status.Snapshot == nil || len(x.Status.Snapshot.Raw) == 0 {
		return map[string]any{}, nil
	}
	var m map[string]any
	return m, json.Unmarshal(x.Status.Snapshot.Raw, &m)
}

func (e *Engine) execContext(x *execution.ActionExecution, snap map[string]any) *executor.Exec {
	return &executor.Exec{
		AE: x, Params: x.Spec.Params.Raw, Snapshot: snap,
		Progress: func(ctx context.Context, step string) error {
			_, err := e.update(ctx, x.Name, func(s *execution.Status) { s.Progress = append(s.Progress, step) })
			return err
		},
		Wrote: e.wrote(x),
	}
}

// precheckAndExecute 是 DESIGN §9.4 的执行路径：重新核对时效、只提议条件、准入自检与熔断开关、中心的绑定、
// 目标 UID、等级与档位、预检；写入 prechecked 与 executing（带 attempt ID）之后才产生副作用。
func (e *Engine) precheckAndExecute(ctx context.Context, x *execution.ActionExecution) error {
	id := x.Name
	fail := func(v *verdict) error {
		_, err := e.transition(ctx, id, tr{phase: v.phase, reason: v.reason, requires: v.requires, message: v.message})
		return err
	}
	now := e.now()
	if !now.Before(x.Spec.ApprovalExpiresAt.Time) || !now.Before(x.Spec.ProposalExpiresAt.Time) {
		return fail(&verdict{phase: execution.PhaseExpired, reason: "expired", message: "approval or proposal expired while queued"})
	}
	if e.ProposeOnly() {
		return fail(reject("propose_only", "", "gateway is proposal-only"))
	}
	if err := e.SelfCheck(ctx); err != nil {
		e.mu.Lock()
		e.proposeOnly = true
		e.mu.Unlock()
		return fail(reject("propose_only", "", "%v", err))
	}
	if frozen, detail, err := e.Frozen(ctx); err != nil || frozen {
		return fail(reject("frozen", "", "srenautix-freeze %s %v", detail, err))
	}
	b, err := e.d.Hub.GetBinding(ctx, x.Spec.ProposalID)
	if err != nil {
		var he *tunnel.HTTPError
		if errors.As(err, &he) && he.Status == 404 {
			return fail(&verdict{phase: execution.PhaseStale, reason: "proposal_withdrawn", message: err.Error()})
		}
		// 中心不可用：留在队列中，稍后再试
		e.requeue(x)
		return fmt.Errorf("binding recheck: %w", err)
	}
	e.observeHub(b.HubClock)
	if b.State != tunnel.BindingCurrent || b.IncidentVersion != x.Spec.Incident.Version || b.RootComponent != x.Spec.Incident.RootComponent ||
		b.EvidenceFingerprint != x.Spec.Incident.EvidenceFingerprint {
		return fail(&verdict{phase: execution.PhaseStale, reason: "binding_changed", message: fmt.Sprintf("hub binding %s v%d %s", b.State, b.IncidentVersion, b.RootComponent)})
	}
	if issued := e.issuedAt(x); !e.restoreMarker().IsZero() && !issued.After(e.restoreMarker()) {
		return fail(reject(assertion.ErrIssuedBeforeRestore, "", "issued %s, restore marker %s", issued, e.restoreMarker()))
	}
	act, _ := e.d.Catalog.Get(x.Spec.Action)
	ex := e.d.Executors[x.Spec.Action]
	res, err := ex.Resolve(ctx, x.Spec.Params.Raw)
	if errors.Is(err, executor.ErrTargetNotFound) {
		return fail(&verdict{phase: execution.PhaseStale, reason: "target_not_found", message: err.Error()})
	}
	if err != nil {
		return fail(&verdict{phase: execution.PhaseFailed, reason: "resolve_error", message: err.Error()})
	}
	if res.Target.UID != x.Spec.Target.UID {
		return fail(&verdict{phase: execution.PhaseStale, reason: "target_changed", message: "target uid is now " + res.Target.UID})
	}
	level, tier, _ := e.requiredLevel(act, res)
	if level != x.Spec.Level {
		return fail(reject("level_changed", tunnel.RequiresReapproval, "target now requires level %s, approved %s", level, x.Spec.Level))
	}
	if assertion.TierRank(x.Spec.Tier) < assertion.TierRank(tier) {
		return fail(reject("tier_too_low", tunnel.RequiresTierH, "target now requires tier %s", tier))
	}
	if !res.Passed() {
		return fail(reject("precheck_failed", "", "%s", res.Failed()))
	}
	snap := res.Snapshot
	if snap == nil {
		snap = map[string]any{}
	}
	snap[executor.SnapshotResourceVersion] = res.ResourceVersion
	raw, err := json.Marshal(snap)
	if err != nil {
		return err
	}
	if _, err := e.transition(ctx, id, tr{phase: execution.PhasePrechecked, reason: "prechecks_passed", mutate: func(s *execution.Status) {
		s.Prechecks, s.EffectiveLevel, s.BlastRadius, s.Snapshot = res.Prechecks, level, res.BlastRadius, &runtime.RawExtension{Raw: raw}
	}}); err != nil {
		return err
	}
	holder, err := e.IsLeaseHolder(ctx)
	if err != nil || !holder {
		return fmt.Errorf("not the lease holder before executing %s: %v", id, err)
	}
	attempt := uuid.NewString()
	x, err = e.transition(ctx, id, tr{phase: execution.PhaseExecuting, reason: "started", mutate: func(s *execution.Status) {
		s.AttemptID, s.Holder = attempt, e.cfg.Identity
	}})
	if err != nil {
		return err
	}
	e.fault("executing_written", id)
	execErr := ex.Execute(ctx, e.execContext(x, snap))
	if execErr != nil {
		return e.executeFailed(ctx, x, snap, execErr)
	}
	e.fault("side_effect_done", id)
	return e.enterVerify(ctx, id, act, "executed")
}

func (e *Engine) fault(point, id string) {
	if e.cfg.Fault != nil {
		e.cfg.Fault(point, id)
	}
}

func (e *Engine) issuedAt(x *execution.ActionExecution) time.Time {
	var env struct {
		Assertion struct {
			IssuedAt string `json:"issued_at"`
		} `json:"assertion"`
	}
	if json.Unmarshal([]byte(x.Spec.Envelope), &env) != nil {
		return time.Time{}
	}
	t, _ := assertion.ParseTime(env.Assertion.IssuedAt)
	return t
}

// requeue 在中心不可用时把执行放回队列，5 秒后再试。
func (e *Engine) requeue(x *execution.ActionExecution) {
	go func() {
		time.Sleep(5 * time.Second)
		if !e.stoppingNow() {
			e.q.add(x.Spec.ConflictDomain, x.Name)
			e.Wake()
		}
	}()
}

// executeFailed 处理副作用步骤的错误：前置条件冲突为 stale；被 PDB 拒绝为 failed；已经部分生效时转人工。
func (e *Engine) executeFailed(ctx context.Context, x *execution.ActionExecution, snap map[string]any, execErr error) error {
	id := x.Name
	if apierrors.IsConflict(execErr) || apierrors.IsInvalid(execErr) && strings.Contains(execErr.Error(), "test") {
		_, err := e.transition(ctx, id, tr{phase: execution.PhaseStale, reason: "resource_version_changed", message: execErr.Error()})
		return err
	}
	if errors.Is(execErr, kube.ErrEvictionBlocked) {
		_, err := e.transition(ctx, id, tr{phase: execution.PhaseFailed, reason: "pdb_blocked", message: execErr.Error()})
		return err
	}
	obs, detail, oerr := e.d.Executors[x.Spec.Action].Observe(ctx, e.execContext(x, snap))
	if oerr == nil && obs == executor.NotApplied {
		_, err := e.transition(ctx, id, tr{phase: execution.PhaseFailed, reason: "execute_error", message: execErr.Error()})
		return err
	}
	_, err := e.transition(ctx, id, tr{phase: execution.PhaseNeedsHuman, reason: "execute_error_after_side_effects",
		message: fmt.Sprintf("%v; observed: %s %v", execErr, detail, oerr)})
	return err
}

// enterVerify 写入 verifying 与持久化的校验截止时间，然后等待并校验。
func (e *Engine) enterVerify(ctx context.Context, id string, act *catalog.Action, reason string) error {
	now := metav1.NewTime(e.now())
	due := metav1.NewTime(now.Add(act.VerifyWindow()))
	x, err := e.transition(ctx, id, tr{phase: execution.PhaseVerifying, reason: reason, mutate: func(s *execution.Status) {
		if s.ExecutedAt == nil {
			s.ExecutedAt = &now
		}
		s.VerifyDueAt = &due
	}})
	if err != nil {
		return err
	}
	e.fault("verifying_written", id)
	return e.verifyPhase(ctx, x)
}

// recoverExecuting 是崩溃恢复：观察目标，已生效进入校验，未生效记为 failed，部分生效记为 indeterminate；从不重跑。
func (e *Engine) recoverExecuting(ctx context.Context, x *execution.ActionExecution) error {
	snap, err := snapshotMap(x)
	if err != nil {
		return err
	}
	obs, detail, err := e.d.Executors[x.Spec.Action].Observe(ctx, e.execContext(x, snap))
	if err != nil {
		_, terr := e.transition(ctx, x.Name, tr{phase: execution.PhaseIndeterminate, reason: "observe_error", message: err.Error()})
		return terr
	}
	switch obs {
	case executor.Applied:
		act, _ := e.d.Catalog.Get(x.Spec.Action)
		return e.enterVerify(ctx, x.Name, act, "recovered_applied")
	case executor.NotApplied:
		_, err := e.transition(ctx, x.Name, tr{phase: execution.PhaseFailed, reason: "interrupted_not_applied", message: detail})
		return err
	}
	_, err = e.transition(ctx, x.Name, tr{phase: execution.PhaseIndeterminate, reason: "interrupted_partial", message: detail})
	return err
}

// verifyPhase 等到持久化的截止时间后，用执行器的检查与参数中声明的 PromQL 条件校验。
func (e *Engine) verifyPhase(ctx context.Context, x *execution.ActionExecution) error {
	if x.Status.VerifyDueAt == nil {
		return fmt.Errorf("execution %s is verifying without a deadline", x.Name)
	}
	if wait := x.Status.VerifyDueAt.Time.Sub(e.now()); wait > 0 {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-e.d.Clock.After(wait):
		}
	}
	act, _ := e.d.Catalog.Get(x.Spec.Action)
	snap, err := snapshotMap(x)
	if err != nil {
		return err
	}
	checks, err := e.d.Executors[x.Spec.Action].Verify(ctx, e.execContext(x, snap))
	if err != nil {
		checks = []execution.CheckResult{{ID: "executor", Kind: "k8s", Passed: false, Detail: err.Error()}}
	}
	conds, err := e.d.Catalog.ValidateParams(act, x.Spec.Params.Raw)
	if err != nil {
		return err
	}
	for _, c := range conds {
		r, err := e.d.Verify.Evaluate(ctx, c, e.now())
		if err != nil {
			checks = append(checks, execution.CheckResult{ID: c.ID, Kind: "promql", Passed: false, Detail: err.Error()})
			continue
		}
		checks = append(checks, execution.CheckResult{ID: c.ID, Kind: "promql", Passed: r.Passed, Detail: r.Detail})
	}
	passed := true
	var failed []string
	for _, c := range checks {
		res := "pass"
		if !c.Passed {
			passed, res = false, "fail"
			failed = append(failed, c.ID+": "+c.Detail)
		}
		e.d.Metrics.VerifyConditions.WithLabelValues(x.Spec.Action, c.Kind, res).Inc()
	}
	ver := &execution.Verification{Passed: passed, Checks: checks}
	if passed {
		_, err := e.transition(ctx, x.Name, tr{phase: execution.PhaseVerified, reason: "checks_passed", mutate: func(s *execution.Status) { s.Verification = ver }})
		return err
	}
	x, err = e.transition(ctx, x.Name, tr{phase: execution.PhaseVerifyFailed, reason: "checks_failed", message: strings.Join(failed, "; "),
		mutate: func(s *execution.Status) { s.Verification = ver }})
	if err != nil {
		return err
	}
	return e.afterVerifyFailed(ctx, x)
}

// afterVerifyFailed 按执行时的等级处理校验失败：reversible 自动恢复原状态；compensable 给出补偿，等待再次审批；
// 其余转人工（DESIGN §9.4）。
func (e *Engine) afterVerifyFailed(ctx context.Context, x *execution.ActionExecution) error {
	snap, err := snapshotMap(x)
	if err != nil {
		return err
	}
	ex := e.d.Executors[x.Spec.Action]
	switch x.Status.EffectiveLevel {
	case assertion.LevelReversible:
		if x.Status.Undo != nil && x.Status.Undo.StartedAt != nil && x.Status.Undo.FinishedAt == nil {
			_, err := e.transition(ctx, x.Name, tr{phase: execution.PhaseNeedsHuman, reason: "undo_interrupted", message: "undo started before a restart"})
			return err
		}
		started := metav1.NewTime(e.now())
		attempt := uuid.NewString()
		x, err = e.update(ctx, x.Name, func(s *execution.Status) { s.Undo = &execution.Undo{AttemptID: attempt, StartedAt: &started} })
		if err != nil {
			return err
		}
		detail, uerr := ex.Undo(ctx, e.execContext(x, snap))
		finished := metav1.NewTime(e.now())
		if uerr != nil {
			_, err := e.transition(ctx, x.Name, tr{phase: execution.PhaseNeedsHuman, reason: "undo_failed", message: uerr.Error(),
				mutate: func(s *execution.Status) { s.Undo.FinishedAt, s.Undo.Detail = &finished, uerr.Error() }})
			return err
		}
		_, err = e.transition(ctx, x.Name, tr{phase: execution.PhaseReverted, reason: "undone", message: detail,
			mutate: func(s *execution.Status) { s.Undo.FinishedAt, s.Undo.Detail = &finished, detail }})
		return err
	case assertion.LevelCompensable:
		comp := ex.Compensation(e.execContext(x, snap))
		_, err := e.transition(ctx, x.Name, tr{phase: execution.PhaseAwaitingCompensationApproval, reason: "compensation_proposed",
			mutate: func(s *execution.Status) { s.Compensation = comp }})
		return err
	}
	_, err = e.transition(ctx, x.Name, tr{phase: execution.PhaseNeedsHuman, reason: "verify_failed_" + x.Status.EffectiveLevel,
		message: "post-execution checks failed and the action cannot be undone automatically"})
	return err
}

// recover 在成为主实例时从 ActionExecution 重建冲突域队列，并继续中断的执行（观察而不重跑）。
func (e *Engine) recover(work context.Context) error {
	list, err := e.store.List(work)
	if err != nil {
		return err
	}
	for _, x := range list {
		switch x.Status.Phase {
		case execution.PhasePulled, execution.PhasePrechecked:
			e.q.add(x.Spec.ConflictDomain, x.Name)
		case execution.PhaseExecuting, execution.PhaseVerifying, execution.PhaseVerifyFailed:
			e.q.setActive(x.Spec.ConflictDomain, x.Name)
			e.start(work, x.Name)
		case "":
			// 创建之后、写入 pulled 之前中断：没有任何检查结果，记为 rejected 推回中心，由中心决定是否重新审批
			if _, err := e.transition(work, x.Name, tr{phase: execution.PhaseRejected, reason: "interrupted_before_pulled"}); err != nil {
				return err
			}
		}
	}
	return nil
}

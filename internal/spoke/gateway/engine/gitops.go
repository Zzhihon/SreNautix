package engine

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"time"

	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/executor"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/github"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/metrics"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/policy"
)

// GitOnlyAction 是唯一不写集群的动作。冻结只约束集群写入（ADR 0025）：冻结期间 gateway 仍然执行它，其余动作一律不执行。
const GitOnlyAction = "gitops_pr"

// watchState 是一个仓库的 main watchdog 状态。
type watchState struct {
	checked   time.Time            // 最近一次成功检查的时间（墙上时钟）
	seen      map[string]time.Time // 已判定过的提交 → 判定时间
	unexpect  map[string]unexpectedCommit
	lastError error
}

type unexpectedCommit struct {
	github.UnexpectedCommit
	found time.Time
}

// watchMain 是 main watchdog（ADR 0025）：按策略的间隔检查每个仓库 base 分支上回看窗口内的提交，
// 机器人直接写入或由机器人合并的提交计入 srenautix_git_main_unexpected_commits，条件 GitMainWatchdog 为 False，
// gitops_pr 的预检 main_watchdog 随之失败。
func (e *Engine) watchMain(ctx context.Context) {
	pol := e.currentPolicy()
	if _, ok := pol.Action(GitOnlyAction); !ok || pol.GitOps == nil {
		e.mu.Lock()
		e.watch = map[string]*watchState{}
		e.mu.Unlock()
		return
	}
	if e.d.GitHub == nil {
		e.setCondition(metrics.ConditionGitMainWatchdog, false, "not_configured", "gitops_pr is enabled without a GitHub App")
		return
	}
	g := pol.GitOps
	for _, entry := range g.Repositories {
		_, _ = e.watchRepo(ctx, pol, entry.Repository, entry.Base)
	}
	e.updateWatchCondition(e.watchStaleAfter())
}

// watchRepo 在距上一次成功检查已满一个间隔（或从未检查过）时检查一次仓库，返回检查之后的状态，
// 以及状态是否新鲜（上一次成功检查不满一个间隔，或这一次检查成功）。
// 周期检查与 gitops_pr 的预检共用这一个入口，检查串行进行，同一个提交只判定、计数一次。
func (e *Engine) watchRepo(ctx context.Context, pol *policy.Policy, repository, base string) (*watchState, bool) {
	e.watchMu.Lock()
	defer e.watchMu.Unlock()
	g := pol.GitOps
	now := time.Now()
	e.mu.Lock()
	st, ok := e.watch[repository]
	if !ok {
		st = &watchState{seen: map[string]time.Time{}, unexpect: map[string]unexpectedCommit{}}
		e.watch[repository] = st
	}
	due := st.checked.IsZero() || now.Sub(st.checked) >= g.WatchdogInterval()
	e.mu.Unlock()
	if !due {
		return st, true
	}
	wd := github.Watchdog{AppBot: e.d.GitHub.BotLogin(), AllowedBots: g.MainWatchdog.AllowedBots}
	err := e.checkRepo(ctx, wd, repository, base, st, now, g.WatchdogLookback())
	e.mu.Lock()
	st.lastError = err
	if err == nil {
		st.checked = now
	}
	e.mu.Unlock()
	if err != nil {
		e.d.Metrics.MainWatchdogFailures.WithLabelValues(repository).Inc()
		slog.Error("main watchdog", "repository", repository, "err", err)
		return st, false
	}
	e.d.Metrics.MainWatchdogLast.WithLabelValues(repository).Set(float64(now.Unix()))
	return st, true
}

// watchStaleAfter 是条件 GitMainWatchdog 判定"检查过期"的时长：周期检查随安全检查运行，
// 实际间隔不短于安全检查的周期，因此取 3 倍的 max(watchdog 间隔, 安全检查周期)。
func (e *Engine) watchStaleAfter() time.Duration {
	interval := 5 * time.Minute
	if pol := e.currentPolicy(); pol.GitOps != nil {
		interval = pol.GitOps.WatchdogInterval()
	}
	return 3 * max(interval, e.cfg.SafetyInterval)
}

func (e *Engine) checkRepo(ctx context.Context, wd github.Watchdog, repository, base string, st *watchState, now time.Time, lookback time.Duration) error {
	r, err := e.d.GitHub.Repo(repository)
	if err != nil {
		return err
	}
	since := now.Add(-lookback)
	if !st.checked.IsZero() && st.checked.Add(-10*time.Minute).After(since) {
		// 与上一次检查重叠 10 分钟，覆盖提交时间早于推送时间的提交
		since = st.checked.Add(-10 * time.Minute)
	}
	commits, err := r.Commits(ctx, base, since)
	if err != nil {
		return err
	}
	for _, c := range commits {
		e.mu.Lock()
		_, done := st.seen[c.SHA]
		e.mu.Unlock()
		if done {
			continue
		}
		u, err := wd.Classify(ctx, r, c)
		if err != nil {
			return err
		}
		e.mu.Lock()
		st.seen[c.SHA] = now
		if u != nil {
			st.unexpect[c.SHA] = unexpectedCommit{UnexpectedCommit: *u, found: now}
		}
		e.mu.Unlock()
		if u != nil {
			e.d.Metrics.MainUnexpected.WithLabelValues(repository, u.Actor).Inc()
			slog.Error("main watchdog found a commit not made by a person", "repository", repository, "base", base, "sha", u.SHA,
				"actor", u.Actor, "why", u.Why)
		}
	}
	e.mu.Lock()
	for sha, t := range st.seen {
		if now.Sub(t) > lookback {
			delete(st.seen, sha)
		}
	}
	for sha, u := range st.unexpect {
		if now.Sub(u.found) > lookback {
			delete(st.unexpect, sha)
		}
	}
	n := len(st.unexpect)
	e.mu.Unlock()
	e.d.Metrics.MainUnexpectedNow.WithLabelValues(repository).Set(float64(n))
	return nil
}

func (e *Engine) updateWatchCondition(staleAfter time.Duration) {
	var bad, stale []string
	e.mu.Lock()
	repos := make([]string, 0, len(e.watch))
	for r := range e.watch {
		repos = append(repos, r)
	}
	sort.Strings(repos)
	for _, r := range repos {
		st := e.watch[r]
		for _, u := range st.unexpect {
			bad = append(bad, fmt.Sprintf("%s %s (%s: %s)", r, u.SHA, u.Actor, u.Why))
		}
		if st.checked.IsZero() || time.Since(st.checked) > staleAfter {
			stale = append(stale, fmt.Sprintf("%s: %v", r, st.lastError))
		}
	}
	e.mu.Unlock()
	sort.Strings(bad)
	switch {
	case len(bad) > 0:
		e.setCondition(metrics.ConditionGitMainWatchdog, false, "unexpected_commits", strings.Join(bad, "; "))
	case len(stale) > 0:
		e.setCondition(metrics.ConditionGitMainWatchdog, false, "check_failed", strings.Join(stale, "; "))
	default:
		e.setCondition(metrics.ConditionGitMainWatchdog, true, "no_unexpected_commits", "")
	}
}

// MainWatchdog 是 gitops_pr 的预检 main_watchdog：距上一次成功检查已满一个间隔（或从未检查过）时先当场检查一次，
// 判定总是基于不早于一个间隔的检查结果，不依赖周期检查的时机。当场检查失败，或回看窗口内有非人工提交时拒绝。
func (e *Engine) MainWatchdog(ctx context.Context, repository string) (bool, string) {
	pol := e.currentPolicy()
	if pol.GitOps == nil || e.d.GitHub == nil {
		return false, "gitops_pr 没有配置 GitHub App 或 gitops 设置"
	}
	entry, ok := pol.Repo(repository)
	if !ok {
		return false, repository + " 不在 gateway 策略中"
	}
	st, fresh := e.watchRepo(ctx, pol, entry.Repository, entry.Base)
	e.mu.Lock()
	defer e.mu.Unlock()
	if !fresh {
		return false, fmt.Sprintf("main watchdog 检查 %s 失败：%v", repository, st.lastError)
	}
	if n := len(st.unexpect); n > 0 {
		var shas []string
		for sha, u := range st.unexpect {
			shas = append(shas, sha+" "+u.Actor)
		}
		sort.Strings(shas)
		return false, fmt.Sprintf("回看窗口内有 %d 个非人工提交：%s", n, strings.Join(shas, ", "))
	}
	return true, "回看窗口内没有非人工提交"
}

// gitopsPRsLastHour 返回仓库在最近一小时内开出 PR 的 gitops_pr 执行数（按进入 verifying 的时间，即推送与开 PR 完成的时间）。
func (e *Engine) gitopsPRsLastHour(ctx context.Context, repository string) (int, error) {
	list, err := e.store.List(ctx)
	if err != nil {
		return 0, err
	}
	since := e.now().Add(-time.Hour)
	n := 0
	for _, x := range list {
		if x.Spec.Action != GitOnlyAction || x.Status.ExecutedAt == nil || !x.Status.ExecutedAt.Time.After(since) {
			continue
		}
		if r, err := executor.GitOpsRepository(x.Spec.Params.Raw); err == nil && r == repository {
			n++
		}
	}
	return n, nil
}

// gitopsRateLimit 是按小时限速（ADR 0025）：返回非 nil 表示拒绝。
func (e *Engine) gitopsRateLimit(ctx context.Context, params json.RawMessage) *verdict {
	repository, err := executor.GitOpsRepository(params)
	if err != nil {
		return reject("invalid_params", "", "%v", err)
	}
	pol := e.currentPolicy()
	if pol.GitOps == nil {
		return reject("action_not_enabled", "", "gitops is not configured")
	}
	n, err := e.gitopsPRsLastHour(ctx, repository)
	if err != nil {
		return reject("gitops_rate_unavailable", "", "%v", err)
	}
	if limit := pol.GitOps.PRsPerHour(); n >= limit {
		e.d.Metrics.GitOpsRateLimited.WithLabelValues(repository).Inc()
		return reject("gitops_rate_limited", "", "%d pull requests opened in %s in the last hour, cap %d", n, repository, limit)
	}
	return nil
}

// probeGitBase 在启用 gitops_pr 时探测白名单中每个仓库的 base 分支（不变量 12）：有分支保护，或策略登记了经批准的补偿控制。
// 都没有时条件 GitBaseGuarded 为 False，gitops_pr 的预检 base_guarded 拒绝执行；不影响其他动作。
func (e *Engine) probeGitBase(ctx context.Context) {
	pol := e.currentPolicy()
	if _, ok := pol.Action(GitOnlyAction); !ok {
		return
	}
	if e.d.GitHub == nil {
		e.setCondition(metrics.ConditionGitBaseGuarded, false, "not_configured", "gitops_pr is enabled without a GitHub App")
		return
	}
	var unguarded, compensated []string
	for _, r := range pol.GitOps.Repositories {
		repo, err := e.d.GitHub.Repo(r.Repository)
		if err != nil {
			e.setCondition(metrics.ConditionGitBaseGuarded, false, "probe_failed", err.Error())
			return
		}
		ok, err := repo.Protected(ctx, r.Base)
		if err != nil {
			e.setCondition(metrics.ConditionGitBaseGuarded, false, "probe_failed", err.Error())
			return
		}
		switch {
		case ok:
		case r.CompensatingControls != nil:
			compensated = append(compensated, r.Repository+"@"+r.Base)
		default:
			unguarded = append(unguarded, r.Repository+"@"+r.Base)
		}
	}
	switch {
	case len(unguarded) > 0:
		e.setCondition(metrics.ConditionGitBaseGuarded, false, "unguarded", strings.Join(unguarded, ", "))
	case len(compensated) > 0:
		e.setCondition(metrics.ConditionGitBaseGuarded, true, "compensating_controls", strings.Join(compensated, ", "))
	default:
		e.setCondition(metrics.ConditionGitBaseGuarded, true, "protected", "")
	}
}

// acceptedActions 返回只提议时仍然执行的动作（冻结是唯一原因且启用了 gitops_pr 时为 [gitops_pr]）。
func (e *Engine) acceptedActions() []string {
	e.mu.Lock()
	defer e.mu.Unlock()
	if !e.leader {
		return nil
	}
	return append([]string(nil), e.accepts...)
}

// Accepts 表示当前可以执行 action：不在只提议状态，或者只提议的唯一原因是冻结而 action 不写集群。
func (e *Engine) Accepts(action string) bool {
	if !e.ProposeOnly() {
		return true
	}
	for _, a := range e.acceptedActions() {
		if a == action {
			return true
		}
	}
	return false
}

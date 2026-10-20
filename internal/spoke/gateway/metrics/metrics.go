// Package metrics 定义 gateway 导出的 Prometheus 指标（srenautix_ 前缀，名称与 chart 的 PrometheusRule、看板一致）。
package metrics

import "github.com/prometheus/client_golang/prometheus"

// 条件类型（DESIGN §12.4，与工单协议 Heartbeat.conditions 相同）。
const (
	ConditionAdmissionSelfCheck = "AdmissionSelfCheck"
	ConditionFreeze             = "Freeze"
	ConditionAuditSink          = "AuditSink"
	ConditionClockSkew          = "ClockSkew"
	ConditionLeader             = "Leader"
	ConditionApiserverThrottled = "ApiserverThrottled"
	// ConditionGitBaseGuarded：启用 gitops_pr 时，每个仓库的 base 分支有分支保护或登记了经批准的补偿控制（不变量 12）
	ConditionGitBaseGuarded = "GitBaseGuarded"
	// ConditionGitMainWatchdog：回看窗口内 base 分支上没有非人工提交
	ConditionGitMainWatchdog = "GitMainWatchdog"
	ConditionPolicyLoaded    = "PolicyLoaded"
)

// Metrics 是 gateway 的指标。
type Metrics struct {
	Registry         *prometheus.Registry
	BuildInfo        *prometheus.GaugeVec
	Condition        *prometheus.GaugeVec
	SelfCheckOK      prometheus.Gauge
	Frozen           prometheus.Gauge
	ProposeOnly      prometheus.Gauge
	Executions       *prometheus.CounterVec
	NeedsHuman       prometheus.Gauge
	AuditExportLag   *prometheus.GaugeVec
	ClockSkew        *prometheus.GaugeVec
	TicketsRejected  *prometheus.CounterVec
	QueueDepth       prometheus.Gauge
	VerifyConditions *prometheus.CounterVec

	// gitops_pr 的补偿控制（ADR 0025）
	GitOpsPushes         *prometheus.CounterVec
	GitOpsPullRequests   *prometheus.CounterVec
	GitOpsRateLimited    *prometheus.CounterVec
	GitOpsDenied         *prometheus.CounterVec
	MainUnexpected       *prometheus.CounterVec
	MainUnexpectedNow    *prometheus.GaugeVec
	MainWatchdogLast     *prometheus.GaugeVec
	MainWatchdogFailures *prometheus.CounterVec
}

// New 创建并注册全部指标。
func New(version string) *Metrics {
	r := prometheus.NewRegistry()
	m := &Metrics{
		Registry:         r,
		BuildInfo:        prometheus.NewGaugeVec(prometheus.GaugeOpts{Name: "srenautix_build_info", Help: "Build information."}, []string{"role", "version"}),
		Condition:        prometheus.NewGaugeVec(prometheus.GaugeOpts{Name: "srenautix_condition", Help: "1 when the typed status condition holds."}, []string{"role", "type"}),
		SelfCheckOK:      prometheus.NewGauge(prometheus.GaugeOpts{Name: "srenautix_admission_selfcheck_ok", Help: "1 when every enabled admission policy denied its dry-run probe."}),
		Frozen:           prometheus.NewGauge(prometheus.GaugeOpts{Name: "srenautix_gateway_frozen", Help: "1 when srenautix-freeze is frozen or missing."}),
		ProposeOnly:      prometheus.NewGauge(prometheus.GaugeOpts{Name: "srenautix_gateway_propose_only", Help: "1 when the gateway claims no new executions."}),
		Executions:       prometheus.NewCounterVec(prometheus.CounterOpts{Name: "srenautix_gateway_executions_total", Help: "Executions that reached a phase."}, []string{"action", "phase"}),
		NeedsHuman:       prometheus.NewGauge(prometheus.GaugeOpts{Name: "srenautix_gateway_needs_human", Help: "Executions in needs_human or indeterminate."}),
		AuditExportLag:   prometheus.NewGaugeVec(prometheus.GaugeOpts{Name: "srenautix_audit_export_lag_seconds", Help: "Age of the oldest audit record not yet written to the sink."}, []string{"chain"}),
		ClockSkew:        prometheus.NewGaugeVec(prometheus.GaugeOpts{Name: "srenautix_clock_skew_seconds", Help: "Local clock minus peer clock."}, []string{"peer"}),
		TicketsRejected:  prometheus.NewCounterVec(prometheus.CounterOpts{Name: "srenautix_gateway_tickets_rejected_total", Help: "Tickets rejected before execution."}, []string{"reason"}),
		QueueDepth:       prometheus.NewGauge(prometheus.GaugeOpts{Name: "srenautix_gateway_queue_depth", Help: "Executions waiting in conflict-domain queues."}),
		VerifyConditions: prometheus.NewCounterVec(prometheus.CounterOpts{Name: "srenautix_gateway_verify_checks_total", Help: "Post-execution checks by result."}, []string{"action", "kind", "result"}),

		GitOpsPushes: prometheus.NewCounterVec(prometheus.CounterOpts{Name: "srenautix_gitops_pushes_total",
			Help: "srenautix/ branch pushes by result: ok, base_moved (base changed between the checks before and after the push; no pull request was opened) or error."}, []string{"repo", "result"}),
		GitOpsPullRequests: prometheus.NewCounterVec(prometheus.CounterOpts{Name: "srenautix_gitops_pull_requests_total",
			Help: "Pull requests opened by gitops_pr, by result."}, []string{"repo", "result"}),
		GitOpsRateLimited: prometheus.NewCounterVec(prometheus.CounterOpts{Name: "srenautix_gitops_rate_limited_total",
			Help: "gitops_pr executions rejected by the hourly pull request cap."}, []string{"repo"}),
		GitOpsDenied: prometheus.NewCounterVec(prometheus.CounterOpts{Name: "srenautix_gitops_denied_requests_total",
			Help: "GitHub requests stopped by the request allowlist before they were sent."}, []string{"reason"}),
		MainUnexpected: prometheus.NewCounterVec(prometheus.CounterOpts{Name: "srenautix_git_main_unexpected_commits_total",
			Help: "Commits on the base branch written or merged by a bot, found by the main watchdog."}, []string{"repo", "actor"}),
		MainUnexpectedNow: prometheus.NewGaugeVec(prometheus.GaugeOpts{Name: "srenautix_git_main_unexpected_commits",
			Help: "Commits on the base branch written or merged by a bot within the watchdog lookback window."}, []string{"repo"}),
		MainWatchdogLast: prometheus.NewGaugeVec(prometheus.GaugeOpts{Name: "srenautix_git_main_watchdog_last_check_timestamp_seconds",
			Help: "Time of the last successful main watchdog check."}, []string{"repo"}),
		MainWatchdogFailures: prometheus.NewCounterVec(prometheus.CounterOpts{Name: "srenautix_git_main_watchdog_errors_total",
			Help: "Failed main watchdog checks."}, []string{"repo"}),
	}
	r.MustRegister(m.BuildInfo, m.Condition, m.SelfCheckOK, m.Frozen, m.ProposeOnly, m.Executions, m.NeedsHuman,
		m.AuditExportLag, m.ClockSkew, m.TicketsRejected, m.QueueDepth, m.VerifyConditions,
		m.GitOpsPushes, m.GitOpsPullRequests, m.GitOpsRateLimited, m.GitOpsDenied, m.MainUnexpected, m.MainUnexpectedNow,
		m.MainWatchdogLast, m.MainWatchdogFailures)
	m.BuildInfo.WithLabelValues("gateway", version).Set(1)
	return m
}

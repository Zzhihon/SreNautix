// Package metrics 定义 gateway 导出的 Prometheus 指标（srenautix_ 前缀，名称与 chart 的 PrometheusRule、看板一致）。
package metrics

import "github.com/prometheus/client_golang/prometheus"

// 条件类型（DESIGN §12.4，与工单协议 Heartbeat.conditions 相同）。
const (
	ConditionAdmissionSelfCheck     = "AdmissionSelfCheck"
	ConditionFreeze                 = "Freeze"
	ConditionAuditSink              = "AuditSink"
	ConditionClockSkew              = "ClockSkew"
	ConditionLeader                 = "Leader"
	ConditionApiserverThrottled     = "ApiserverThrottled"
	ConditionGitHubBranchProtection = "GitHubBranchProtection"
	ConditionPolicyLoaded           = "PolicyLoaded"
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
	}
	r.MustRegister(m.BuildInfo, m.Condition, m.SelfCheckOK, m.Frozen, m.ProposeOnly, m.Executions, m.NeedsHuman,
		m.AuditExportLag, m.ClockSkew, m.TicketsRejected, m.QueueDepth, m.VerifyConditions)
	m.BuildInfo.WithLabelValues("gateway", version).Set(1)
	return m
}

// Package alerts 为多集群模式生成告警对账快照（DESIGN §3.1）：每 60 秒读取本集群 Alertmanager v2 的 GET /api/v2/alerts，
// 以及本地指标后端中的 ALERTS / ALERTS_FOR_STATE，原样推送给中心；中心据此与 webhook 接入的告警对账，PG 恢复后也从这里重建活动告警。
package alerts

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/common/config"

	"github.com/Zzhihon/SreNautix/internal/spoke/reader/query"
)

// Config 是对账的数据来源。
type Config struct {
	// AlertmanagerURL 为空时快照里不含 Alertmanager 部分
	AlertmanagerURL  string                  `json:"alertmanager_url"`
	AlertmanagerHTTP config.HTTPClientConfig `json:"alertmanager_http"`
	// MetricsDatasource 是执行 ALERTS 查询的数据源名；为空时快照里不含规则部分
	MetricsDatasource string `json:"metrics_datasource"`
	// MaxAlerts 限制每部分的告警条数
	MaxAlerts int `json:"max_alerts"`
	// MaxBytes 限制 Alertmanager 响应体大小
	MaxBytes int64 `json:"max_bytes"`
}

// AMStatus 是 Alertmanager 报告的告警状态。
type AMStatus struct {
	State       string   `json:"state"`
	SilencedBy  []string `json:"silencedBy"`
	InhibitedBy []string `json:"inhibitedBy"`
}

// AMAlert 是 Alertmanager v2 gettableAlert 中对账需要的字段。
type AMAlert struct {
	Fingerprint  string            `json:"fingerprint"`
	Labels       map[string]string `json:"labels"`
	Annotations  map[string]string `json:"annotations"`
	StartsAt     time.Time         `json:"startsAt"`
	EndsAt       time.Time         `json:"endsAt"`
	UpdatedAt    time.Time         `json:"updatedAt"`
	GeneratorURL string            `json:"generatorURL"`
	Status       AMStatus          `json:"status"`
}

// Part 是快照中一个来源的结果；读取失败时 Error 非空，中心对这个来源不做"已消失"的判断。
type Part[T any] struct {
	Status string `json:"status"`
	Error  string `json:"error,omitempty"`
	// Truncated 为 true 时条目被截断，中心同样不做"已消失"的判断
	Truncated bool `json:"truncated"`
	Items     []T  `json:"items"`
}

// RuleAlert 是 ALERTS 中的一条：标签（不含 __name__、alertstate）、状态，以及 ALERTS_FOR_STATE 给出的激活时间。
type RuleAlert struct {
	Labels   map[string]string `json:"labels"`
	State    string            `json:"state"`
	ActiveAt *time.Time        `json:"active_at"`
}

// Snapshot 是一次对账快照。TakenAt 是 apiserver 参考时间。
type Snapshot struct {
	ClusterID    string           `json:"cluster_id"`
	TakenAt      time.Time        `json:"taken_at"`
	Alertmanager *Part[AMAlert]   `json:"alertmanager"`
	Rules        *Part[RuleAlert] `json:"rules"`
}

// Reconciler 生成对账快照。
type Reconciler struct {
	cfg     Config
	cluster string
	am      *http.Client
	exec    *query.Executor
	now     func() time.Time
	total   *prometheus.CounterVec
	count   *prometheus.GaugeVec
}

// New 创建 Reconciler。
func New(cfg Config, clusterID string, exec *query.Executor, now func() time.Time, reg prometheus.Registerer) (*Reconciler, error) {
	r := &Reconciler{cfg: cfg, cluster: clusterID, exec: exec, now: now,
		total: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "srenautix_reader_alert_reconcile_total", Help: "告警对账读取次数，按来源和结果。"}, []string{"source", "result"}),
		count: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "srenautix_reader_alert_reconcile_alerts", Help: "最近一次对账读到的告警数。"}, []string{"source"}),
	}
	reg.MustRegister(r.total, r.count)
	if cfg.AlertmanagerURL != "" {
		c, err := config.NewClientFromConfig(cfg.AlertmanagerHTTP, "srenautix-reader-alertmanager")
		if err != nil {
			return nil, fmt.Errorf("alerts: alertmanager http config: %w", err)
		}
		r.am = c
	}
	return r, nil
}

// Snapshot 读取全部来源并生成快照。
func (r *Reconciler) Snapshot(ctx context.Context) Snapshot {
	s := Snapshot{ClusterID: r.cluster, TakenAt: r.now().UTC()}
	if r.am != nil {
		p := r.alertmanager(ctx)
		s.Alertmanager = &p
		r.record("alertmanager", p.Status, len(p.Items))
	}
	if r.cfg.MetricsDatasource != "" {
		p := r.rules(ctx)
		s.Rules = &p
		r.record("rules", p.Status, len(p.Items))
	}
	return s
}

func (r *Reconciler) record(source, status string, n int) {
	r.total.WithLabelValues(source, status).Inc()
	if status == "ok" {
		r.count.WithLabelValues(source).Set(float64(n))
	}
}

func (r *Reconciler) alertmanager(ctx context.Context) Part[AMAlert] {
	u, err := url.Parse(r.cfg.AlertmanagerURL)
	if err != nil {
		return Part[AMAlert]{Status: "error", Error: err.Error(), Items: []AMAlert{}}
	}
	u = u.JoinPath("api", "v2", "alerts")
	q := u.Query()
	for _, k := range []string{"active", "silenced", "inhibited", "unprocessed"} {
		q.Set(k, "true")
	}
	u.RawQuery = q.Encode()
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return Part[AMAlert]{Status: "error", Error: err.Error(), Items: []AMAlert{}}
	}
	resp, err := r.am.Do(req)
	if err != nil {
		return Part[AMAlert]{Status: "error", Error: err.Error(), Items: []AMAlert{}}
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return Part[AMAlert]{Status: "error", Error: fmt.Sprintf("GET %s: status %d", u.Path, resp.StatusCode), Items: []AMAlert{}}
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, r.cfg.MaxBytes+1))
	if err != nil {
		return Part[AMAlert]{Status: "error", Error: err.Error(), Items: []AMAlert{}}
	}
	if int64(len(body)) > r.cfg.MaxBytes {
		return Part[AMAlert]{Status: "error", Error: fmt.Sprintf("alertmanager response exceeds %d bytes", r.cfg.MaxBytes), Items: []AMAlert{}}
	}
	var list []AMAlert
	if err := json.Unmarshal(body, &list); err != nil {
		return Part[AMAlert]{Status: "error", Error: "decode alertmanager response: " + err.Error(), Items: []AMAlert{}}
	}
	sort.Slice(list, func(i, j int) bool { return list[i].Fingerprint < list[j].Fingerprint })
	p := Part[AMAlert]{Status: "ok", Items: list}
	if len(list) > r.cfg.MaxAlerts {
		p.Items = list[:r.cfg.MaxAlerts]
		p.Truncated = true
	}
	return p
}

func ruleKey(l map[string]string) string {
	keys := make([]string, 0, len(l))
	for k := range l {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := ""
	for _, k := range keys {
		out += k + "\xff" + l[k] + "\xff"
	}
	return out
}

func (r *Reconciler) rules(ctx context.Context) Part[RuleAlert] {
	limits := r.exec.Limits()
	limits.MaxSeries = r.cfg.MaxAlerts
	now := r.now()
	alerts := r.exec.Builtin(ctx, query.Request{RequestID: "reconcile-alerts", Datasource: r.cfg.MetricsDatasource, Time: &now}, "ALERTS", limits)
	if alerts.Error != nil {
		return Part[RuleAlert]{Status: "error", Error: alerts.Error.Error(), Items: []RuleAlert{}}
	}
	forState := r.exec.Builtin(ctx, query.Request{RequestID: "reconcile-for-state", Datasource: r.cfg.MetricsDatasource, Time: &now}, "ALERTS_FOR_STATE", limits)
	if forState.Error != nil {
		return Part[RuleAlert]{Status: "error", Error: forState.Error.Error(), Items: []RuleAlert{}}
	}
	active := map[string]time.Time{}
	for _, s := range forState.Series {
		l := map[string]string{}
		for k, v := range s.Labels {
			if k != "__name__" {
				l[k] = v
			}
		}
		// 取值无法解析的序列只是缺少 active_at，告警本身仍然上报
		if len(s.Samples) == 0 {
			continue
		}
		f, err := strconv.ParseFloat(s.Samples[len(s.Samples)-1].V, 64)
		if err != nil || math.IsNaN(f) || math.IsInf(f, 0) {
			continue
		}
		active[ruleKey(l)] = time.UnixMilli(int64(f * 1000)).UTC()
	}
	p := Part[RuleAlert]{Status: "ok", Truncated: alerts.Truncated || forState.Truncated, Items: []RuleAlert{}}
	for _, s := range alerts.Series {
		l := map[string]string{}
		for k, v := range s.Labels {
			if k != "__name__" && k != "alertstate" {
				l[k] = v
			}
		}
		ra := RuleAlert{Labels: l, State: s.Labels["alertstate"]}
		if t, ok := active[ruleKey(l)]; ok {
			ra.ActiveAt = &t
		}
		p.Items = append(p.Items, ra)
	}
	return p
}

// Run 每隔 every 生成一次快照交给 send，直到 ctx 结束。
func (r *Reconciler) Run(ctx context.Context, every time.Duration, send func(Snapshot)) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		send(r.Snapshot(ctx))
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

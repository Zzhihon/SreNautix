package reader

import (
	"fmt"
	"os"
	"time"

	"github.com/prometheus/common/model"
	"sigs.k8s.io/yaml"

	"github.com/Zzhihon/SreNautix/internal/spoke/reader/alerts"
	"github.com/Zzhihon/SreNautix/internal/spoke/reader/query"
)

// Duration 是配置文件中的 Prometheus 风格时长（例如 30s、5m）。
type Duration time.Duration

// UnmarshalJSON 解析时长文本。
func (d *Duration) UnmarshalJSON(b []byte) error {
	var s string
	if err := yaml.Unmarshal(b, &s); err != nil {
		return fmt.Errorf("duration must be a string: %w", err)
	}
	v, err := model.ParseDuration(s)
	if err != nil {
		return err
	}
	*d = Duration(v)
	return nil
}

// HubConfig 是到中心的连接设置。
type HubConfig struct {
	URL       string   `json:"url"`
	TokenFile string   `json:"token_file"`
	CAFile    string   `json:"ca_file"`
	Timeout   Duration `json:"timeout"`
}

// LimitsConfig 覆盖查询的默认限制；未填写的项取默认值。
type LimitsConfig struct {
	MaxRange        Duration `json:"max_range"`
	MinStep         Duration `json:"min_step"`
	MaxPoints       int      `json:"max_points"`
	MaxSeries       int      `json:"max_series"`
	MaxBytes        int64    `json:"max_bytes"`
	Timeout         Duration `json:"timeout"`
	Concurrency     int64    `json:"concurrency"`
	BreakerFailures uint32   `json:"breaker_failures"`
	BreakerWindow   Duration `json:"breaker_window"`
	BreakerOpenFor  Duration `json:"breaker_open_for"`
}

// AlertsConfig 是告警对账的设置。
type AlertsConfig struct {
	alerts.Config `json:",inline"`
	Interval      Duration `json:"interval"`
}

// HistoryConfig 是 kube-state-metrics 历史重建的设置。
type HistoryConfig struct {
	Datasource string   `json:"datasource"`
	Matchers   string   `json:"matchers"`
	Step       Duration `json:"step"`
	Chunk      Duration `json:"chunk"`
	MaxSeries  int      `json:"max_series"`
	MaxBytes   int64    `json:"max_bytes"`
	MaxWindow  Duration `json:"max_window"`
}

// Config 是 reader 的配置文件。
type Config struct {
	ClusterID string    `json:"cluster_id"`
	Listen    string    `json:"listen"`
	Hub       HubConfig `json:"hub"`
	// Kubeconfig 为空时使用 Pod 内的 ServiceAccount
	Kubeconfig    string             `json:"kubeconfig"`
	Datasources   []query.Datasource `json:"datasources"`
	QueryManifest string             `json:"query_manifest"`
	Limits        LimitsConfig       `json:"limits"`
	Alerts        *AlertsConfig      `json:"alerts"`
	History       *HistoryConfig     `json:"history"`
	// CRDRediscover 是重新发现自定义资源的间隔
	CRDRediscover Duration `json:"crd_rediscover"`
	// ClockInterval 是测量 apiserver 时钟偏差的间隔
	ClockInterval Duration `json:"clock_interval"`
	// HeartbeatInterval 是心跳间隔
	HeartbeatInterval Duration `json:"heartbeat_interval"`
	// RequestWorkers 是同时执行的读取请求数
	RequestWorkers int `json:"request_workers"`
}

func orDefault(d Duration, def time.Duration) time.Duration {
	if d == 0 {
		return def
	}
	return time.Duration(d)
}

// LoadConfig 读取并校验配置文件。
func LoadConfig(path string) (*Config, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var c Config
	if err := yaml.UnmarshalStrict(b, &c); err != nil {
		return nil, fmt.Errorf("reader config %s: %w", path, err)
	}
	if c.ClusterID == "" || c.Hub.URL == "" || c.Hub.TokenFile == "" {
		return nil, fmt.Errorf("reader config %s: cluster_id, hub.url and hub.token_file are required", path)
	}
	if c.Listen == "" {
		c.Listen = ":8080"
	}
	names := map[string]bool{}
	for _, d := range c.Datasources {
		names[d.Name] = true
	}
	if c.Alerts != nil && c.Alerts.MetricsDatasource != "" && !names[c.Alerts.MetricsDatasource] {
		return nil, fmt.Errorf("reader config %s: alerts.metrics_datasource %q is not in datasources", path, c.Alerts.MetricsDatasource)
	}
	if c.History != nil && !names[c.History.Datasource] {
		return nil, fmt.Errorf("reader config %s: history.datasource %q is not in datasources", path, c.History.Datasource)
	}
	return &c, nil
}

// limits 返回合并默认值后的查询限制。
func (c *Config) limits() query.Limits {
	l := query.DefaultLimits()
	l.MaxRange = orDefault(c.Limits.MaxRange, l.MaxRange)
	l.MinStep = orDefault(c.Limits.MinStep, l.MinStep)
	l.Timeout = orDefault(c.Limits.Timeout, l.Timeout)
	l.BreakerWindow = orDefault(c.Limits.BreakerWindow, l.BreakerWindow)
	l.BreakerOpenFor = orDefault(c.Limits.BreakerOpenFor, l.BreakerOpenFor)
	if c.Limits.MaxPoints > 0 {
		l.MaxPoints = c.Limits.MaxPoints
	}
	if c.Limits.MaxSeries > 0 {
		l.MaxSeries = c.Limits.MaxSeries
	}
	if c.Limits.MaxBytes > 0 {
		l.MaxBytes = c.Limits.MaxBytes
	}
	if c.Limits.Concurrency > 0 {
		l.Concurrency = c.Limits.Concurrency
	}
	if c.Limits.BreakerFailures > 0 {
		l.BreakerFailures = c.Limits.BreakerFailures
	}
	return l
}

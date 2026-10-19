// Package clock 以 apiserver 的时间为参考测量本地时钟偏差（DESIGN §3.1、§15.5）。
//
// apiserver 的每个响应都带 HTTP Date 头（精度 1 秒）。一次请求在本地时间 [t0, t1] 之间完成，Date 为 D，
// 说明这段时间内的某一刻 apiserver 的时间落在 [D, D+1s)，于是偏移量（apiserver − 本地）落在 [D−t1, D+1s−t0]。
// 在约 1.1 秒内等间隔取多个样本，Date 跳秒的位置会落在不同样本之间，各样本区间取交集后，精度约为采样间隔加往返时延。
package clock

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

const (
	samples  = 9
	interval = 125 * time.Millisecond
)

// Reading 是一次测量的结果。
type Reading struct {
	// Offset 是 apiserver 时间减去本地时间。
	Offset time.Duration `json:"offset_ns"`
	// Uncertainty 是 Offset 的半宽误差。
	Uncertainty time.Duration `json:"uncertainty_ns"`
	// MeasuredAt 是测量完成时的本地时间。
	MeasuredAt time.Time `json:"measured_at"`
}

// APIServer 定期测量与 apiserver 的时钟偏差，并按测得的偏移量给出 apiserver 参考时间。
type APIServer struct {
	client *http.Client
	url    string
	skew   prometheus.Gauge
	unc    prometheus.Gauge

	mu      sync.RWMutex
	reading *Reading
}

// New 创建测量器。client 必须带有访问 apiserver 的认证（例如 rest.HTTPClientFor 的结果），host 是 apiserver 地址。
func New(client *http.Client, host string, reg prometheus.Registerer) *APIServer {
	c := &APIServer{
		client: client,
		url:    strings.TrimRight(host, "/") + "/version",
		skew: prometheus.NewGauge(prometheus.GaugeOpts{
			Name:        "srenautix_clock_skew_seconds",
			Help:        "本地时钟减去对端时钟的差值（秒）。",
			ConstLabels: prometheus.Labels{"peer": "apiserver"},
		}),
		unc: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "srenautix_reader_clock_skew_uncertainty_seconds",
			Help: "与 apiserver 时钟偏差测量值的半宽误差（秒）。",
		}),
	}
	reg.MustRegister(c.skew, c.unc)
	return c
}

// Measure 进行一次测量并更新当前读数。
func (c *APIServer) Measure(ctx context.Context) (Reading, error) {
	lo := time.Duration(-1 << 62)
	hi := time.Duration(1 << 62)
	for i := range samples {
		if i > 0 {
			select {
			case <-ctx.Done():
				return Reading{}, ctx.Err()
			case <-time.After(interval):
			}
		}
		t0 := time.Now()
		date, err := c.date(ctx)
		if err != nil {
			return Reading{}, err
		}
		t1 := time.Now()
		sLo := date.Sub(t1)
		sHi := date.Add(time.Second).Sub(t0)
		lo = max(lo, sLo)
		hi = min(hi, sHi)
	}
	if lo > hi {
		return Reading{}, fmt.Errorf("clock: inconsistent apiserver Date samples (offset bounds %v > %v); a clock stepped during measurement", lo, hi)
	}
	r := Reading{Offset: (lo + hi) / 2, Uncertainty: (hi - lo) / 2, MeasuredAt: time.Now().UTC()}
	c.mu.Lock()
	c.reading = &r
	c.mu.Unlock()
	c.skew.Set(-r.Offset.Seconds())
	c.unc.Set(r.Uncertainty.Seconds())
	return r, nil
}

func (c *APIServer) date(ctx context.Context) (time.Time, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.url, nil)
	if err != nil {
		return time.Time{}, err
	}
	resp, err := c.client.Do(req)
	if err != nil {
		return time.Time{}, fmt.Errorf("clock: GET %s: %w", c.url, err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return time.Time{}, fmt.Errorf("clock: GET %s: status %d", c.url, resp.StatusCode)
	}
	d, err := http.ParseTime(resp.Header.Get("Date"))
	if err != nil {
		return time.Time{}, fmt.Errorf("clock: apiserver Date header: %w", err)
	}
	return d, nil
}

// Reading 返回最近一次读数；还没有测量过时 ok 为 false。
func (c *APIServer) Reading() (Reading, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if c.reading == nil {
		return Reading{}, false
	}
	return *c.reading, true
}

// Now 返回 apiserver 参考时间（本地时间加上测得的偏移量）。还没有测量过时返回本地时间。
func (c *APIServer) Now() time.Time {
	c.mu.RLock()
	defer c.mu.RUnlock()
	now := time.Now()
	if c.reading != nil {
		now = now.Add(c.reading.Offset)
	}
	return now.UTC()
}

// Run 每隔 every 测量一次，直到 ctx 结束。测量失败时 onError 收到错误，读数保持上一次的值。
func (c *APIServer) Run(ctx context.Context, every time.Duration, onError func(error)) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		if _, err := c.Measure(ctx); err != nil && ctx.Err() == nil {
			onError(err)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

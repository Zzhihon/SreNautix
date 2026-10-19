package query

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"sync/atomic"
	"time"

	"github.com/prometheus/client_golang/api"
	v1 "github.com/prometheus/client_golang/api/prometheus/v1"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/common/config"
	"github.com/prometheus/common/model"
	"github.com/sony/gobreaker/v2"
	"golang.org/x/sync/semaphore"
)

// Limits 是 reader 对所有查询施加的限制（DESIGN §7.5 数据源保护）。
type Limits struct {
	// MaxRange 是区间查询的最大时间跨度；超出时把起点后移，并在结果中标注 clamped=range
	MaxRange time.Duration
	// MinStep 是最小步长；MaxPoints 是单条序列的最大点数，步长至少为 range/MaxPoints。步长被提高时标注 clamped=step
	MinStep   time.Duration
	MaxPoints int
	// MaxSeries 是返回的最大序列数；超出部分按标签排序后截断，标注 truncated
	MaxSeries int
	// MaxBytes 是单个响应体的最大字节数；超出时整个查询失败（response_too_large）
	MaxBytes int64
	// Timeout 是单个查询的最长时间，同时作为 timeout 参数传给后端
	Timeout time.Duration
	// Concurrency 是每个数据源同时执行的查询上限
	Concurrency int64
	// BreakerFailures 是在 BreakerWindow 内触发熔断的失败次数；熔断后每隔 BreakerOpenFor 放行一次探测
	BreakerFailures uint32
	BreakerWindow   time.Duration
	BreakerOpenFor  time.Duration
}

// DefaultLimits 是默认限制：每个数据源 8 个并发、单查询 10 秒、60 秒内失败 5 次熔断、30 秒后探测。
func DefaultLimits() Limits {
	return Limits{
		MaxRange:        7 * 24 * time.Hour,
		MinStep:         time.Second,
		MaxPoints:       11000,
		MaxSeries:       1000,
		MaxBytes:        16 << 20,
		Timeout:         10 * time.Second,
		Concurrency:     8,
		BreakerFailures: 5,
		BreakerWindow:   60 * time.Second,
		BreakerOpenFor:  30 * time.Second,
	}
}

// Datasource 是一个 Prometheus HTTP API 兼容的数据源（Prometheus、VictoriaMetrics、Mimir、Thanos）。
type Datasource struct {
	Name string                  `json:"name"`
	URL  string                  `json:"url"`
	HTTP config.HTTPClientConfig `json:"http"`
}

type backend struct {
	name string
	api  v1.API
	sem  *semaphore.Weighted
	cb   *gobreaker.CircuitBreaker[model.Value]
}

// Executor 执行声明式查询和 reader 内置查询。
type Executor struct {
	limits   Limits
	manifest atomic.Pointer[Manifest]
	ds       map[string]*backend
	m        *execMetrics
}

type execMetrics struct {
	requests  *prometheus.CounterVec
	duration  *prometheus.HistogramVec
	inflight  *prometheus.GaugeVec
	breaker   *prometheus.GaugeVec
	truncated *prometheus.CounterVec
	clamped   *prometheus.CounterVec
	bytes     *prometheus.HistogramVec
}

var errTooLarge = errors.New("response body exceeds the byte limit")

type capBody struct {
	r    io.ReadCloser
	left int64
}

func (b *capBody) Read(p []byte) (int, error) {
	if b.left <= 0 {
		return 0, errTooLarge
	}
	if int64(len(p)) > b.left {
		p = p[:b.left]
	}
	n, err := b.r.Read(p)
	b.left -= int64(n)
	if b.left <= 0 && err == nil {
		// 读满上限后再探一个字节：恰好等于上限的响应是合法的
		var one [1]byte
		m, _ := b.r.Read(one[:])
		if m > 0 {
			return n, errTooLarge
		}
	}
	return n, err
}

func (b *capBody) Close() error { return b.r.Close() }

type byteLimitKey struct{}

// capTransport 给响应体加字节上限。上限随请求的 context 传入（不同查询的上限不同），缺省时用 limit。
type capTransport struct {
	next  http.RoundTripper
	limit int64
	bytes prometheus.Observer
}

func (t *capTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	resp, err := t.next.RoundTrip(req)
	if err != nil {
		return nil, err
	}
	limit := t.limit
	if v, ok := req.Context().Value(byteLimitKey{}).(int64); ok {
		limit = v
	}
	resp.Body = &capBody{r: resp.Body, left: limit}
	if resp.ContentLength > 0 {
		t.bytes.Observe(float64(resp.ContentLength))
	}
	return resp, nil
}

// NewExecutor 创建执行器。manifest 为 nil 时不接受声明式查询，只能执行内置查询。
func NewExecutor(limits Limits, sources []Datasource, manifest *Manifest, reg prometheus.Registerer) (*Executor, error) {
	m := &execMetrics{
		requests: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "srenautix_reader_query_requests_total", Help: "查询请求数，按数据源、来源（declared / builtin）和结果（ok 或错误码）。"}, []string{"datasource", "origin", "result"}),
		duration: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name: "srenautix_reader_query_duration_seconds", Help: "查询耗时。", Buckets: prometheus.ExponentialBuckets(0.005, 2.5, 10)}, []string{"datasource"}),
		inflight: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "srenautix_reader_query_inflight", Help: "正在执行的查询数。"}, []string{"datasource"}),
		breaker: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "srenautix_reader_query_breaker_state", Help: "数据源熔断器状态：0 关闭，1 半开，2 打开。"}, []string{"datasource"}),
		truncated: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "srenautix_reader_query_truncated_total", Help: "序列数超过上限而被截断的查询数。"}, []string{"datasource"}),
		clamped: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "srenautix_reader_query_clamped_total", Help: "被限制调整过的查询数，按被调整的项。"}, []string{"datasource", "clamp"}),
		bytes: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name: "srenautix_reader_query_response_bytes", Help: "后端响应体大小（有 Content-Length 时）。", Buckets: prometheus.ExponentialBuckets(512, 4, 10)}, []string{"datasource"}),
	}
	reg.MustRegister(m.requests, m.duration, m.inflight, m.breaker, m.truncated, m.clamped, m.bytes)
	e := &Executor{limits: limits, ds: map[string]*backend{}, m: m}
	e.manifest.Store(manifest)
	for _, src := range sources {
		if _, dup := e.ds[src.Name]; dup {
			return nil, fmt.Errorf("query: duplicate datasource %q", src.Name)
		}
		rt, err := config.NewRoundTripperFromConfig(src.HTTP, "srenautix-reader-"+src.Name)
		if err != nil {
			return nil, fmt.Errorf("query: datasource %q: %w", src.Name, err)
		}
		client, err := api.NewClient(api.Config{Address: src.URL, RoundTripper: &capTransport{next: rt, limit: limits.MaxBytes, bytes: m.bytes.WithLabelValues(src.Name)}})
		if err != nil {
			return nil, fmt.Errorf("query: datasource %q: %w", src.Name, err)
		}
		name := src.Name
		state := m.breaker.WithLabelValues(name)
		state.Set(0)
		cb := gobreaker.NewCircuitBreaker[model.Value](gobreaker.Settings{
			Name:        name,
			MaxRequests: 1,
			Interval:    limits.BreakerWindow,
			Timeout:     limits.BreakerOpenFor,
			ReadyToTrip: func(c gobreaker.Counts) bool { return c.TotalFailures >= limits.BreakerFailures },
			IsSuccessful: func(err error) bool {
				return err == nil || !backendFault(err)
			},
			OnStateChange: func(_ string, _, to gobreaker.State) {
				switch to {
				case gobreaker.StateClosed:
					state.Set(0)
				case gobreaker.StateHalfOpen:
					state.Set(1)
				case gobreaker.StateOpen:
					state.Set(2)
				}
			},
		})
		e.ds[name] = &backend{name: name, api: v1.NewAPI(client), sem: semaphore.NewWeighted(limits.Concurrency), cb: cb}
	}
	return e, nil
}

// SetManifest 替换模板清单（挂载的清单文件变化时调用）。
func (e *Executor) SetManifest(m *Manifest) { e.manifest.Store(m) }

// Manifest 返回当前模板清单。
func (e *Executor) Manifest() *Manifest { return e.manifest.Load() }

// backendFault 判断错误是否说明数据源本身不健康：连接失败、5xx、超时。查询本身的错误（4xx、执行错误、响应过大）不计入熔断。
func backendFault(err error) bool {
	if errors.Is(err, errTooLarge) {
		return false
	}
	var ae *v1.Error
	if errors.As(err, &ae) {
		switch ae.Type {
		case v1.ErrBadData, v1.ErrExec, v1.ErrCanceled:
			return false
		}
		return true
	}
	return true
}

// Request 是中心下发的声明式查询。Time 与 Start/End/Step 二选一：给 Time 为瞬时查询，给 Start/End/Step 为区间查询。
type Request struct {
	RequestID   string         `json:"request_id"`
	Datasource  string         `json:"datasource"`
	TemplateID  string         `json:"template_id"`
	ContentHash string         `json:"content_hash"`
	Params      map[string]any `json:"params"`
	Time        *time.Time     `json:"time,omitempty"`
	Start       *time.Time     `json:"start,omitempty"`
	End         *time.Time     `json:"end,omitempty"`
	Step        string         `json:"step,omitempty"`
	Timeout     string         `json:"timeout,omitempty"`
}

// Sample 是一个样本：t 为毫秒时间戳，v 为 Prometheus 风格的字符串取值（可以是 NaN、+Inf）。
type Sample struct {
	T int64  `json:"t"`
	V string `json:"v"`
}

// Series 是一条序列。
type Series struct {
	Labels  map[string]string `json:"labels"`
	Samples []Sample          `json:"samples"`
}

// Result 是查询结果。
type Result struct {
	RequestID  string    `json:"request_id"`
	Status     string    `json:"status"`
	Error      *Error    `json:"error,omitempty"`
	Rendered   string    `json:"rendered,omitempty"`
	ResultType string    `json:"result_type,omitempty"`
	Series     []Series  `json:"series"`
	Truncated  bool      `json:"truncated"`
	Clamped    []string  `json:"clamped"`
	Warnings   []string  `json:"warnings"`
	EffStart   time.Time `json:"effective_start,omitzero"`
	EffEnd     time.Time `json:"effective_end,omitzero"`
	EffStep    string    `json:"effective_step,omitempty"`
	ExecutedAt time.Time `json:"executed_at"`
	DurationMs int64     `json:"duration_ms"`
}

func fail(id string, err error) Result {
	var qe *Error
	if !errors.As(err, &qe) {
		qe = &Error{Code: CodeBackend, Message: err.Error()}
	}
	return Result{RequestID: id, Status: "error", Error: qe, Series: []Series{}, Clamped: []string{}, Warnings: []string{}, ExecutedAt: time.Now().UTC()}
}

// Execute 执行声明式查询。只接受模板清单中声明过的模板。
func (e *Executor) Execute(ctx context.Context, req Request) Result {
	m := e.manifest.Load()
	if m == nil {
		return e.count(req.Datasource, "declared", fail(req.RequestID, &Error{Code: CodeUndeclared, Message: "no query manifest is mounted"}))
	}
	t, err := m.Lookup(req.TemplateID, req.ContentHash)
	if err != nil {
		return e.count(req.Datasource, "declared", fail(req.RequestID, err))
	}
	expr, err := t.Render(req.Params)
	if err != nil {
		return e.count(req.Datasource, "declared", fail(req.RequestID, err))
	}
	limits := e.limits
	if t.maxRange > 0 && t.maxRange < limits.MaxRange {
		limits.MaxRange = t.maxRange
	}
	if t.Limits.MaxSeries > 0 && t.Limits.MaxSeries < limits.MaxSeries {
		limits.MaxSeries = t.Limits.MaxSeries
	}
	res := e.run(ctx, req, expr, limits)
	return e.count(req.Datasource, "declared", res)
}

// Builtin 执行 reader 内置的查询（kube-state-metrics 历史、ALERTS 对账）。这些查询文本由 reader 代码构造，从不来自中心。
func (e *Executor) Builtin(ctx context.Context, req Request, expr string, limits Limits) Result {
	return e.count(req.Datasource, "builtin", e.run(ctx, req, expr, limits))
}

// Limits 返回全局限制。
func (e *Executor) Limits() Limits { return e.limits }

func (e *Executor) count(ds, origin string, r Result) Result {
	label := "ok"
	if r.Error != nil {
		label = r.Error.Code
	}
	e.m.requests.WithLabelValues(ds, origin, label).Inc()
	return r
}

func (e *Executor) run(ctx context.Context, req Request, expr string, limits Limits) Result {
	b, ok := e.ds[req.Datasource]
	if !ok {
		return fail(req.RequestID, &Error{Code: CodeUnknownDS, Message: fmt.Sprintf("datasource %q is not configured", req.Datasource)})
	}
	timeout := limits.Timeout
	if req.Timeout != "" {
		d, err := model.ParseDuration(req.Timeout)
		if err != nil {
			return fail(req.RequestID, &Error{Code: CodeBadParams, Message: "timeout: " + err.Error()})
		}
		if time.Duration(d) < timeout {
			timeout = time.Duration(d)
		}
	}
	res := Result{RequestID: req.RequestID, Status: "ok", Rendered: expr, Series: []Series{}, Clamped: []string{}, Warnings: []string{}}

	var rng *v1.Range
	switch {
	case req.Time != nil && req.Start == nil && req.End == nil && req.Step == "":
	case req.Time == nil && req.Start != nil && req.End != nil && req.Step != "":
		step, err := model.ParseDuration(req.Step)
		if err != nil || step <= 0 {
			return fail(req.RequestID, &Error{Code: CodeBadRange, Message: "step must be a positive duration"})
		}
		start, end := req.Start.UTC(), req.End.UTC()
		if !end.After(start) {
			return fail(req.RequestID, &Error{Code: CodeBadRange, Message: "end must be after start"})
		}
		if end.Sub(start) > limits.MaxRange {
			start = end.Add(-limits.MaxRange)
			res.Clamped = append(res.Clamped, "range")
		}
		st := time.Duration(step)
		floor := max(limits.MinStep, end.Sub(start)/time.Duration(limits.MaxPoints))
		if st < floor {
			st = floor.Truncate(time.Millisecond) + time.Millisecond
			res.Clamped = append(res.Clamped, "step")
		}
		rng = &v1.Range{Start: start, End: end, Step: st}
		res.EffStart, res.EffEnd, res.EffStep = start, end, model.Duration(st).String()
	default:
		return fail(req.RequestID, &Error{Code: CodeBadRange, Message: "give either time, or start, end and step"})
	}
	for _, c := range res.Clamped {
		e.m.clamped.WithLabelValues(b.name, c).Inc()
	}

	ctx = context.WithValue(ctx, byteLimitKey{}, limits.MaxBytes)
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	if err := b.sem.Acquire(ctx, 1); err != nil {
		return fail(req.RequestID, &Error{Code: CodeOverloaded, Message: fmt.Sprintf("datasource %q: %d queries already running and none finished within %s", b.name, limits.Concurrency, timeout)})
	}
	defer b.sem.Release(1)
	inflight := e.m.inflight.WithLabelValues(b.name)
	inflight.Inc()
	defer inflight.Dec()

	began := time.Now()
	opts := []v1.Option{v1.WithTimeout(timeout), v1.WithLimit(uint64(limits.MaxSeries) + 1)}
	var warnings v1.Warnings
	val, err := b.cb.Execute(func() (model.Value, error) {
		var v model.Value
		var err error
		if rng != nil {
			v, warnings, err = b.api.QueryRange(ctx, expr, *rng, opts...)
		} else {
			v, warnings, err = b.api.Query(ctx, expr, req.Time.UTC(), opts...)
		}
		return v, err
	})
	elapsed := time.Since(began)
	e.m.duration.WithLabelValues(b.name).Observe(elapsed.Seconds())
	res.ExecutedAt = time.Now().UTC()
	res.DurationMs = elapsed.Milliseconds()
	if err != nil {
		switch {
		case errors.Is(err, gobreaker.ErrOpenState), errors.Is(err, gobreaker.ErrTooManyRequests):
			return fail(req.RequestID, &Error{Code: CodeBreakerOpen, Message: fmt.Sprintf("datasource %q: circuit breaker is open", b.name)})
		case errors.Is(err, errTooLarge):
			return fail(req.RequestID, &Error{Code: CodeTooLarge, Message: fmt.Sprintf("response exceeds %d bytes", limits.MaxBytes)})
		case errors.Is(err, context.DeadlineExceeded) || ctx.Err() != nil:
			return fail(req.RequestID, &Error{Code: CodeTimeout, Message: fmt.Sprintf("query did not finish within %s", timeout)})
		}
		var ae *v1.Error
		if errors.As(err, &ae) && (ae.Type == v1.ErrBadData || ae.Type == v1.ErrExec) {
			return fail(req.RequestID, &Error{Code: CodeBadParams, Message: ae.Error()})
		}
		return fail(req.RequestID, &Error{Code: CodeBackend, Message: err.Error()})
	}
	res.Warnings = append(res.Warnings, warnings...)
	res.ResultType = val.Type().String()
	res.Series = convert(val)
	if len(res.Series) > limits.MaxSeries {
		res.Series = res.Series[:limits.MaxSeries]
		res.Truncated = true
		e.m.truncated.WithLabelValues(b.name).Inc()
	}
	return res
}

func labelsOf(m model.Metric) map[string]string {
	out := make(map[string]string, len(m))
	for k, v := range m {
		out[string(k)] = string(v)
	}
	return out
}

// convert 把结果转换成序列列表，按标签集排序，保证截断结果是确定的。
func convert(v model.Value) []Series {
	var out []Series
	switch x := v.(type) {
	case model.Vector:
		for _, s := range x {
			out = append(out, Series{Labels: labelsOf(s.Metric), Samples: []Sample{{T: int64(s.Timestamp), V: s.Value.String()}}})
		}
	case model.Matrix:
		for _, ss := range x {
			samples := make([]Sample, 0, len(ss.Values))
			for _, p := range ss.Values {
				samples = append(samples, Sample{T: int64(p.Timestamp), V: p.Value.String()})
			}
			out = append(out, Series{Labels: labelsOf(ss.Metric), Samples: samples})
		}
	case *model.Scalar:
		out = append(out, Series{Labels: map[string]string{}, Samples: []Sample{{T: int64(x.Timestamp), V: x.Value.String()}}})
	case *model.String:
		out = append(out, Series{Labels: map[string]string{}, Samples: []Sample{{T: int64(x.Timestamp), V: x.Value}}})
	}
	sort.Slice(out, func(i, j int) bool {
		return model.LabelSet(toLS(out[i].Labels)).String() < model.LabelSet(toLS(out[j].Labels)).String()
	})
	if out == nil {
		out = []Series{}
	}
	return out
}

func toLS(m map[string]string) model.LabelSet {
	ls := make(model.LabelSet, len(m))
	for k, v := range m {
		ls[model.LabelName(k)] = model.LabelValue(v)
	}
	return ls
}

package query_test

import (
	"context"
	"fmt"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"
	"sigs.k8s.io/yaml"

	"github.com/Zzhihon/SreNautix/internal/spoke/reader/query"
	"github.com/Zzhihon/SreNautix/internal/spoke/reader/testenv"
)

// base 是夹具的起点：样本从 base 开始，每 30 秒一个，持续 2 小时。
var base = time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)

// fixture 生成同一份数据的 OpenMetrics（promtool 回填 Prometheus）和带时间戳的文本格式（导入 VictoriaMetrics）。
func fixture() (openMetrics, promText string) {
	var om, pt strings.Builder
	om.WriteString("# TYPE pod_restarts counter\n")
	for i := 0; i <= 240; i++ {
		ts := base.Add(time.Duration(i) * 30 * time.Second)
		for p := range 30 {
			// pod-0 在第 60 个样本之后开始重启，其余 Pod 不变
			v := 0
			if p == 0 && i > 60 {
				v = i - 60
			}
			fmt.Fprintf(&om, "pod_restarts_total{namespace=\"app\",pod=\"pod-%d\"} %d %d\n", p, v, ts.Unix())
			fmt.Fprintf(&pt, "pod_restarts_total{namespace=\"app\",pod=\"pod-%d\"} %d %d\n", p, v, ts.UnixMilli())
		}
		// 带引号与反斜杠的标签值，用于检查参数转义
		fmt.Fprintf(&om, "weird_metric{namespace=\"a\\\"b\\\\c\"} 7 %d\n", ts.Unix())
		fmt.Fprintf(&pt, "weird_metric{namespace=\"a\\\"b\\\\c\"} 7 %d\n", ts.UnixMilli())
	}
	om.WriteString("# EOF\n")
	return om.String(), pt.String()
}

func tmpl(id string, d query.Dialect, expr string, params map[string]query.Param, lim query.TemplateLimits) query.Template {
	t := query.Template{ID: id, Dialect: d, Expr: expr, Params: params, Limits: lim}
	t.ContentHash = query.ContentHash(t)
	return t
}

func manifest(t *testing.T) *query.Manifest {
	t.Helper()
	m := map[string]any{
		"version":   1,
		"pack_lock": "sha256:" + strings.Repeat("ab", 32),
		"queries": []query.Template{
			tmpl("workload/restarts", query.DialectPromQL, `sum by (pod) (increase(pod_restarts_total{namespace="$namespace"}[$window]))`,
				map[string]query.Param{"namespace": {Type: query.ParamLabelValue}, "window": {Type: query.ParamDuration, Max: "1h"}}, query.TemplateLimits{}),
			tmpl("workload/restarts-of", query.DialectPromQL, `pod_restarts_total{namespace="$namespace",pod=~"$pods"} > $threshold`,
				map[string]query.Param{"namespace": {Type: query.ParamLabelValue}, "pods": {Type: query.ParamLabelValues, MaxItems: 5}, "threshold": {Type: query.ParamNumber}}, query.TemplateLimits{}),
			tmpl("weird/value", query.DialectPromQL, `weird_metric{namespace="$namespace"}`,
				map[string]query.Param{"namespace": {Type: query.ParamLabelValue}}, query.TemplateLimits{}),
			tmpl("all/restarts", query.DialectPromQL, `pod_restarts_total`, map[string]query.Param{}, query.TemplateLimits{MaxSeries: 10, MaxRange: "1h"}),
			tmpl("all/restarts-mql", query.DialectMetricsQL, `sum(rate(pod_restarts_total)) by (pod)`, map[string]query.Param{}, query.TemplateLimits{}),
		},
	}
	b, err := yaml.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	mf, err := query.ParseManifest(b)
	if err != nil {
		t.Fatal(err)
	}
	return mf
}

func at(d time.Duration) *time.Time { v := base.Add(d); return &v }

type backends struct {
	prom, vm string
}

func startBackends(t *testing.T) backends {
	t.Helper()
	om, pt := fixture()
	prom := testenv.StartPrometheus(t, testenv.BackfillPrometheus(t, om), "global:\n  scrape_interval: 30s\n")
	vm := testenv.StartVictoriaMetrics(t)
	testenv.ImportVictoriaMetrics(t, vm.URL, pt)
	return backends{prom: prom.URL, vm: vm.URL}
}

func newExec(t *testing.T, limits query.Limits, b backends, extra ...query.Datasource) (*query.Executor, *prometheus.Registry) {
	t.Helper()
	reg := prometheus.NewRegistry()
	ds := append([]query.Datasource{{Name: "prom", URL: b.prom}, {Name: "vm", URL: b.vm}}, extra...)
	e, err := query.NewExecutor(limits, ds, manifest(t), reg)
	if err != nil {
		t.Fatal(err)
	}
	return e, reg
}

func run(e *query.Executor, req query.Request) query.Result {
	return e.Execute(context.Background(), req)
}

func TestDeclaredQueriesOnPrometheusAndVictoriaMetrics(t *testing.T) {
	b := startBackends(t)
	e, _ := newExec(t, query.DefaultLimits(), b)
	m := e.Manifest()
	hash := func(id string) string {
		tpl, err := m.Lookup(id, "")
		if err == nil {
			t.Fatalf("lookup with empty hash must fail")
		}
		for _, q := range m.Queries {
			if q.ID == id {
				return q.ContentHash
			}
		}
		t.Fatalf("no template %s (%v)", id, tpl)
		return ""
	}

	// 两个后端对同一份数据给出一致的结论
	for _, ds := range []string{"prom", "vm"} {
		r := run(e, query.Request{RequestID: "r1", Datasource: ds, TemplateID: "workload/restarts", ContentHash: hash("workload/restarts"),
			Params: map[string]any{"namespace": "app", "window": "30m"}, Time: at(2 * time.Hour)})
		if r.Status != "ok" || r.ResultType != "vector" || len(r.Series) != 30 {
			t.Fatalf("%s: %+v", ds, r)
		}
		if r.Series[0].Labels["pod"] != "pod-0" || r.Series[0].Samples[0].V == "0" {
			t.Fatalf("%s: pod-0 restarts not visible: %+v", ds, r.Series[0])
		}
		if !strings.Contains(r.Rendered, `namespace="app"`) {
			t.Fatalf("%s: rendered %q", ds, r.Rendered)
		}

		// label_values 渲染为逐个转义的交替式；数字参数原样渲染
		r = run(e, query.Request{RequestID: "r2", Datasource: ds, TemplateID: "workload/restarts-of", ContentHash: hash("workload/restarts-of"),
			Params: map[string]any{"namespace": "app", "pods": []any{"pod-0", "pod-1", "pod.*"}, "threshold": 5.0}, Time: at(2 * time.Hour)})
		if r.Status != "ok" || len(r.Series) != 1 || r.Series[0].Labels["pod"] != "pod-0" {
			t.Fatalf("%s: label_values query: %+v", ds, r)
		}

		// 带引号和反斜杠的值被当作字面量，查询仍然只匹配这个值
		r = run(e, query.Request{RequestID: "r3", Datasource: ds, TemplateID: "weird/value", ContentHash: hash("weird/value"),
			Params: map[string]any{"namespace": `a"b\c`}, Time: at(time.Hour)})
		if r.Status != "ok" || len(r.Series) != 1 || r.Series[0].Samples[0].V != "7" {
			t.Fatalf("%s: escaped label value: %+v", ds, r)
		}
		// 注入尝试：闭合引号后追加选择器，结果是一个不存在的字面量值，查不到任何序列
		r = run(e, query.Request{RequestID: "r4", Datasource: ds, TemplateID: "weird/value", ContentHash: hash("weird/value"),
			Params: map[string]any{"namespace": `x"} or pod_restarts_total{namespace="app`}, Time: at(time.Hour)})
		if r.Status != "ok" || len(r.Series) != 0 {
			t.Fatalf("%s: injection was not neutralized: %+v", ds, r)
		}
	}

	// MetricsQL 模板只在声明了 metricsql 方言时通过解析
	r := run(e, query.Request{RequestID: "m1", Datasource: "vm", TemplateID: "all/restarts-mql", ContentHash: hash("all/restarts-mql"), Params: map[string]any{}, Time: at(2 * time.Hour)})
	if r.Status != "ok" || len(r.Series) != 30 {
		t.Fatalf("metricsql: %+v", r)
	}

	// 区间查询：模板的 max_range 为 1h，请求 2h 被截到 1h；max_series 为 10，30 条序列被截断
	start, end := at(0), at(2*time.Hour)
	for _, ds := range []string{"prom", "vm"} {
		r = run(e, query.Request{RequestID: "rr", Datasource: ds, TemplateID: "all/restarts", ContentHash: hash("all/restarts"), Params: map[string]any{},
			Start: start, End: end, Step: "1m"})
		if r.Status != "ok" || r.ResultType != "matrix" || !r.Truncated || len(r.Series) != 10 {
			t.Fatalf("%s range: status=%s type=%s truncated=%v series=%d", ds, r.Status, r.ResultType, r.Truncated, len(r.Series))
		}
		if len(r.Clamped) != 1 || r.Clamped[0] != "range" || !r.EffStart.Equal(end.Add(-time.Hour)) {
			t.Fatalf("%s range clamp: %v %s", ds, r.Clamped, r.EffStart)
		}
		if n := len(r.Series[0].Samples); n != 61 {
			t.Fatalf("%s: %d samples for 1h at 1m step", ds, n)
		}
	}
}

func TestDeclaredQueryRejections(t *testing.T) {
	b := startBackends(t)
	limits := query.DefaultLimits()
	limits.MaxPoints = 100
	e, reg := newExec(t, limits, b)
	h := map[string]string{}
	for _, q := range e.Manifest().Queries {
		h[q.ID] = q.ContentHash
	}
	cases := []struct {
		name string
		req  query.Request
		code string
	}{
		{"undeclared", query.Request{Datasource: "prom", TemplateID: "raw", ContentHash: h["weird/value"], Params: map[string]any{}, Time: at(0)}, query.CodeUndeclared},
		{"hash mismatch", query.Request{Datasource: "prom", TemplateID: "weird/value", ContentHash: h["all/restarts"], Params: map[string]any{"namespace": "a"}, Time: at(0)}, query.CodeHashMismatch},
		{"extra param", query.Request{Datasource: "prom", TemplateID: "weird/value", ContentHash: h["weird/value"], Params: map[string]any{"namespace": "a", "expr": "up"}, Time: at(0)}, query.CodeBadParams},
		{"missing param", query.Request{Datasource: "prom", TemplateID: "weird/value", ContentHash: h["weird/value"], Params: map[string]any{}, Time: at(0)}, query.CodeBadParams},
		{"wrong type", query.Request{Datasource: "prom", TemplateID: "weird/value", ContentHash: h["weird/value"], Params: map[string]any{"namespace": 3.0}, Time: at(0)}, query.CodeBadParams},
		{"duration over max", query.Request{Datasource: "prom", TemplateID: "workload/restarts", ContentHash: h["workload/restarts"], Params: map[string]any{"namespace": "a", "window": "2h"}, Time: at(0)}, query.CodeBadParams},
		{"duration injection", query.Request{Datasource: "prom", TemplateID: "workload/restarts", ContentHash: h["workload/restarts"], Params: map[string]any{"namespace": "a", "window": "5m]) or up[5m"}, Time: at(0)}, query.CodeBadParams},
		{"too many items", query.Request{Datasource: "prom", TemplateID: "workload/restarts-of", ContentHash: h["workload/restarts-of"], Params: map[string]any{"namespace": "a", "pods": []any{"1", "2", "3", "4", "5", "6"}, "threshold": 1.0}, Time: at(0)}, query.CodeBadParams},
		{"unknown datasource", query.Request{Datasource: "nope", TemplateID: "weird/value", ContentHash: h["weird/value"], Params: map[string]any{"namespace": "a"}, Time: at(0)}, query.CodeUnknownDS},
		{"time and range", query.Request{Datasource: "prom", TemplateID: "weird/value", ContentHash: h["weird/value"], Params: map[string]any{"namespace": "a"}, Time: at(0), Start: at(0), End: at(time.Hour), Step: "1m"}, query.CodeBadRange},
		{"end before start", query.Request{Datasource: "prom", TemplateID: "weird/value", ContentHash: h["weird/value"], Params: map[string]any{"namespace": "a"}, Start: at(time.Hour), End: at(0), Step: "1m"}, query.CodeBadRange},
	}
	for _, c := range cases {
		r := run(e, c.req)
		if r.Status != "error" || r.Error.Code != c.code {
			t.Errorf("%s: got %+v, want %s", c.name, r.Error, c.code)
		}
	}
	// MetricsQL 专有函数在 PromQL 模板里无法通过解析：清单加载时就拒绝
	bad := tmpl("bad", query.DialectPromQL, `rate(pod_restarts_total)`, map[string]query.Param{}, query.TemplateLimits{})
	doc, _ := yaml.Marshal(map[string]any{"version": 1, "pack_lock": "sha256:" + strings.Repeat("ab", 32), "queries": []query.Template{bad}})
	if _, err := query.ParseManifest(doc); err == nil || !strings.Contains(err.Error(), "PromQL") {
		t.Fatalf("PromQL template with a MetricsQL-only form loaded: %v", err)
	}
	tampered := tmpl("t", query.DialectPromQL, `up`, map[string]query.Param{}, query.TemplateLimits{})
	tampered.Expr = `sum(up)`
	doc, _ = yaml.Marshal(map[string]any{"version": 1, "pack_lock": "sha256:" + strings.Repeat("ab", 32), "queries": []query.Template{tampered}})
	if _, err := query.ParseManifest(doc); err == nil || !strings.Contains(err.Error(), "content_hash") {
		t.Fatalf("tampered template loaded: %v", err)
	}

	// 步长：2 小时、MaxPoints=100 时步长至少 72 秒；请求 10 秒被提高
	r := run(e, query.Request{Datasource: "vm", TemplateID: "weird/value", ContentHash: h["weird/value"], Params: map[string]any{"namespace": `a"b\c`},
		Start: at(0), End: at(2 * time.Hour), Step: "10s"})
	if r.Status != "ok" || len(r.Clamped) != 1 || r.Clamped[0] != "step" || len(r.Series[0].Samples) > 101 {
		t.Fatalf("step clamp: %+v clamped=%v samples=%d", r.Error, r.Clamped, len(r.Series[0].Samples))
	}
	if got := testutil.ToFloat64(counter(t, reg, "srenautix_reader_query_clamped_total", map[string]string{"datasource": "vm", "clamp": "step"})); got != 1 {
		t.Fatalf("clamped metric: %v", got)
	}
}

func counter(t *testing.T, reg *prometheus.Registry, name string, labels map[string]string) prometheus.Collector {
	t.Helper()
	mfs, err := reg.Gather()
	if err != nil {
		t.Fatal(err)
	}
	for _, mf := range mfs {
		if mf.GetName() != name {
			continue
		}
	next:
		for _, m := range mf.GetMetric() {
			got := map[string]string{}
			for _, l := range m.GetLabel() {
				got[l.GetName()] = l.GetValue()
			}
			for k, v := range labels {
				if got[k] != v {
					continue next
				}
			}
			v := m.GetCounter().GetValue() + m.GetGauge().GetValue()
			g := prometheus.NewGauge(prometheus.GaugeOpts{Name: "x"})
			g.Set(v)
			return g
		}
	}
	t.Fatalf("metric %s%v not found", name, labels)
	return nil
}

// hungBackend 接受连接但从不响应，模拟卡住的数据源。
func hungBackend(t *testing.T) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	var conns []net.Conn
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			conns = append(conns, c)
		}
	}()
	t.Cleanup(func() {
		l.Close()
		for _, c := range conns {
			c.Close()
		}
	})
	return "http://" + l.Addr().String()
}

func TestLimitsTimeoutConcurrencyBreakerAndBytes(t *testing.T) {
	b := startBackends(t)
	limits := query.DefaultLimits()
	limits.Timeout = 500 * time.Millisecond
	limits.Concurrency = 1
	limits.BreakerFailures = 3
	limits.BreakerOpenFor = time.Hour
	refused := testenv.FreePort(t)
	e, reg := newExec(t, limits, b,
		query.Datasource{Name: "hung", URL: hungBackend(t)},
		query.Datasource{Name: "down", URL: fmt.Sprintf("http://127.0.0.1:%d", refused)})
	h := map[string]string{}
	for _, q := range e.Manifest().Queries {
		h[q.ID] = q.ContentHash
	}
	req := func(ds string) query.Request {
		return query.Request{Datasource: ds, TemplateID: "weird/value", ContentHash: h["weird/value"], Params: map[string]any{"namespace": "a"}, Time: at(0)}
	}

	// 超时：卡住的后端在 500ms 后返回 timeout
	began := time.Now()
	r := run(e, req("hung"))
	if r.Status != "error" || r.Error.Code != query.CodeTimeout || time.Since(began) > 3*time.Second {
		t.Fatalf("timeout: %+v after %s", r.Error, time.Since(began))
	}

	// 并发上限：一个查询占住唯一的槽位（500ms）时，另一个 200ms 超时的查询等不到槽位
	done := make(chan query.Result)
	go func() { done <- run(e, req("hung")) }()
	time.Sleep(100 * time.Millisecond)
	short := req("hung")
	short.Timeout = "200ms"
	r = run(e, short)
	first := <-done
	codes := []string{first.Error.Code, r.Error.Code}
	if !(codes[0] == query.CodeTimeout && codes[1] == query.CodeOverloaded) {
		t.Fatalf("concurrency cap: got %v", codes)
	}

	// 熔断：连接被拒绝 3 次后打开，之后不再访问后端
	for i := range 3 {
		if r := run(e, req("down")); r.Error == nil || r.Error.Code != query.CodeBackend {
			t.Fatalf("attempt %d: %+v", i, r.Error)
		}
	}
	if r := run(e, req("down")); r.Error == nil || r.Error.Code != query.CodeBreakerOpen {
		t.Fatalf("breaker did not open: %+v", r.Error)
	}
	if v := testutil.ToFloat64(counter(t, reg, "srenautix_reader_query_breaker_state", map[string]string{"datasource": "down"})); v != 2 {
		t.Fatalf("breaker state metric %v", v)
	}
	// 查询自身的错误（参数、执行错误）不计入熔断：健康的后端始终可用
	if v := testutil.ToFloat64(counter(t, reg, "srenautix_reader_query_breaker_state", map[string]string{"datasource": "prom"})); v != 0 {
		t.Fatalf("prom breaker state %v", v)
	}

	// 字节上限：响应体超过上限时整个查询失败
	small := query.DefaultLimits()
	small.MaxBytes = 512
	e2, _ := newExec(t, small, b)
	r = run(e2, query.Request{Datasource: "prom", TemplateID: "workload/restarts", ContentHash: h["workload/restarts"],
		Params: map[string]any{"namespace": "app", "window": "30m"}, Time: at(2 * time.Hour)})
	if r.Status != "error" || r.Error.Code != query.CodeTooLarge {
		t.Fatalf("byte limit: %+v", r.Error)
	}
}

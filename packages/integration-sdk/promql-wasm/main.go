//go:build js && wasm

// 把官方 PromQL 解析器与 MetricsQL 解析器编译为 wasm，供 SDK 做严格 lint、
// 计算查询的回看范围（回放时钟窗口检查）、按标签档案改写标签名、展开 promtool 的 input_series 写法。
package main

import (
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"syscall/js"
	"time"

	"github.com/VictoriaMetrics/metricsql"
	"github.com/prometheus/prometheus/model/labels"
	"github.com/prometheus/prometheus/model/value"
	"github.com/prometheus/prometheus/promql/parser"
)

type matcherOut struct {
	Label string `json:"label"`
	Op    string `json:"op"`
	Value string `json:"value"`
}

type selectorOut struct {
	Metric   string       `json:"metric"`
	Matchers []matcherOut `json:"matchers"`
}

type analyzeOut struct {
	OK        bool          `json:"ok"`
	Error     string        `json:"error"`
	Type      string        `json:"type"`
	Selectors []selectorOut `json:"selectors"`
	Functions []string      `json:"functions"`
	Labels    []string      `json:"labels"`
	Normal    string        `json:"normalized"`
	// 求值一个时刻需要读取的最早数据距该时刻的毫秒数（区间、offset、子查询与 5 分钟回看）
	LookbackMs int64 `json:"lookback_ms"`
	// 负 offset 会读取求值时刻之后的数据
	LookaheadMs int64 `json:"lookahead_ms"`
	// 使用了 @ 修饰符，读取的时刻与求值时刻无关
	HasAt bool `json:"has_at"`
}

// Prometheus 默认的 lookback delta
const lookbackDelta = 5 * time.Minute

type reach struct {
	back  time.Duration
	ahead time.Duration
	at    bool
}

func (r reach) merge(o reach) reach {
	return reach{back: max(r.back, o.back), ahead: max(r.ahead, o.ahead), at: r.at || o.at}
}

func withOffset(r reach, offset time.Duration) reach {
	r.back += offset
	r.ahead -= offset
	if r.back < 0 {
		r.back = 0
	}
	if r.ahead < 0 {
		r.ahead = 0
	}
	return r
}

func promReach(n parser.Node) reach {
	switch x := n.(type) {
	case *parser.MatrixSelector:
		vs := x.VectorSelector.(*parser.VectorSelector)
		return withOffset(reach{back: x.Range, at: vs.Timestamp != nil || vs.StartOrEnd != 0}, vs.OriginalOffset)
	case *parser.VectorSelector:
		return withOffset(reach{back: lookbackDelta, at: x.Timestamp != nil || x.StartOrEnd != 0}, x.OriginalOffset)
	case *parser.SubqueryExpr:
		inner := promReach(x.Expr)
		inner.back += x.Range
		inner.at = inner.at || x.Timestamp != nil || x.StartOrEnd != 0
		return withOffset(inner, x.OriginalOffset)
	}
	out := reach{}
	for _, c := range parser.Children(n) {
		out = out.merge(promReach(c))
	}
	return out
}

func metricsqlReach(e metricsql.Expr) reach {
	switch x := e.(type) {
	case *metricsql.RollupExpr:
		inner := metricsqlReach(x.Expr)
		if x.Window != nil {
			inner.back += time.Duration(x.Window.Duration(0)) * time.Millisecond
		}
		inner.at = inner.at || x.At != nil
		if x.Offset != nil {
			inner = withOffset(inner, time.Duration(x.Offset.Duration(0))*time.Millisecond)
		}
		return inner
	case *metricsql.MetricExpr:
		return reach{back: lookbackDelta}
	case *metricsql.FuncExpr:
		out := reach{}
		for _, a := range x.Args {
			out = out.merge(metricsqlReach(a))
		}
		return out
	case *metricsql.AggrFuncExpr:
		out := reach{}
		for _, a := range x.Args {
			out = out.merge(metricsqlReach(a))
		}
		return out
	case *metricsql.BinaryOpExpr:
		return metricsqlReach(x.Left).merge(metricsqlReach(x.Right))
	}
	return reach{}
}

type renameOut struct {
	OK    bool   `json:"ok"`
	Error string `json:"error"`
	Expr  string `json:"expr"`
}

type seriesOut struct {
	OK     bool              `json:"ok"`
	Error  string            `json:"error"`
	Labels map[string]string `json:"labels"`
	// 每个点为数值、null（省略的点 _）或字符串 "stale"（staleness marker）
	Values []any `json:"values"`
}

func toJSON(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return string(b)
}

func sortedKeys(m map[string]struct{}) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// 默认选项：不启用实验函数与实验语法，领域包只能使用稳定的 PromQL
var promParser = parser.NewParser(parser.Options{})

func analyzePromQL(input string) analyzeOut {
	expr, err := promParser.ParseExpr(input)
	if err != nil {
		return analyzeOut{Error: err.Error()}
	}
	funcs := map[string]struct{}{}
	labels := map[string]struct{}{}
	selectors := []selectorOut{}
	parser.Inspect(expr, func(node parser.Node, _ []parser.Node) error {
		switch n := node.(type) {
		case *parser.VectorSelector:
			s := selectorOut{Metric: n.Name, Matchers: []matcherOut{}}
			for _, m := range n.LabelMatchers {
				if m.Name == "__name__" {
					if s.Metric == "" && m.Type.String() == "=" {
						s.Metric = m.Value
					}
					continue
				}
				labels[m.Name] = struct{}{}
				s.Matchers = append(s.Matchers, matcherOut{Label: m.Name, Op: m.Type.String(), Value: m.Value})
			}
			selectors = append(selectors, s)
		case *parser.Call:
			funcs[n.Func.Name] = struct{}{}
		case *parser.AggregateExpr:
			funcs[n.Op.String()] = struct{}{}
			for _, l := range n.Grouping {
				labels[l] = struct{}{}
			}
		case *parser.BinaryExpr:
			if n.VectorMatching != nil {
				for _, l := range n.VectorMatching.MatchingLabels {
					labels[l] = struct{}{}
				}
				for _, l := range n.VectorMatching.Include {
					labels[l] = struct{}{}
				}
			}
		}
		return nil
	})
	r := promReach(expr)
	return analyzeOut{
		OK:          true,
		Type:        string(expr.Type()),
		Selectors:   selectors,
		Functions:   sortedKeys(funcs),
		Labels:      sortedKeys(labels),
		Normal:      expr.String(),
		LookbackMs:  r.back.Milliseconds(),
		LookaheadMs: r.ahead.Milliseconds(),
		HasAt:       r.at,
	}
}

func analyzeMetricsQL(input string) analyzeOut {
	expr, err := metricsql.Parse(input)
	if err != nil {
		return analyzeOut{Error: err.Error()}
	}
	funcs := map[string]struct{}{}
	labels := map[string]struct{}{}
	selectors := []selectorOut{}
	metricsql.VisitAll(expr, func(e metricsql.Expr) {
		switch n := e.(type) {
		case *metricsql.MetricExpr:
			for _, group := range n.LabelFilterss {
				s := selectorOut{Matchers: []matcherOut{}}
				for _, f := range group {
					if f.Label == "__name__" {
						if !f.IsRegexp && !f.IsNegative {
							s.Metric = f.Value
						}
						continue
					}
					labels[f.Label] = struct{}{}
					s.Matchers = append(s.Matchers, matcherOut{Label: f.Label, Op: filterOp(f), Value: f.Value})
				}
				selectors = append(selectors, s)
			}
		case *metricsql.FuncExpr:
			funcs[n.Name] = struct{}{}
		case *metricsql.AggrFuncExpr:
			funcs[n.Name] = struct{}{}
			for _, l := range n.Modifier.Args {
				labels[l] = struct{}{}
			}
		case *metricsql.BinaryOpExpr:
			for _, l := range n.GroupModifier.Args {
				labels[l] = struct{}{}
			}
			for _, l := range n.JoinModifier.Args {
				labels[l] = struct{}{}
			}
		}
	})
	r := metricsqlReach(expr)
	return analyzeOut{
		OK:          true,
		Type:        "",
		Selectors:   selectors,
		Functions:   sortedKeys(funcs),
		Labels:      sortedKeys(labels),
		Normal:      string(expr.AppendString(nil)),
		LookbackMs:  r.back.Milliseconds(),
		LookaheadMs: r.ahead.Milliseconds(),
		HasAt:       r.at,
	}
}

func filterOp(f metricsql.LabelFilter) string {
	switch {
	case f.IsNegative && f.IsRegexp:
		return "!~"
	case f.IsNegative:
		return "!="
	case f.IsRegexp:
		return "=~"
	default:
		return "="
	}
}

func renameAll(names []string, m map[string]string) {
	for i, n := range names {
		if to, ok := m[n]; ok {
			names[i] = to
		}
	}
}

// label_replace(v, dst, repl, src, regex) 与 label_join(v, dst, sep, src...) 中的标签名参数
func labelArgIndexes(fn string, argc int) []int {
	switch fn {
	case "label_replace":
		return []int{1, 3}
	case "label_join":
		idx := []int{1}
		for i := 3; i < argc; i++ {
			idx = append(idx, i)
		}
		return idx
	}
	return nil
}

func renamePromQL(input string, m map[string]string) renameOut {
	expr, err := promParser.ParseExpr(input)
	if err != nil {
		return renameOut{Error: err.Error()}
	}
	parser.Inspect(expr, func(node parser.Node, _ []parser.Node) error {
		switch n := node.(type) {
		case *parser.VectorSelector:
			for _, lm := range n.LabelMatchers {
				if to, ok := m[lm.Name]; ok {
					lm.Name = to
				}
			}
		case *parser.AggregateExpr:
			renameAll(n.Grouping, m)
		case *parser.BinaryExpr:
			if n.VectorMatching != nil {
				renameAll(n.VectorMatching.MatchingLabels, m)
				renameAll(n.VectorMatching.Include, m)
			}
		case *parser.Call:
			for _, i := range labelArgIndexes(n.Func.Name, len(n.Args)) {
				if s, ok := n.Args[i].(*parser.StringLiteral); ok {
					if to, ok := m[s.Val]; ok {
						s.Val = to
					}
				}
			}
		}
		return nil
	})
	out := expr.String()
	if _, err := promParser.ParseExpr(out); err != nil {
		panic(fmt.Sprintf("改写后的 PromQL 无法解析：%s：%v", out, err))
	}
	return renameOut{OK: true, Expr: out}
}

func renameMetricsQL(input string, m map[string]string) renameOut {
	expr, err := metricsql.Parse(input)
	if err != nil {
		return renameOut{Error: err.Error()}
	}
	metricsql.VisitAll(expr, func(e metricsql.Expr) {
		switch n := e.(type) {
		case *metricsql.MetricExpr:
			for gi := range n.LabelFilterss {
				for fi := range n.LabelFilterss[gi] {
					if to, ok := m[n.LabelFilterss[gi][fi].Label]; ok {
						n.LabelFilterss[gi][fi].Label = to
					}
				}
			}
		case *metricsql.AggrFuncExpr:
			renameAll(n.Modifier.Args, m)
		case *metricsql.BinaryOpExpr:
			renameAll(n.GroupModifier.Args, m)
			renameAll(n.JoinModifier.Args, m)
		case *metricsql.FuncExpr:
			for _, i := range labelArgIndexes(n.Name, len(n.Args)) {
				if s, ok := n.Args[i].(*metricsql.StringExpr); ok {
					if to, ok := m[s.S]; ok {
						s.S = to
					}
				}
			}
		}
	})
	out := string(expr.AppendString(nil))
	if _, err := metricsql.Parse(out); err != nil {
		panic(fmt.Sprintf("改写后的 MetricsQL 无法解析：%s：%v", out, err))
	}
	return renameOut{OK: true, Expr: out}
}

func parseSeries(desc string) seriesOut {
	lbls, vals, err := promParser.ParseSeriesDesc(desc)
	if err != nil {
		return seriesOut{Error: err.Error()}
	}
	out := seriesOut{OK: true, Labels: map[string]string{}, Values: make([]any, 0, len(vals))}
	lbls.Range(func(l labels.Label) {
		out.Labels[l.Name] = l.Value
	})
	for _, v := range vals {
		switch {
		case v.Histogram != nil:
			return seriesOut{Error: "夹具不支持原生直方图样本"}
		case v.Omitted:
			out.Values = append(out.Values, nil)
		case value.IsStaleNaN(v.Value):
			out.Values = append(out.Values, "stale")
		case math.IsNaN(v.Value):
			out.Values = append(out.Values, "NaN")
		case math.IsInf(v.Value, 1):
			out.Values = append(out.Values, "+Inf")
		case math.IsInf(v.Value, -1):
			out.Values = append(out.Values, "-Inf")
		default:
			out.Values = append(out.Values, v.Value)
		}
	}
	return out
}

func dialectArg(args []js.Value) string {
	d := args[1].String()
	if d != "promql" && d != "metricsql" {
		panic("未知的查询方言：" + d)
	}
	return d
}

func main() {
	api := js.Global().Get("Object").New()
	api.Set("analyze", js.FuncOf(func(_ js.Value, args []js.Value) any {
		if dialectArg(args) == "metricsql" {
			return toJSON(analyzeMetricsQL(args[0].String()))
		}
		return toJSON(analyzePromQL(args[0].String()))
	}))
	api.Set("renameLabels", js.FuncOf(func(_ js.Value, args []js.Value) any {
		m := map[string]string{}
		if err := json.Unmarshal([]byte(args[2].String()), &m); err != nil {
			panic(err)
		}
		if dialectArg(args) == "metricsql" {
			return toJSON(renameMetricsQL(args[0].String(), m))
		}
		return toJSON(renamePromQL(args[0].String(), m))
	}))
	api.Set("parseSeries", js.FuncOf(func(_ js.Value, args []js.Value) any {
		return toJSON(parseSeries(args[0].String()))
	}))
	js.Global().Set("__srenautixPromql", api)
	// 通知 JS 侧初始化完成，然后保持运行以响应调用
	js.Global().Call("__srenautixPromqlReady")
	select {}
}

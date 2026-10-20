package topology

import (
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

// Problem 是提取拓扑时跳过的一项。外部数据（informer 对象、Argo CD status.resources、Flux inventory、kube-state-metrics 标签）
// 里的单个对象出问题时，只跳过这个对象和以它为端点的边，其余拓扑照常产生。
type Problem struct {
	Kind      string
	Namespace string
	Name      string
	// InvalidKey 为 true 表示对象无法生成合法的 ComponentKey；为 false 表示对象的某个字段无法解析
	InvalidKey bool
	Reason     string
}

// KeyProblem 把 Key 或 NewNode 返回的错误转换成 Problem。
func KeyProblem(err error) Problem {
	var ke *KeyError
	if errors.As(err, &ke) {
		return Problem{Kind: ke.Kind, Namespace: ke.Namespace, Name: ke.Name, InvalidKey: true, Reason: ke.Reason}
	}
	return Problem{InvalidKey: true, Reason: err.Error()}
}

// key 返回键；无法生成时记录问题并返回空串。以空串为端点的边由 edge 丢弃。
func (c *Contribution) key(kind, namespace, name string) string {
	k, err := Key(kind, namespace, name)
	if err != nil {
		c.Problems = append(c.Problems, KeyProblem(err))
		return ""
	}
	return k
}

// ref 贡献一个由引用推出的节点（不是对象自己的节点），返回它的键；无法生成时记录问题并返回空串。
func (c *Contribution) ref(kind, namespace, name, uid string, hub bool) string {
	n, err := NewNode(kind, namespace, name, uid, nil)
	if err != nil {
		c.Problems = append(c.Problems, KeyProblem(err))
		return ""
	}
	n.Hub = hub
	c.Nodes = append(c.Nodes, NodeContribution{Node: n})
	return n.Key
}

// edge 追加一条边；任一端点为空串（键无法生成，问题已经记录）时跳过。
func (c *Contribution) edge(e Edge) {
	if e.From == "" || e.To == "" {
		return
	}
	c.Edges = append(c.Edges, e)
}

// fail 记录一个无法解析的字段。
func (c *Contribution) fail(kind, namespace, name, reason string) {
	c.Problems = append(c.Problems, Problem{Kind: kind, Namespace: namespace, Name: name, Reason: reason})
}

// reportEvery 是同一类问题两次警告日志之间的最短间隔。
const reportEvery = time.Minute

// Reporter 记录跳过的对象：计入 srenautix_topology_invalid_keys_total{source,kind} 或 srenautix_topology_extract_errors_total{source}，
// 并按（来源、kind、类别）限速打印警告，间隔内被抑制的次数写在下一条日志里。
type Reporter struct {
	invalid *prometheus.CounterVec
	errs    *prometheus.CounterVec
	log     *slog.Logger
	now     func() time.Time

	mu    sync.Mutex
	last  map[string]time.Time
	quiet map[string]int
}

// NewReporter 创建 Reporter 并注册它的指标。
func NewReporter(reg prometheus.Registerer, log *slog.Logger) *Reporter {
	r := &Reporter{
		invalid: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "srenautix_topology_invalid_keys_total",
			Help: "提取拓扑时因无法生成合法 ComponentKey 而跳过的对象次数。"}, []string{"source", "kind"}),
		errs: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "srenautix_topology_extract_errors_total",
			Help: "提取拓扑时因字段无法解析而跳过的对象次数。"}, []string{"source"}),
		log: log, now: time.Now, last: map[string]time.Time{}, quiet: map[string]int{},
	}
	reg.MustRegister(r.invalid, r.errs)
	return r
}

// InvalidKeys 返回 srenautix_topology_invalid_keys_total。
func (r *Reporter) InvalidKeys() *prometheus.CounterVec { return r.invalid }

// ExtractErrors 返回 srenautix_topology_extract_errors_total。
func (r *Reporter) ExtractErrors() *prometheus.CounterVec { return r.errs }

// kindLabel 限制指标 kind 标签的取值：只接受合法的 kind 名称，其余（来自外部数据的任意字符串）归为 "invalid"。
func kindLabel(kind string) string {
	if len(kind) > 100 || !kindPattern.MatchString(kind) {
		return "invalid"
	}
	return kind
}

// Report 记录 source（informer 资源名或 kube-state-metrics 指标名）提取时跳过的对象。
func (r *Reporter) Report(source string, ps []Problem) {
	for _, p := range ps {
		kind := kindLabel(p.Kind)
		class := "extract_error"
		if p.InvalidKey {
			class = "invalid_key"
			r.invalid.WithLabelValues(source, kind).Inc()
		} else {
			r.errs.WithLabelValues(source).Inc()
		}
		bucket := source + "\x00" + kind + "\x00" + class
		now := r.now()
		r.mu.Lock()
		last, seen := r.last[bucket]
		if seen && now.Sub(last) < reportEvery {
			r.quiet[bucket]++
			r.mu.Unlock()
			continue
		}
		suppressed := r.quiet[bucket]
		r.last[bucket] = now
		r.quiet[bucket] = 0
		r.mu.Unlock()
		r.log.Warn("skipped an object while extracting topology", "source", source, "class", class, "kind", p.Kind,
			"namespace", p.Namespace, "name", p.Name, "reason", p.Reason, "suppressed_since_last_log", suppressed)
	}
}

// Package history 用 kube-state-metrics 的历史序列重建过去的拓扑（DESIGN §3.3、§4.1、§14.5），供回放和观察模式的首次成绩单使用，
// 也用于实体解析的最后一层（informer 缓存与墓碑都查不到时，按 Pod IP 或名称回查）。
//
// 每个 kube-state-metrics 指标按天分段做区间查询；同一节点或边在相邻样本间隔不超过 2 个步长时视为连续存在，
// 得到一组闭区间 [首个样本, 末个样本 + 步长)。区间延续到查询窗口末尾的，valid_to 为 null。
package history

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/prometheus/common/model"

	"github.com/Zzhihon/SreNautix/internal/spoke/reader/query"
	"github.com/Zzhihon/SreNautix/internal/spoke/reader/topology"
)

// Config 是历史重建的配置。
type Config struct {
	Datasource string `json:"datasource"`
	// Matchers 追加到每个指标选择器里，例如 cluster="a"（多个集群写入同一个后端时使用）
	Matchers string `json:"matchers"`
	// Step 是查询步长，默认 5m
	Step time.Duration `json:"step"`
	// Chunk 是单次区间查询覆盖的时长，默认 24h
	Chunk time.Duration `json:"chunk"`
	// MaxSeries 与 MaxBytes 是单次查询的上限
	MaxSeries int   `json:"max_series"`
	MaxBytes  int64 `json:"max_bytes"`
	// MaxWindow 是单次重建允许的最大时间窗口，默认 15 天
	MaxWindow time.Duration `json:"max_window"`
}

// Rebuilder 执行历史重建。
type Rebuilder struct {
	cfg     Config
	cluster string
	exec    *query.Executor
	rep     *topology.Reporter
}

// New 创建 Rebuilder，未填写的配置项取默认值；chunk 不是 step 的整数倍时返回错误。rep 记录标签值无法生成合法键而跳过的序列。
func New(cfg Config, clusterID string, exec *query.Executor, rep *topology.Reporter) (*Rebuilder, error) {
	if cfg.Step == 0 {
		cfg.Step = 5 * time.Minute
	}
	if cfg.Chunk == 0 {
		cfg.Chunk = 24 * time.Hour
	}
	if cfg.MaxSeries == 0 {
		cfg.MaxSeries = 50000
	}
	if cfg.MaxBytes == 0 {
		cfg.MaxBytes = 128 << 20
	}
	if cfg.MaxWindow == 0 {
		cfg.MaxWindow = 15 * 24 * time.Hour
	}
	if cfg.Chunk%cfg.Step != 0 {
		return nil, fmt.Errorf("history: chunk %s must be a multiple of step %s", cfg.Chunk, cfg.Step)
	}
	return &Rebuilder{cfg: cfg, cluster: clusterID, exec: exec, rep: rep}, nil
}

// item 是从一条序列推出的节点或边。
type item struct {
	node *topology.Node
	edge *topology.Edge
}

// id 区分不同的存在：节点按键和 UID 区分（同名 Pod 重建后是另一个对象），边按端点和关系区分。
func (it item) id() string {
	if it.node != nil {
		uid := ""
		if it.node.UID != nil {
			uid = *it.node.UID
		}
		return "n|" + it.node.Key + "|" + uid
	}
	return "e|" + it.edge.ID()
}

// rule 把一个 kube-state-metrics 指标的标签集转换成节点和边。
type rule struct {
	metric string
	derive func(l map[string]string, b *builder)
}

// builder 收集一条序列推出的节点和边。标签值无法生成合法的键时记录问题，跳过这个节点和以它为端点的边。
type builder struct {
	items    []item
	problems []topology.Problem
}

// node 追加一个节点并返回它的键；无法生成时返回空串。
func (b *builder) node(kind, ns, name, uid string, hub bool) string {
	n, err := topology.NewNode(kind, ns, name, uid, nil)
	if err != nil {
		b.problems = append(b.problems, topology.KeyProblem(err))
		return ""
	}
	n.Hub = hub
	b.items = append(b.items, item{node: &n})
	return n.Key
}

// key 返回不在本条序列中产生节点的端点的键；无法生成时返回空串。
func (b *builder) key(kind, ns, name string) string {
	k, err := topology.Key(kind, ns, name)
	if err != nil {
		b.problems = append(b.problems, topology.KeyProblem(err))
		return ""
	}
	return k
}

// edge 追加一条结构性边；任一端点为空串时跳过。
func (b *builder) edge(from, to, rel string, scope topology.Scope, ev string) {
	if from == "" || to == "" {
		return
	}
	e := topology.Structural(from, to, rel, scope, ev)
	b.items = append(b.items, item{edge: &e})
}

// ownerKindFromKSM 把 kube-state-metrics 的 owner_kind 转换成 ComponentKey 的 kind。kube-state-metrics 不输出 owner 的 API 组，
// 内置控制器按 Kind 识别；其余 Kind 无法确定 API 组，不产生边。
var ownerKinds = map[string]bool{"ReplicaSet": true, "Deployment": true, "StatefulSet": true, "DaemonSet": true, "Job": true, "CronJob": true, "Node": true}

var rules = []rule{
	{metric: "kube_node_info", derive: func(l map[string]string, b *builder) {
		if l["node"] != "" {
			b.node("Node", "", l["node"], "", false)
		}
	}},
	{metric: "kube_pod_info", derive: func(l map[string]string, b *builder) {
		ns, pod := l["namespace"], l["pod"]
		if ns == "" || pod == "" {
			return
		}
		p := b.node("Pod", ns, pod, l["uid"], false)
		if n := l["node"]; n != "" {
			b.edge(p, b.node("Node", "", n, "", false), topology.RelRunsOn, topology.ScopeInstance, "kube_pod_info node")
		}
	}},
	{metric: "kube_pod_owner", derive: func(l map[string]string, b *builder) {
		ns, pod, kind, name := l["namespace"], l["pod"], l["owner_kind"], l["owner_name"]
		if ns == "" || pod == "" || !ownerKinds[kind] || name == "" || name == "<none>" {
			return
		}
		owner := b.node(kind, topology.OwnerNamespace(kind, ns), name, "", false)
		b.edge(b.key("Pod", ns, pod), owner, topology.RelOwnedBy, topology.ScopeService, "kube_pod_owner")
	}},
	{metric: "kube_replicaset_owner", derive: func(l map[string]string, b *builder) {
		ns, rs, kind, name := l["namespace"], l["replicaset"], l["owner_kind"], l["owner_name"]
		if ns == "" || rs == "" || !ownerKinds[kind] || name == "" || name == "<none>" {
			return
		}
		self := b.node("ReplicaSet", ns, rs, "", false)
		b.edge(self, b.node(kind, topology.OwnerNamespace(kind, ns), name, "", false), topology.RelOwnedBy, topology.ScopeService, "kube_replicaset_owner")
	}},
	{metric: "kube_job_owner", derive: func(l map[string]string, b *builder) {
		ns, job, kind, name := l["namespace"], l["job_name"], l["owner_kind"], l["owner_name"]
		if ns == "" || job == "" || !ownerKinds[kind] || name == "" || name == "<none>" {
			return
		}
		self := b.node("Job", ns, job, "", false)
		b.edge(self, b.node(kind, topology.OwnerNamespace(kind, ns), name, "", false), topology.RelOwnedBy, topology.ScopeService, "kube_job_owner")
	}},
	{metric: "kube_pod_spec_volumes_persistentvolumeclaims_info", derive: func(l map[string]string, b *builder) {
		ns, pod, claim := l["namespace"], l["pod"], l["persistentvolumeclaim"]
		if ns == "" || pod == "" || claim == "" {
			return
		}
		pvc := b.node("PersistentVolumeClaim", ns, claim, "", false)
		b.edge(b.key("Pod", ns, pod), pvc, topology.RelMounts, topology.ScopeInstance, "volume "+l["volume"])
	}},
	{metric: "kube_persistentvolumeclaim_info", derive: func(l map[string]string, b *builder) {
		ns, claim, pv := l["namespace"], l["persistentvolumeclaim"], l["volumename"]
		if ns == "" || claim == "" {
			return
		}
		self := b.node("PersistentVolumeClaim", ns, claim, "", false)
		if pv != "" {
			b.edge(self, b.node("PersistentVolume", "", pv, "", false), topology.RelBoundTo, topology.ScopeInstance, "kube_persistentvolumeclaim_info volumename")
		}
	}},
	{metric: "kube_persistentvolume_info", derive: func(l map[string]string, b *builder) {
		pv, driver := l["persistentvolume"], l["csi_driver"]
		if pv == "" {
			return
		}
		self := b.node("PersistentVolume", "", pv, "", false)
		if driver != "" {
			b.edge(self, b.node(topology.KindCSIDriver, "", driver, "", true), topology.RelProvisionedBy, topology.ScopeInstance, "kube_persistentvolume_info csi_driver")
		}
	}},
	{metric: "kube_service_info", derive: func(l map[string]string, b *builder) {
		if l["namespace"] != "" && l["service"] != "" {
			b.node("Service", l["namespace"], l["service"], l["uid"], false)
		}
	}},
}

// interval 是一个存在区间：[from, to)；open 表示延续到窗口末尾。
type interval struct {
	from, to time.Time
	open     bool
}

// presence 累积每个节点或边的样本时间。
type presence struct {
	it    item
	times []int64
}

// Request 是历史重建请求。
type Request struct {
	RequestID string    `json:"request_id"`
	From      time.Time `json:"from"`
	To        time.Time `json:"to"`
}

// Result 是历史重建结果。事件序号在本次结果内从 1 编排，是独立于实时拓扑的版本空间；
// event_id 由（集群、操作、节点或边、valid_from）确定，同一窗口重复重建得到相同的 ID，中心据此去重。
type Result struct {
	RequestID string           `json:"request_id"`
	Status    string           `json:"status"`
	Error     *query.Error     `json:"error,omitempty"`
	From      time.Time        `json:"from"`
	To        time.Time        `json:"to"`
	Step      string           `json:"step"`
	Truncated bool             `json:"truncated"`
	Missing   []string         `json:"missing_metrics"`
	Events    []topology.Event `json:"events"`
}

var eventNS = uuid.MustParse("6f1c8f4e-3b5a-4d8e-9a57-6b0f2c1d7e21")

// Rebuild 重建 [from, to) 内的拓扑。
func (r *Rebuilder) Rebuild(ctx context.Context, req Request) Result {
	from, to := req.From.UTC(), req.To.UTC()
	res := Result{RequestID: req.RequestID, Status: "ok", From: from, To: to, Step: r.cfg.Step.String(), Missing: []string{}, Events: []topology.Event{}}
	if !to.After(from) || to.Sub(from) > r.cfg.MaxWindow {
		res.Status = "error"
		res.Error = &query.Error{Code: query.CodeBadRange, Message: fmt.Sprintf("window must be positive and at most %s", r.cfg.MaxWindow)}
		return res
	}
	limits := r.exec.Limits()
	limits.MaxSeries = r.cfg.MaxSeries
	limits.MaxBytes = r.cfg.MaxBytes
	limits.MaxRange = r.cfg.Chunk
	limits.Timeout = 60 * time.Second

	// 窗口按步长对齐（VictoriaMetrics 会把区间查询的起点对齐到步长，两种后端因此取到相同的点）
	from = from.Truncate(r.cfg.Step)
	res.From = from
	final := from.Add(to.Sub(from).Truncate(r.cfg.Step))
	acc := map[string]*presence{}
	for _, ru := range rules {
		seen := false
		for start := from; !start.After(final); start = start.Add(r.cfg.Chunk) {
			end := start.Add(r.cfg.Chunk)
			if end.After(final) {
				end = final
			}
			if !end.After(start) {
				// 只剩一个点时用 1 个步长的区间取到它
				start = end.Add(-r.cfg.Step)
			}
			s, e := start, end
			q := query.Request{RequestID: req.RequestID + "/" + ru.metric, Datasource: r.cfg.Datasource, Start: &s, End: &e, Step: model.Duration(r.cfg.Step).String()}
			// 显式窗口的 last_over_time：点 t 表示 (t−step, t] 内出现过，不依赖两种后端各自的回看与过期规则
			expr := "last_over_time(" + r.selector(ru.metric) + "[" + model.Duration(r.cfg.Step).String() + "])"
			out := r.exec.Builtin(ctx, q, expr, limits)
			if out.Error != nil {
				res.Status = "error"
				res.Error = out.Error
				res.Events = []topology.Event{}
				return res
			}
			res.Truncated = res.Truncated || out.Truncated
			for _, series := range out.Series {
				seen = true
				var b builder
				ru.derive(series.Labels, &b)
				r.rep.Report(ru.metric, b.problems)
				for _, it := range b.items {
					p, ok := acc[it.id()]
					if !ok {
						p = &presence{it: it}
						acc[it.id()] = p
					}
					for _, smp := range series.Samples {
						p.times = append(p.times, smp.T)
					}
				}
			}
		}
		if !seen {
			res.Missing = append(res.Missing, ru.metric)
		}
	}
	res.Events = r.events(acc, from, final)
	return res
}

func (r *Rebuilder) selector(metric string) string {
	if r.cfg.Matchers == "" {
		return metric
	}
	return metric + "{" + r.cfg.Matchers + "}"
}

// intervals 把对齐到步长的点合并成存在区间。相邻点相差一个步长视为连续；区间写作 [首点 − 步长, 末点]，
// 其中首点之前的步长内对象已经出现（下限不早于窗口起点）。末点等于窗口的最后一个点时区间延续到窗口之外，valid_to 为空。
func intervals(times []int64, step time.Duration, windowStart, final time.Time) []interval {
	sort.Slice(times, func(i, j int) bool { return times[i] < times[j] })
	var out []interval
	var cur *interval
	var last int64
	begin := func(t int64) time.Time {
		f := time.UnixMilli(t).Add(-step).UTC()
		if f.Before(windowStart) {
			return windowStart
		}
		return f
	}
	for i, t := range times {
		if i > 0 && t == last {
			continue
		}
		if cur == nil || t-last > step.Milliseconds() {
			if cur != nil {
				cur.to = time.UnixMilli(last).UTC()
				out = append(out, *cur)
			}
			cur = &interval{from: begin(t)}
		}
		last = t
	}
	if cur != nil {
		cur.to = time.UnixMilli(last).UTC()
		cur.open = !time.UnixMilli(last).Before(final)
		out = append(out, *cur)
	}
	return out
}

func (r *Rebuilder) events(acc map[string]*presence, from, final time.Time) []topology.Event {
	ids := make([]string, 0, len(acc))
	for id := range acc {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	var nodes, edges []topology.Event
	for _, id := range ids {
		p := acc[id]
		for _, iv := range intervals(p.times, r.cfg.Step, from, final) {
			ev := topology.Event{ClusterID: r.cluster, ValidFrom: iv.from, Source: topology.SourceKSMHistory}
			if !iv.open {
				t := iv.to
				ev.ValidTo = &t
			}
			if p.it.node != nil {
				n := *p.it.node
				ev.Op, ev.Node = topology.OpNodeUpsert, &n
				nodes = append(nodes, ev)
			} else {
				e := *p.it.edge
				ev.Op, ev.Edge = topology.OpEdgeUpsert, &e
				edges = append(edges, ev)
			}
		}
	}
	all := append(nodes, edges...)
	sort.SliceStable(all, func(i, j int) bool { return all[i].ValidFrom.Before(all[j].ValidFrom) })
	for i := range all {
		all[i].Seq = int64(i) + 1
		var subject string
		if all[i].Node != nil {
			subject = all[i].Node.Key
		} else {
			subject = all[i].Edge.ID()
		}
		all[i].EventID = uuid.NewSHA1(eventNS, []byte(strings.Join([]string{r.cluster, string(all[i].Op), subject, all[i].ValidFrom.Format(time.RFC3339Nano)}, "\x00"))).String()
	}
	if all == nil {
		all = []topology.Event{}
	}
	return all
}

// PodAt 用 kube_pod_info 查询时刻 at 使用 ip 的 Pod（实体解析的最后一层）。
func (r *Rebuilder) PodAt(ctx context.Context, ip string, at time.Time) (topology.Node, string, bool, error) {
	limits := r.exec.Limits()
	limits.MaxSeries = 10
	sel := fmt.Sprintf(`kube_pod_info{pod_ip=%q`, ip)
	if r.cfg.Matchers != "" {
		sel += "," + r.cfg.Matchers
	}
	sel += "}"
	// 用 last_over_time 覆盖抓取间隔：at 时刻前 10 分钟内出现过即可
	expr := "last_over_time(" + sel + "[10m])"
	t := at.UTC()
	out := r.exec.Builtin(ctx, query.Request{RequestID: "resolve-ip", Datasource: r.cfg.Datasource, Time: &t}, expr, limits)
	if out.Error != nil {
		return topology.Node{}, "", false, out.Error
	}
	for _, s := range out.Series {
		l := s.Labels
		if l["namespace"] == "" || l["pod"] == "" || l["host_network"] == "true" {
			continue
		}
		n, err := topology.NewNode("Pod", l["namespace"], l["pod"], l["uid"], nil)
		if err != nil {
			r.rep.Report("kube_pod_info", []topology.Problem{topology.KeyProblem(err)})
			continue
		}
		return n, l["node"], true, nil
	}
	return topology.Node{}, "", false, nil
}

package reader

import (
	"context"
	"time"

	corev1 "k8s.io/api/core/v1"

	"github.com/Zzhihon/SreNautix/internal/spoke/reader/history"
	"github.com/Zzhihon/SreNautix/internal/spoke/reader/hub"
	"github.com/Zzhihon/SreNautix/internal/spoke/reader/kube"
	"github.com/Zzhihon/SreNautix/internal/spoke/reader/query"
	"github.com/Zzhihon/SreNautix/internal/spoke/reader/topology"
)

// Resolver 按 DESIGN §3.3 的顺序解析实体：informer 缓存 → 24 小时墓碑 → kube-state-metrics 历史。
// informer 缓存只代表当前状态，因此只在请求的时刻晚于对象的创建时间时才命中。
type Resolver struct {
	w   *kube.Watcher
	ksm *history.Rebuilder
}

func strp(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func unresolved() *hub.ResolveResult { return &hub.ResolveResult{Status: "ok", Layer: "unresolved"} }

// Resolve 执行一次实体解析。
func (r *Resolver) Resolve(ctx context.Context, req hub.ResolveRequest) *hub.ResolveResult {
	at := req.At.UTC()
	switch {
	case req.PodIP != "" && req.Component == "":
		if p, ok := r.w.PodByIP(req.PodIP); ok && !at.Before(p.CreationTimestamp.Time) {
			return r.fromPod(p)
		}
		if ts, ok := r.w.Tombstones().ByPodIP(req.PodIP, at); ok {
			n := ts.Node
			return &hub.ResolveResult{Status: "ok", Layer: "tombstone", Node: &n, NodeName: strp(ts.NodeName), RootOwner: strp(ts.RootOwner)}
		}
		if r.ksm == nil {
			return unresolved()
		}
		n, nodeName, ok, err := r.ksm.PodAt(ctx, req.PodIP, at)
		if err != nil {
			return &hub.ResolveResult{Status: "error", Error: asQueryError(err), Layer: "unresolved"}
		}
		if !ok {
			return unresolved()
		}
		return &hub.ResolveResult{Status: "ok", Layer: "ksm_history", Node: &n, NodeName: strp(nodeName)}
	case req.Component != "" && req.PodIP == "":
		kind, ns, name, err := topology.ParseKey(req.Component)
		if err != nil {
			return &hub.ResolveResult{Status: "error", Error: &query.Error{Code: query.CodeBadParams, Message: err.Error()}, Layer: "unresolved"}
		}
		if obj, ok := r.w.Object(kind, ns, name); ok && !at.Before(obj.GetCreationTimestamp().Time) {
			if p, isPod := obj.(*corev1.Pod); isPod {
				return r.fromPod(p)
			}
			if n, err := topology.ObjectNode(kind, obj); err == nil {
				return &hub.ResolveResult{Status: "ok", Layer: "informer", Node: &n}
			}
		}
		if n, ok := r.w.Store().Node(req.Component); ok && n.UID == nil {
			// 只有占位节点（对象本身不在监听范围内，例如自定义资源的子对象）：按拓扑中的节点返回
			return &hub.ResolveResult{Status: "ok", Layer: "informer", Node: &n}
		}
		if ts, ok := r.w.Tombstones().ByKey(req.Component, at); ok {
			n := ts.Node
			return &hub.ResolveResult{Status: "ok", Layer: "tombstone", Node: &n, NodeName: strp(ts.NodeName), RootOwner: strp(ts.RootOwner)}
		}
		return unresolved()
	default:
		return &hub.ResolveResult{Status: "error", Error: &query.Error{Code: query.CodeBadParams, Message: "give exactly one of pod_ip and component"}, Layer: "unresolved"}
	}
}

func (r *Resolver) fromPod(p *corev1.Pod) *hub.ResolveResult {
	n, err := topology.ObjectNode("Pod", p)
	if err != nil {
		return unresolved()
	}
	// 顶层 owner 无法生成合法的键时不填 root_owner
	root, _ := topology.RootOwner(r.w, "Pod", p.Namespace, p.Name)
	return &hub.ResolveResult{Status: "ok", Layer: "informer", Node: &n, NodeName: strp(p.Spec.NodeName), RootOwner: strp(root)}
}

func asQueryError(err error) *query.Error {
	if qe, ok := err.(*query.Error); ok {
		return qe
	}
	return &query.Error{Code: query.CodeBackend, Message: err.Error()}
}

// handle 执行一个读取请求。
func (rd *Reader) handle(ctx context.Context, req hub.Request) hub.Result {
	res := hub.Result{RequestID: req.RequestID, Kind: req.Kind}
	now := time.Now()
	if !req.Deadline.After(now) {
		qe := &query.Error{Code: "deadline_exceeded", Message: "request arrived after its deadline"}
		return withError(res, qe)
	}
	ctx, cancel := context.WithDeadline(ctx, req.Deadline)
	defer cancel()
	switch {
	case req.Kind == hub.KindQuery && req.Query != nil:
		q := req.Query
		out := rd.exec.Execute(ctx, query.Request{RequestID: req.RequestID, Datasource: q.Datasource, TemplateID: q.TemplateID, ContentHash: q.ContentHash,
			Params: q.Params, Time: q.Time, Start: q.Start, End: q.End, Step: q.Step, Timeout: q.Timeout})
		res.Query = hub.FromQuery(out)
	case req.Kind == hub.KindHistory && req.History != nil && rd.ksm != nil:
		out := rd.ksm.Rebuild(ctx, history.Request{RequestID: req.RequestID, From: req.History.From, To: req.History.To})
		res.History = hub.FromHistory(out)
	case req.Kind == hub.KindHistory && req.History != nil:
		return withError(res, &query.Error{Code: query.CodeUnknownDS, Message: "kube-state-metrics history is not configured on this reader"})
	case req.Kind == hub.KindResolve && req.Resolve != nil:
		res.Resolve = rd.resolver.Resolve(ctx, *req.Resolve)
	default:
		return withError(res, &query.Error{Code: query.CodeBadParams, Message: "request kind and body do not match"})
	}
	return res
}

func withError(res hub.Result, qe *query.Error) hub.Result {
	now := time.Now().UTC()
	switch res.Kind {
	case hub.KindHistory:
		res.History = &hub.HistoryResult{Status: "error", Error: qe, From: now, To: now, Step: "0s", Missing: []string{}, Events: []topology.Event{}}
	case hub.KindResolve:
		res.Resolve = &hub.ResolveResult{Status: "error", Error: qe, Layer: "unresolved"}
	default:
		res.Kind = hub.KindQuery
		res.Query = &hub.QueryResult{Status: "error", Error: qe, Series: []query.Series{}, Clamped: []string{}, Warnings: []string{}, ExecutedAt: now}
	}
	return res
}

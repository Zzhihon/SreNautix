// Package hub 是 reader 与中心之间的消息类型与客户端，对应 contract/gateway/v1/reader.openapi.yaml。
// 传输与鉴权复用 internal/spoke/tunnel 的出站客户端。
package hub

import (
	"time"

	"github.com/Zzhihon/SreNautix/internal/spoke/reader/alerts"
	"github.com/Zzhihon/SreNautix/internal/spoke/reader/history"
	"github.com/Zzhihon/SreNautix/internal/spoke/reader/query"
	"github.com/Zzhihon/SreNautix/internal/spoke/reader/topology"
	"github.com/Zzhihon/SreNautix/internal/spoke/tunnel"
)

// Hello 是建立会话的请求。
type Hello struct {
	ReaderID string `json:"reader_id"`
	Version  string `json:"version"`
	BootID   string `json:"boot_id"`
}

// Session 是建立会话的响应。
type Session struct {
	tunnel.HubClock
	TopologySeq int64 `json:"topology_seq"`
}

// TopologyAck 是拓扑推送的响应。
type TopologyAck struct {
	tunnel.HubClock
	TopologySeq int64 `json:"topology_seq"`
	Complete    bool  `json:"complete"`
}

// SnapshotPart 是快照的一个分段。
type SnapshotPart struct {
	SnapshotID string                  `json:"snapshot_id"`
	Seq        int64                   `json:"seq"`
	TakenAt    time.Time               `json:"taken_at"`
	Part       int                     `json:"part"`
	Parts      int                     `json:"parts"`
	Nodes      []topology.SnapshotNode `json:"nodes"`
	Edges      []topology.SnapshotEdge `json:"edges"`
}

// EventBatch 是拓扑事件推送的请求体。
type EventBatch struct {
	Events []topology.Event `json:"events"`
}

// 读取请求的种类。
const (
	KindQuery   = "query"
	KindHistory = "ksm_history"
	KindResolve = "resolve"
)

// DeclaredQuery 是中心下发的声明式查询。
type DeclaredQuery struct {
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

// HistoryRequest 是历史重建请求。
type HistoryRequest struct {
	From time.Time `json:"from"`
	To   time.Time `json:"to"`
}

// ResolveRequest 是实体解析请求。
type ResolveRequest struct {
	PodIP     string    `json:"pod_ip,omitempty"`
	Component string    `json:"component,omitempty"`
	At        time.Time `json:"at"`
}

// Request 是一个读取请求。
type Request struct {
	RequestID string          `json:"request_id"`
	Kind      string          `json:"kind"`
	Deadline  time.Time       `json:"deadline"`
	Query     *DeclaredQuery  `json:"query,omitempty"`
	History   *HistoryRequest `json:"history,omitempty"`
	Resolve   *ResolveRequest `json:"resolve,omitempty"`
}

// RequestBatch 是领取读取请求的响应。
type RequestBatch struct {
	tunnel.HubClock
	Requests []Request `json:"requests"`
}

// HistoryResult 是历史重建结果（不含 request_id，request_id 在外层）。
type HistoryResult struct {
	Status    string           `json:"status"`
	Error     *query.Error     `json:"error,omitempty"`
	From      time.Time        `json:"from"`
	To        time.Time        `json:"to"`
	Step      string           `json:"step"`
	Truncated bool             `json:"truncated"`
	Missing   []string         `json:"missing_metrics"`
	Events    []topology.Event `json:"events"`
}

// QueryResult 是查询结果（不含 request_id）。
type QueryResult struct {
	Status     string         `json:"status"`
	Error      *query.Error   `json:"error,omitempty"`
	Rendered   string         `json:"rendered,omitempty"`
	ResultType string         `json:"result_type,omitempty"`
	Series     []query.Series `json:"series"`
	Truncated  bool           `json:"truncated"`
	Clamped    []string       `json:"clamped"`
	Warnings   []string       `json:"warnings"`
	EffStart   *time.Time     `json:"effective_start,omitempty"`
	EffEnd     *time.Time     `json:"effective_end,omitempty"`
	EffStep    string         `json:"effective_step,omitempty"`
	ExecutedAt time.Time      `json:"executed_at"`
	DurationMs int64          `json:"duration_ms"`
}

// ResolveResult 是实体解析结果。
type ResolveResult struct {
	Status    string         `json:"status"`
	Error     *query.Error   `json:"error,omitempty"`
	Layer     string         `json:"layer"`
	Node      *topology.Node `json:"node"`
	NodeName  *string        `json:"node_name"`
	RootOwner *string        `json:"root_owner"`
}

// Result 是一个读取请求的结果。
type Result struct {
	RequestID string         `json:"request_id"`
	Kind      string         `json:"kind"`
	Query     *QueryResult   `json:"query,omitempty"`
	History   *HistoryResult `json:"history,omitempty"`
	Resolve   *ResolveResult `json:"resolve,omitempty"`
}

// ResultBatch 是回传结果的请求体。
type ResultBatch struct {
	Results []Result `json:"results"`
}

// Condition 是 reader 的状态条件（DESIGN §12.4）。
type Condition struct {
	Type    string    `json:"type"`
	Status  string    `json:"status"`
	Reason  string    `json:"reason"`
	Message string    `json:"message,omitempty"`
	Since   time.Time `json:"since"`
}

// 条件类型。
const (
	CondInformersFresh  = "InformersFresh"
	CondTunnelConnected = "TunnelConnected"
	CondClockSkew       = "ClockSkew"
	CondQueryManifest   = "QueryManifest"
	CondDatasource      = "Datasource"
	CondAlertReconcile  = "AlertReconcile"
)

// ClockReport 是心跳中的 apiserver 时钟参考。
type ClockReport struct {
	APIServerTime time.Time `json:"apiserver_time"`
	Offset        float64   `json:"offset_seconds"`
	Uncertainty   float64   `json:"uncertainty_seconds"`
	MeasuredAt    time.Time `json:"measured_at"`
}

// ManifestReport 是心跳中的查询模板清单信息。
type ManifestReport struct {
	PackLock  string `json:"pack_lock"`
	Templates int    `json:"templates"`
}

// Heartbeat 是 reader 的心跳。
type Heartbeat struct {
	ReaderID      string          `json:"reader_id"`
	Version       string          `json:"version"`
	BootID        string          `json:"boot_id"`
	TopologySeq   int64           `json:"topology_seq"`
	Conditions    []Condition     `json:"conditions"`
	Clock         ClockReport     `json:"clock"`
	QueryManifest *ManifestReport `json:"query_manifest"`
}

// PushResult 是回传结果的响应。
type PushResult = tunnel.PushResult

// AlertSnapshot 是告警对账快照。
type AlertSnapshot = alerts.Snapshot

// FromQuery 把执行器结果转换成协议中的查询结果。
func FromQuery(r query.Result) *QueryResult {
	out := &QueryResult{Status: r.Status, Error: r.Error, Rendered: r.Rendered, ResultType: r.ResultType, Series: r.Series,
		Truncated: r.Truncated, Clamped: r.Clamped, Warnings: r.Warnings, EffStep: r.EffStep, ExecutedAt: r.ExecutedAt, DurationMs: r.DurationMs}
	if !r.EffStart.IsZero() {
		s, e := r.EffStart, r.EffEnd
		out.EffStart, out.EffEnd = &s, &e
	}
	return out
}

// FromHistory 把重建结果转换成协议中的历史结果。
func FromHistory(r history.Result) *HistoryResult {
	return &HistoryResult{Status: r.Status, Error: r.Error, From: r.From, To: r.To, Step: r.Step, Truncated: r.Truncated, Missing: r.Missing, Events: r.Events}
}

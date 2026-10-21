// Package topology 把集群对象转换成拓扑节点和边，并以事件形式（valid_from / valid_to）输出。
// 事件结构与 contract/schemas/topology-event.schema.json 一致。
package topology

import (
	"time"
)

// Op 是拓扑事件的操作类型。
type Op string

const (
	OpNodeUpsert Op = "node_upsert"
	OpNodeDelete Op = "node_delete"
	OpEdgeUpsert Op = "edge_upsert"
	OpEdgeDelete Op = "edge_delete"
)

// Source 是拓扑事件的来源。
type Source string

const (
	SourceInformer   Source = "informer"
	SourceKSMHistory Source = "ksm_history"
)

// Provenance 是边的来源类别（DESIGN §4.2）。
type Provenance string

const (
	ProvStructural    Provenance = "structural"
	ProvConfigRef     Provenance = "config_ref"
	ProvNetworkPolicy Provenance = "network_policy"
)

// Scope 是边的作用范围（DESIGN §4.3）。
type Scope string

const (
	ScopeInstance Scope = "instance"
	ScopeService  Scope = "service"
)

// 各来源的默认置信度（DESIGN §4.2）。
const (
	ConfStructural    = 1.0
	ConfConfigRef     = 0.7
	ConfNetworkPolicy = 0.6
)

// Node 是拓扑节点。
type Node struct {
	Key           string            `json:"key"`
	Kind          string            `json:"kind"`
	Namespace     *string           `json:"namespace"`
	Name          string            `json:"name"`
	UID           *string           `json:"uid"`
	Labels        map[string]string `json:"labels"`
	ComponentType *string           `json:"component_type"`
	Hub           bool              `json:"hub"`
	// Images 是 Pod 容器的镜像引用（规范化、去重、排序，见 PodImages）；只有 Pod 节点填写，没有时省略
	Images []string `json:"images,omitempty"`
}

// Edge 表示 From 依赖 To。
type Edge struct {
	From       string     `json:"from"`
	To         string     `json:"to"`
	Relation   string     `json:"relation"`
	Provenance Provenance `json:"provenance"`
	Confidence float64    `json:"confidence"`
	Scope      Scope      `json:"scope"`
	Evidence   string     `json:"evidence"`
}

// ID 是边的身份：同一对端点上同一种关系只有一条边。
func (e Edge) ID() string { return e.From + "|" + e.Relation + "|" + e.To }

// Event 是一条拓扑事件。
type Event struct {
	EventID   string     `json:"event_id"`
	ClusterID string     `json:"cluster_id"`
	Seq       int64      `json:"seq"`
	Op        Op         `json:"op"`
	ValidFrom time.Time  `json:"valid_from"`
	ValidTo   *time.Time `json:"valid_to"`
	Source    Source     `json:"source"`
	Node      *Node      `json:"node"`
	Edge      *Edge      `json:"edge"`
}

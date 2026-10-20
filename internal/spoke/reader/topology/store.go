package topology

import (
	"reflect"
	"sort"
	"sync"
	"time"

	"github.com/google/uuid"
)

// NodeContribution 是某个来源对象贡献的节点。Own 为 true 表示这是该对象自己的节点（权威值）；
// 为 false 表示从引用推出的占位节点（例如 ownerReference 指向的、reader 未监听的 owner）。
type NodeContribution struct {
	Node Node
	Own  bool
}

// Contribution 是一个来源对象当前贡献的全部节点和边。Problems 是提取时跳过的项，不进入存储，由调用方交给 Reporter。
type Contribution struct {
	Nodes    []NodeContribution
	Edges    []Edge
	Problems []Problem
}

type nodeSlot struct {
	by     map[string]NodeContribution
	chosen *Node
	since  time.Time
}

type edgeSlot struct {
	by     map[string]Edge
	chosen *Edge
	since  time.Time
}

type contributed struct {
	nodes []string
	edges []string
}

// Store 按来源对象累计贡献，在节点或边的生效值变化时产生拓扑事件。
// 同一节点或边可能由多个来源对象贡献（例如同一 Deployment 的多个 Pod 贡献同一条配置引用边），
// 只有最后一个贡献者撤回时才产生删除事件。
type Store struct {
	mu      sync.Mutex
	cluster string
	seq     int64
	nodes   map[string]*nodeSlot
	edges   map[string]*edgeSlot
	by      map[string]contributed
}

// NewStore 创建一个空的拓扑存储。
func NewStore(clusterID string) *Store {
	return &Store{cluster: clusterID, nodes: map[string]*nodeSlot{}, edges: map[string]*edgeSlot{}, by: map[string]contributed{}}
}

// RaiseSeq 把序号下限提高到 floor：之后产生的事件序号都大于 floor。
// 隧道握手时中心返回它已接收的最大序号，reader 重启后从这里继续，保证集群内序号单调递增。
func (s *Store) RaiseSeq(floor int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if floor > s.seq {
		s.seq = floor
	}
}

// Seq 返回最近一条事件的序号（拓扑版本）。
func (s *Store) Seq() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.seq
}

// Apply 用 c 替换来源对象 contributor 之前的贡献，返回由此产生的事件。
func (s *Store) Apply(contributor string, c Contribution, at time.Time) []Event {
	s.mu.Lock()
	defer s.mu.Unlock()
	at = at.UTC()
	prev := s.by[contributor]
	var touchedNodes, touchedEdges []string

	nodeKeys := make([]string, 0, len(c.Nodes))
	seenNode := map[string]bool{}
	for _, nc := range c.Nodes {
		k := nc.Node.Key
		if seenNode[k] {
			// 同一来源对象对同一节点只保留一份贡献，权威值优先
			slot := s.nodes[k]
			if nc.Own {
				slot.by[contributor] = nc
			}
			continue
		}
		seenNode[k] = true
		nodeKeys = append(nodeKeys, k)
		slot, ok := s.nodes[k]
		if !ok {
			slot = &nodeSlot{by: map[string]NodeContribution{}}
			s.nodes[k] = slot
		}
		slot.by[contributor] = nc
		touchedNodes = append(touchedNodes, k)
	}
	for _, k := range prev.nodes {
		if !seenNode[k] {
			delete(s.nodes[k].by, contributor)
			touchedNodes = append(touchedNodes, k)
		}
	}

	edgeIDs := make([]string, 0, len(c.Edges))
	seenEdge := map[string]bool{}
	for _, e := range c.Edges {
		id := e.ID()
		slot, ok := s.edges[id]
		if !ok {
			slot = &edgeSlot{by: map[string]Edge{}}
			s.edges[id] = slot
		}
		if seenEdge[id] {
			if e.Confidence > slot.by[contributor].Confidence {
				slot.by[contributor] = e
			}
			continue
		}
		seenEdge[id] = true
		edgeIDs = append(edgeIDs, id)
		slot.by[contributor] = e
		touchedEdges = append(touchedEdges, id)
	}
	for _, id := range prev.edges {
		if !seenEdge[id] {
			delete(s.edges[id].by, contributor)
			touchedEdges = append(touchedEdges, id)
		}
	}

	if len(nodeKeys) == 0 && len(edgeIDs) == 0 {
		delete(s.by, contributor)
	} else {
		s.by[contributor] = contributed{nodes: nodeKeys, edges: edgeIDs}
	}
	return s.settle(touchedNodes, touchedEdges, at)
}

// Remove 撤回来源对象的全部贡献。
func (s *Store) Remove(contributor string, at time.Time) []Event {
	return s.Apply(contributor, Contribution{}, at)
}

// Contributors 返回当前有贡献的来源对象，按字典序排列。
func (s *Store) Contributors() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]string, 0, len(s.by))
	for k := range s.by {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// settle 为每个被触及的节点和边重新选出生效值，生效值变化时产生事件。边的事件排在节点删除之前、节点新增之后，
// 使消费者按序应用时不会看到指向不存在节点的新边。
// 同一节点或边的 valid_from 不早于它上一条事件的 valid_from：首次列举时调用方按对象的创建时间给出 at，
// 而同一节点可能先由占位贡献在更晚的时刻打开，这时取两者中较晚的一个，保证区间不会倒置。
func (s *Store) settle(nodeKeys, edgeIDs []string, at time.Time) []Event {
	var nodeUps, nodeDels, edgeEvents []Event
	for _, k := range dedupe(nodeKeys) {
		slot := s.nodes[k]
		next := pickNode(slot.by)
		when := laterOf(at, slot.since)
		switch {
		case next == nil && slot.chosen == nil:
			delete(s.nodes, k)
		case next == nil:
			old := *slot.chosen
			delete(s.nodes, k)
			nodeDels = append(nodeDels, s.event(OpNodeDelete, when, &old, nil))
		case slot.chosen == nil || !reflect.DeepEqual(*slot.chosen, *next):
			slot.chosen = next
			slot.since = when
			n := *next
			nodeUps = append(nodeUps, s.event(OpNodeUpsert, when, &n, nil))
		}
	}
	for _, id := range dedupe(edgeIDs) {
		slot := s.edges[id]
		next := pickEdge(slot.by)
		when := laterOf(at, slot.since)
		switch {
		case next == nil && slot.chosen == nil:
			delete(s.edges, id)
		case next == nil:
			old := *slot.chosen
			delete(s.edges, id)
			edgeEvents = append(edgeEvents, s.event(OpEdgeDelete, when, nil, &old))
		case slot.chosen == nil || *slot.chosen != *next:
			slot.chosen = next
			slot.since = when
			e := *next
			edgeEvents = append(edgeEvents, s.event(OpEdgeUpsert, when, nil, &e))
		}
	}
	out := make([]Event, 0, len(nodeUps)+len(edgeEvents)+len(nodeDels))
	out = append(out, nodeUps...)
	out = append(out, edgeEvents...)
	out = append(out, nodeDels...)
	// 序号按输出顺序重新编排，保证同一批内单调
	base := s.seq - int64(len(out))
	for i := range out {
		out[i].Seq = base + int64(i) + 1
	}
	return out
}

func (s *Store) event(op Op, at time.Time, n *Node, e *Edge) Event {
	s.seq++
	return Event{EventID: uuid.NewString(), ClusterID: s.cluster, Seq: s.seq, Op: op, ValidFrom: at, Source: SourceInformer, Node: n, Edge: e}
}

func pickNode(by map[string]NodeContribution) *Node {
	if len(by) == 0 {
		return nil
	}
	keys := make([]string, 0, len(by))
	for k := range by {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		if by[k].Own {
			n := by[k].Node
			return &n
		}
	}
	n := by[keys[0]].Node
	return &n
}

func pickEdge(by map[string]Edge) *Edge {
	if len(by) == 0 {
		return nil
	}
	keys := make([]string, 0, len(by))
	for k := range by {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	best := by[keys[0]]
	for _, k := range keys[1:] {
		if by[k].Confidence > best.Confidence {
			best = by[k]
		}
	}
	return &best
}

func laterOf(a, b time.Time) time.Time {
	if b.After(a) {
		return b
	}
	return a
}

func dedupe(in []string) []string {
	seen := map[string]bool{}
	out := in[:0:0]
	for _, v := range in {
		if !seen[v] {
			seen[v] = true
			out = append(out, v)
		}
	}
	sort.Strings(out)
	return out
}

// SnapshotNode 是快照中的一个节点及其生效起点。
type SnapshotNode struct {
	Node      Node      `json:"node"`
	ValidFrom time.Time `json:"valid_from"`
}

// SnapshotEdge 是快照中的一条边及其生效起点。
type SnapshotEdge struct {
	Edge      Edge      `json:"edge"`
	ValidFrom time.Time `json:"valid_from"`
}

// Snapshot 是某个序号下的完整拓扑，用于重新同步：中心以快照为准，关闭快照中不存在的节点和边。
type Snapshot struct {
	ClusterID string         `json:"cluster_id"`
	Seq       int64          `json:"seq"`
	TakenAt   time.Time      `json:"taken_at"`
	Nodes     []SnapshotNode `json:"nodes"`
	Edges     []SnapshotEdge `json:"edges"`
}

// Snapshot 返回当前完整拓扑。
func (s *Store) Snapshot(at time.Time) Snapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	snap := Snapshot{ClusterID: s.cluster, Seq: s.seq, TakenAt: at.UTC(), Nodes: []SnapshotNode{}, Edges: []SnapshotEdge{}}
	for _, slot := range s.nodes {
		if slot.chosen != nil {
			snap.Nodes = append(snap.Nodes, SnapshotNode{Node: *slot.chosen, ValidFrom: slot.since})
		}
	}
	for _, slot := range s.edges {
		if slot.chosen != nil {
			snap.Edges = append(snap.Edges, SnapshotEdge{Edge: *slot.chosen, ValidFrom: slot.since})
		}
	}
	sort.Slice(snap.Nodes, func(i, j int) bool { return snap.Nodes[i].Node.Key < snap.Nodes[j].Node.Key })
	sort.Slice(snap.Edges, func(i, j int) bool { return snap.Edges[i].Edge.ID() < snap.Edges[j].Edge.ID() })
	return snap
}

// Node 返回当前生效的节点。
func (s *Store) Node(key string) (Node, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	slot, ok := s.nodes[key]
	if !ok || slot.chosen == nil {
		return Node{}, false
	}
	return *slot.chosen, true
}

// Counts 返回当前节点数和边数。
func (s *Store) Counts() (nodes, edges int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.nodes), len(s.edges)
}

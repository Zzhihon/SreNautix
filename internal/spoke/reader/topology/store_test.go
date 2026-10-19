package topology

import (
	"testing"
	"time"
)

func ops(evs []Event) []string {
	out := make([]string, 0, len(evs))
	for _, e := range evs {
		subject := ""
		if e.Node != nil {
			subject = e.Node.Key
		} else {
			subject = e.Edge.ID()
		}
		out = append(out, string(e.Op)+" "+subject)
	}
	return out
}

func equal(t *testing.T, got, want []string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("got %d events %v, want %v", len(got), got, want)
	}
	for i := range got {
		if got[i] != want[i] {
			t.Fatalf("event %d: got %q, want %q (all: %v)", i, got[i], want[i], got)
		}
	}
}

func TestStoreRefcountsSharedEdges(t *testing.T) {
	s := NewStore("c1")
	t0 := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	dep := Key("Deployment", "app", "api")
	svc := Key("Service", "db", "pg-rw")
	ref := Edge{From: dep, To: svc, Relation: RelReferences, Provenance: ProvConfigRef, Confidence: ConfConfigRef, Scope: ScopeService, Evidence: "env DB_HOST"}
	pod := func(name string) Contribution {
		return Contribution{Nodes: []NodeContribution{{Node: NewNode("Pod", "app", name, "uid-"+name, nil), Own: true}}, Edges: []Edge{ref}}
	}
	evs := s.Apply(Key("Pod", "app", "api-1"), pod("api-1"), t0)
	equal(t, ops(evs), []string{"node_upsert Pod:app/api-1", "edge_upsert " + ref.ID()})
	if evs[0].Seq != 1 || evs[1].Seq != 2 {
		t.Fatalf("seq: %d %d", evs[0].Seq, evs[1].Seq)
	}
	equal(t, ops(s.Apply(Key("Pod", "app", "api-2"), pod("api-2"), t0.Add(time.Minute))), []string{"node_upsert Pod:app/api-2"})
	// 重复应用同样的贡献不产生事件
	equal(t, ops(s.Apply(Key("Pod", "app", "api-2"), pod("api-2"), t0.Add(2*time.Minute))), nil)
	equal(t, ops(s.Remove(Key("Pod", "app", "api-1"), t0.Add(3*time.Minute))), []string{"node_delete Pod:app/api-1"})
	evs = s.Remove(Key("Pod", "app", "api-2"), t0.Add(4*time.Minute))
	equal(t, ops(evs), []string{"edge_delete " + ref.ID(), "node_delete Pod:app/api-2"})
	if evs[1].Seq != 6 || s.Seq() != 6 {
		t.Fatalf("seq after removals: last event %d, store %d", evs[1].Seq, s.Seq())
	}
	if n, e := s.Counts(); n != 0 || e != 0 {
		t.Fatalf("store not empty: %d nodes, %d edges", n, e)
	}
}

func TestStoreOwnNodeWinsOverPlaceholder(t *testing.T) {
	s := NewStore("c1")
	t0 := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	stub := NewNode("Node", "", "n1", "", nil)
	own := NewNode("Node", "", "n1", "uid-n1", map[string]string{"zone": "a"})
	pod := Contribution{
		Nodes: []NodeContribution{{Node: NewNode("Pod", "x", "p", "", nil), Own: true}, {Node: stub}},
		Edges: []Edge{Structural(Key("Pod", "x", "p"), stub.Key, RelRunsOn, ScopeInstance, "spec.nodeName")},
	}
	evs := s.Apply("Pod:x/p", pod, t0.Add(time.Hour))
	equal(t, ops(evs), []string{"node_upsert Node:n1", "node_upsert Pod:x/p", "edge_upsert Pod:x/p|runs_on|Node:n1"})
	// 节点对象在首次列举时按创建时间（早于占位贡献）出现：valid_from 不得早于上一条
	evs = s.Apply("Node:n1", Contribution{Nodes: []NodeContribution{{Node: own, Own: true}}}, t0)
	equal(t, ops(evs), []string{"node_upsert Node:n1"})
	if *evs[0].Node.UID != "uid-n1" || evs[0].Node.Labels["zone"] != "a" {
		t.Fatalf("own node not chosen: %+v", evs[0].Node)
	}
	if !evs[0].ValidFrom.Equal(t0.Add(time.Hour)) {
		t.Fatalf("valid_from went backwards: %s", evs[0].ValidFrom)
	}
	// 节点对象删除后退回占位值，Pod 仍然引用它
	evs = s.Remove("Node:n1", t0.Add(2*time.Hour))
	equal(t, ops(evs), []string{"node_upsert Node:n1"})
	if evs[0].Node.UID != nil {
		t.Fatalf("placeholder expected after owner removal: %+v", evs[0].Node)
	}
}

func TestStoreRaiseSeqAndSnapshot(t *testing.T) {
	s := NewStore("c1")
	s.RaiseSeq(41)
	t0 := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	evs := s.Apply("Service:a/s", Contribution{Nodes: []NodeContribution{{Node: NewNode("Service", "a", "s", "u", nil), Own: true}}}, t0)
	if evs[0].Seq != 42 {
		t.Fatalf("seq after raise: %d", evs[0].Seq)
	}
	s.RaiseSeq(10)
	snap := s.Snapshot(t0.Add(time.Minute))
	if snap.Seq != 42 || len(snap.Nodes) != 1 || !snap.Nodes[0].ValidFrom.Equal(t0) || len(snap.Edges) != 0 {
		t.Fatalf("snapshot: %+v", snap)
	}
}

func TestStoreEdgeHighestConfidenceWins(t *testing.T) {
	s := NewStore("c1")
	t0 := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	low := Edge{From: "Deployment:a/x", To: "Deployment:b/y", Relation: RelEgressTo, Provenance: ProvNetworkPolicy, Confidence: 0.6, Scope: ScopeService, Evidence: "np"}
	high := low
	high.Confidence = 0.9
	high.Evidence = "runtime"
	s.Apply("NetworkPolicy:a/np", Contribution{Edges: []Edge{low}}, t0)
	evs := s.Apply("Other:a/o", Contribution{Edges: []Edge{high}}, t0.Add(time.Minute))
	if len(evs) != 1 || evs[0].Edge.Confidence != 0.9 {
		t.Fatalf("higher confidence not chosen: %+v", evs)
	}
	evs = s.Remove("Other:a/o", t0.Add(2*time.Minute))
	if len(evs) != 1 || evs[0].Op != OpEdgeUpsert || evs[0].Edge.Confidence != 0.6 {
		t.Fatalf("fallback to remaining contributor: %+v", evs)
	}
}

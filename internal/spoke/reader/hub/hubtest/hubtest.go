// Package hubtest 是按 contract/gateway/v1/reader.openapi.yaml 实现的进程内中心，供 reader 的端到端测试使用。
// 它独立实现中心一侧的语义（拓扑序号、快照应用、序号缺口、读取请求队列、按 ID 去重），并用契约校验每个请求和响应；
// 不复用 reader 的任何类型，契约与实现之间的任何偏差都会表现为测试失败。
package hubtest

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/getkin/kin-openapi/openapi3"
	"github.com/getkin/kin-openapi/openapi3filter"
	"github.com/getkin/kin-openapi/routers"
	"github.com/getkin/kin-openapi/routers/gorillamux"
)

// ContractPath 返回 reader 协议契约文件的路径。
func ContractPath() string {
	_, file, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(file), "..", "..", "..", "..", "..", "contract", "gateway", "v1", "reader.openapi.yaml")
}

// Request 是测试入队的读取请求（原样作为 JSON 下发）。
type Request map[string]any

// Server 是进程内中心。
type Server struct {
	t       testing.TB
	srv     *httptest.Server
	router  routers.Router
	bodies  *bodies
	token   string
	cluster string

	mu   sync.Mutex
	cond *sync.Cond

	topoSeq       int64
	resyncNeeded  bool
	nodes         map[string]json.RawMessage
	edges         map[string]json.RawMessage
	eventIDs      map[string]bool
	dupEvents     int
	ignoredEvents int
	gaps          int
	snapshots     int
	parts         map[string]map[int]json.RawMessage
	hellos        []map[string]any
	heartbeats    []map[string]any
	alerts        []map[string]any
	health        []map[string]any

	queue        []Request
	results      map[string]map[string]any
	dupResults   int
	deliveries   map[string]int
	down         bool
	failAfterOps int
	violations   []string
}

// Start 加载契约并启动中心。
func Start(t testing.TB, cluster, token string) *Server {
	t.Helper()
	loader := openapi3.NewLoader()
	loader.IsExternalRefsAllowed = true
	doc, err := loader.LoadFromFile(ContractPath())
	if err != nil {
		t.Fatalf("load reader contract: %v", err)
	}
	if err := doc.Validate(context.Background()); err != nil {
		t.Fatalf("reader contract invalid: %v", err)
	}
	s := &Server{t: t, token: token, cluster: cluster, nodes: map[string]json.RawMessage{}, edges: map[string]json.RawMessage{},
		eventIDs: map[string]bool{}, parts: map[string]map[int]json.RawMessage{}, results: map[string]map[string]any{}, deliveries: map[string]int{}}
	s.cond = sync.NewCond(&s.mu)
	if s.bodies, err = newBodies(); err != nil {
		t.Fatalf("load contract schemas: %v", err)
	}
	s.srv = httptest.NewServer(http.HandlerFunc(s.serve))
	t.Cleanup(s.srv.Close)
	doc.Servers = openapi3.Servers{{URL: s.srv.URL}}
	s.router, err = gorillamux.NewRouter(doc)
	if err != nil {
		t.Fatal(err)
	}
	// 让长轮询的等待方定期醒来检查截止时间
	go func() {
		for range time.Tick(200 * time.Millisecond) {
			s.cond.Broadcast()
		}
	}()
	return s
}

// URL 返回中心地址。
func (s *Server) URL() string { return s.srv.URL }

func problem(w http.ResponseWriter, status int, code, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"code": code, "message": msg})
}

func (s *Server) violate(format string, args ...any) {
	s.mu.Lock()
	s.violations = append(s.violations, fmt.Sprintf(format, args...))
	s.mu.Unlock()
}

// Violations 返回契约违例（请求或响应不符合契约、语义规则被违反）。
func (s *Server) Violations() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.violations...)
}

func (s *Server) serve(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(r.Body)
	if err != nil {
		problem(w, http.StatusBadRequest, "bad_body", err.Error())
		return
	}
	r.Body = io.NopCloser(bytes.NewReader(body))
	route, params, err := s.router.FindRoute(r)
	if err != nil {
		s.violate("%s %s: no route in contract: %v", r.Method, r.URL.Path, err)
		problem(w, http.StatusNotFound, "not_found", err.Error())
		return
	}
	in := &openapi3filter.RequestValidationInput{Request: r, PathParams: params, Route: route, Options: &openapi3filter.Options{
		MultiError:          true,
		ExcludeRequestBody:  true,
		ExcludeResponseBody: true,
		AuthenticationFunc: func(_ context.Context, ai *openapi3filter.AuthenticationInput) error {
			if ai.RequestValidationInput.Request.Header.Get("Authorization") != "Bearer "+s.token {
				return fmt.Errorf("bad token")
			}
			return nil
		},
	}}
	if err := openapi3filter.ValidateRequest(r.Context(), in); err != nil {
		if strings.Contains(err.Error(), "bad token") {
			problem(w, http.StatusUnauthorized, "unauthorized", "bad token")
			return
		}
		s.violate("%s %s: request does not match contract: %v\n%s", r.Method, r.URL.Path, err, body)
		problem(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	if loc := requestLoc(route.Path, r.Method, route.Operation); loc != "" {
		if err := s.bodies.validate(loc, body); err != nil {
			s.violate("%s %s: request body does not match contract: %v\n%s", r.Method, r.URL.Path, err, body)
			problem(w, http.StatusBadRequest, "invalid_request", err.Error())
			return
		}
	}
	if r.Header.Get("X-SreNautix-Cluster") != s.cluster {
		problem(w, http.StatusForbidden, "cluster_mismatch", "token belongs to another cluster")
		return
	}
	rec := httptest.NewRecorder()
	s.dispatch(rec, r, route.Operation.OperationID, body)
	r.Body = io.NopCloser(bytes.NewReader(body))
	out := &openapi3filter.ResponseValidationInput{RequestValidationInput: in, Status: rec.Code, Header: rec.Header(),
		Options: &openapi3filter.Options{MultiError: true, IncludeResponseStatus: true, ExcludeResponseBody: true}}
	out.SetBodyBytes(rec.Body.Bytes())
	if err := openapi3filter.ValidateResponse(r.Context(), out); err != nil {
		s.violate("%s %s: hub response does not match contract: %v\n%s", r.Method, r.URL.Path, err, rec.Body.String())
	} else if rec.Code == http.StatusNoContent {
		if rec.Body.Len() != 0 {
			s.violate("%s %s: 204 with a body", r.Method, r.URL.Path)
		}
	} else if loc, err := responseLoc(route.Path, r.Method, route.Operation, rec.Code); err != nil {
		s.violate("%s %s: %v", r.Method, r.URL.Path, err)
	} else if err := s.bodies.validate(loc, rec.Body.Bytes()); err != nil {
		s.violate("%s %s: hub response body does not match contract: %v\n%s", r.Method, r.URL.Path, err, rec.Body.String())
	}
	for k, v := range rec.Header() {
		w.Header()[k] = v
	}
	w.WriteHeader(rec.Code)
	_, _ = w.Write(rec.Body.Bytes())
}

func now() string { return time.Now().UTC().Format(time.RFC3339Nano) }

func reply(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(v)
}

func clock(extra map[string]any) map[string]any {
	m := map[string]any{"server_time": now(), "restored_at": nil}
	for k, v := range extra {
		m[k] = v
	}
	return m
}

func (s *Server) dispatch(w http.ResponseWriter, r *http.Request, op string, body []byte) {
	s.mu.Lock()
	down := s.down
	s.mu.Unlock()
	if down {
		problem(w, http.StatusServiceUnavailable, "unavailable", "hub is down")
		return
	}
	var in map[string]any
	if len(body) > 0 {
		dec := json.NewDecoder(bytes.NewReader(body))
		dec.UseNumber()
		if err := dec.Decode(&in); err != nil {
			problem(w, http.StatusBadRequest, "bad_json", err.Error())
			return
		}
	}
	switch op {
	case "readerHello":
		s.mu.Lock()
		s.hellos = append(s.hellos, in)
		seq := s.topoSeq
		s.mu.Unlock()
		reply(w, clock(map[string]any{"topology_seq": seq}))
	case "putTopologySnapshot":
		s.snapshot(w, body)
	case "pushTopologyEvents":
		s.events(w, body)
	case "pushAlertReconcile":
		s.mu.Lock()
		s.alerts = append(s.alerts, in)
		s.mu.Unlock()
		reply(w, clock(nil))
	case "readerHeartbeat":
		s.mu.Lock()
		s.heartbeats = append(s.heartbeats, in)
		s.mu.Unlock()
		reply(w, clock(nil))
	case "pushObjectHealth":
		s.mu.Lock()
		s.health = append(s.health, in)
		s.mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	case "pullReaderRequests":
		s.pull(w, r)
	case "pushReaderResults":
		s.pushResults(w, in)
	default:
		problem(w, http.StatusNotFound, "not_found", op)
	}
}

type node struct {
	Key string `json:"key"`
}

type edge struct {
	From     string `json:"from"`
	To       string `json:"to"`
	Relation string `json:"relation"`
}

func edgeKey(raw json.RawMessage) string {
	var e edge
	if err := json.Unmarshal(raw, &e); err != nil {
		panic(err)
	}
	return e.From + "|" + e.Relation + "|" + e.To
}

func nodeKey(raw json.RawMessage) string {
	var n node
	if err := json.Unmarshal(raw, &n); err != nil {
		panic(err)
	}
	return n.Key
}

// failAfterApply 在状态变更之后返回 503，模拟响应在途中丢失；reader 必须重试，中心按 ID 去重。
func (s *Server) failAfterApply(w http.ResponseWriter) bool {
	if s.failAfterOps > 0 {
		s.failAfterOps--
		problem(w, http.StatusServiceUnavailable, "unavailable", "response lost after apply")
		return true
	}
	return false
}

func (s *Server) snapshot(w http.ResponseWriter, body []byte) {
	var p struct {
		SnapshotID string `json:"snapshot_id"`
		Seq        int64  `json:"seq"`
		Part       int    `json:"part"`
		Parts      int    `json:"parts"`
		Nodes      []struct {
			Node json.RawMessage `json:"node"`
		} `json:"nodes"`
		Edges []struct {
			Edge json.RawMessage `json:"edge"`
		} `json:"edges"`
	}
	if err := json.Unmarshal(body, &p); err != nil {
		problem(w, http.StatusBadRequest, "bad_json", err.Error())
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if p.Part > p.Parts {
		problem(w, http.StatusBadRequest, "bad_part", "part > parts")
		return
	}
	if p.Seq < s.topoSeq {
		s.violations = append(s.violations, fmt.Sprintf("snapshot seq %d below topology_seq %d", p.Seq, s.topoSeq))
		problem(w, http.StatusConflict, "snapshot_seq_behind", "snapshot seq is below topology_seq")
		return
	}
	if s.parts[p.SnapshotID] == nil {
		s.parts[p.SnapshotID] = map[int]json.RawMessage{}
	}
	s.parts[p.SnapshotID][p.Part] = body
	if len(s.parts[p.SnapshotID]) < p.Parts {
		reply(w, clock(map[string]any{"topology_seq": s.topoSeq, "complete": false}))
		return
	}
	nodes := map[string]json.RawMessage{}
	edges := map[string]json.RawMessage{}
	for i := 1; i <= p.Parts; i++ {
		var part struct {
			Nodes []struct {
				Node json.RawMessage `json:"node"`
			} `json:"nodes"`
			Edges []struct {
				Edge json.RawMessage `json:"edge"`
			} `json:"edges"`
		}
		if err := json.Unmarshal(s.parts[p.SnapshotID][i], &part); err != nil {
			panic(err)
		}
		for _, n := range part.Nodes {
			nodes[nodeKey(n.Node)] = n.Node
		}
		for _, e := range part.Edges {
			edges[edgeKey(e.Edge)] = e.Edge
		}
	}
	delete(s.parts, p.SnapshotID)
	s.nodes, s.edges = nodes, edges
	s.topoSeq = p.Seq
	s.resyncNeeded = false
	s.snapshots++
	if s.failAfterApply(w) {
		return
	}
	reply(w, clock(map[string]any{"topology_seq": s.topoSeq, "complete": true}))
}

func (s *Server) events(w http.ResponseWriter, body []byte) {
	var b struct {
		Events []struct {
			EventID string          `json:"event_id"`
			Seq     int64           `json:"seq"`
			Op      string          `json:"op"`
			Cluster string          `json:"cluster_id"`
			Node    json.RawMessage `json:"node"`
			Edge    json.RawMessage `json:"edge"`
		} `json:"events"`
	}
	if err := json.Unmarshal(body, &b); err != nil {
		problem(w, http.StatusBadRequest, "bad_json", err.Error())
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.resyncNeeded {
		problem(w, http.StatusConflict, "resync_required", "hub topology state was reset")
		return
	}
	for _, e := range b.Events {
		if e.Cluster != s.cluster {
			s.violations = append(s.violations, "event for another cluster "+e.Cluster)
		}
		if s.eventIDs[e.EventID] {
			s.dupEvents++
			continue
		}
		if e.Seq <= s.topoSeq {
			s.ignoredEvents++
			continue
		}
		if e.Seq != s.topoSeq+1 {
			s.gaps++
			problem(w, http.StatusConflict, "topology_seq_gap", fmt.Sprintf("expected seq %d, got %d", s.topoSeq+1, e.Seq))
			return
		}
		s.eventIDs[e.EventID] = true
		switch e.Op {
		case "node_upsert":
			s.nodes[nodeKey(e.Node)] = e.Node
		case "node_delete":
			delete(s.nodes, nodeKey(e.Node))
		case "edge_upsert":
			s.edges[edgeKey(e.Edge)] = e.Edge
		case "edge_delete":
			delete(s.edges, edgeKey(e.Edge))
		}
		s.topoSeq = e.Seq
	}
	if s.failAfterApply(w) {
		return
	}
	reply(w, clock(map[string]any{"topology_seq": s.topoSeq, "complete": true}))
}

func (s *Server) pull(w http.ResponseWriter, r *http.Request) {
	wait, _ := strconv.Atoi(r.URL.Query().Get("wait"))
	maxN, _ := strconv.Atoi(r.URL.Query().Get("max"))
	if maxN == 0 {
		maxN = 20
	}
	until := time.Now().Add(time.Duration(wait) * time.Second)
	s.mu.Lock()
	defer s.mu.Unlock()
	for {
		var out []Request
		for _, q := range s.queue {
			id := q["request_id"].(string)
			deadline, err := time.Parse(time.RFC3339Nano, q["deadline"].(string))
			if err != nil {
				panic(err)
			}
			_, done := s.results[id]
			// 已回传结果或超过截止时间的请求不再下发
			if done || time.Now().After(deadline) {
				continue
			}
			out = append(out, q)
			if len(out) == maxN {
				break
			}
		}
		if len(out) > 0 || !time.Now().Before(until) || r.Context().Err() != nil {
			for _, q := range out {
				s.deliveries[q["request_id"].(string)]++
			}
			if out == nil {
				out = []Request{}
			}
			reply(w, clock(map[string]any{"requests": out}))
			// 下发后移出队列；结果由 reader 重试回传，直到中心确认
			s.dequeue(out)
			return
		}
		s.cond.Wait()
	}
}

func (s *Server) dequeue(sent []Request) {
	ids := map[string]bool{}
	for _, q := range sent {
		ids[q["request_id"].(string)] = true
	}
	keep := s.queue[:0]
	for _, q := range s.queue {
		if !ids[q["request_id"].(string)] {
			keep = append(keep, q)
		}
	}
	s.queue = keep
}

func (s *Server) pushResults(w http.ResponseWriter, in map[string]any) {
	s.mu.Lock()
	defer s.mu.Unlock()
	accepted, dups := []string{}, []string{}
	for _, raw := range in["results"].([]any) {
		res := raw.(map[string]any)
		id := res["request_id"].(string)
		if _, ok := s.results[id]; ok {
			s.dupResults++
			dups = append(dups, id)
			continue
		}
		s.results[id] = res
		accepted = append(accepted, id)
	}
	s.cond.Broadcast()
	if s.failAfterApply(w) {
		return
	}
	reply(w, map[string]any{"accepted": accepted, "duplicates": dups})
}

// ── 测试控制 ─────────────────────────────────────────────────

// Enqueue 入队一个读取请求。
func (s *Server) Enqueue(req Request) {
	s.mu.Lock()
	s.queue = append(s.queue, req)
	s.mu.Unlock()
	s.cond.Broadcast()
}

// Result 等待并返回请求的结果。
func (s *Server) Result(id string, timeout time.Duration) (map[string]any, bool) {
	deadline := time.Now().Add(timeout)
	s.mu.Lock()
	defer s.mu.Unlock()
	for {
		if r, ok := s.results[id]; ok {
			return r, true
		}
		if time.Now().After(deadline) {
			return nil, false
		}
		s.cond.Wait()
	}
}

// SetDown 让中心对全部请求返回 503。
func (s *Server) SetDown(down bool) {
	s.mu.Lock()
	s.down = down
	s.mu.Unlock()
}

// FailAfterApply 让接下来 n 次写入在应用之后返回 503。
func (s *Server) FailAfterApply(n int) {
	s.mu.Lock()
	s.failAfterOps = n
	s.mu.Unlock()
}

// Reset 模拟中心丢失拓扑状态（例如从备份恢复）：之后的事件推送返回 409 resync_required。
func (s *Server) Reset() {
	s.mu.Lock()
	s.nodes, s.edges = map[string]json.RawMessage{}, map[string]json.RawMessage{}
	s.topoSeq = 0
	s.resyncNeeded = true
	s.mu.Unlock()
}

// Stats 是中心的计数。
type Stats struct {
	TopologySeq   int64
	Snapshots     int
	DupEvents     int
	IgnoredEvents int
	Gaps          int
	DupResults    int
	Hellos        int
	Heartbeats    int
	Alerts        int
}

// Stats 返回计数。
func (s *Server) Stats() Stats {
	s.mu.Lock()
	defer s.mu.Unlock()
	return Stats{TopologySeq: s.topoSeq, Snapshots: s.snapshots, DupEvents: s.dupEvents, IgnoredEvents: s.ignoredEvents, Gaps: s.gaps,
		DupResults: s.dupResults, Hellos: len(s.hellos), Heartbeats: len(s.heartbeats), Alerts: len(s.alerts)}
}

// Topology 返回中心当前的节点与边（规范化的 JSON），按键排序。
func (s *Server) Topology() (nodes, edges map[string]string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	nodes, edges = map[string]string{}, map[string]string{}
	for k, v := range s.nodes {
		nodes[k] = canonical(v)
	}
	for k, v := range s.edges {
		edges[k] = canonical(v)
	}
	return nodes, edges
}

func canonical(raw json.RawMessage) string {
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		panic(err)
	}
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return string(b)
}

// LastHeartbeat 返回最近一次心跳。
func (s *Server) LastHeartbeat() map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.heartbeats) == 0 {
		return nil
	}
	return s.heartbeats[len(s.heartbeats)-1]
}

// LastAlerts 返回最近一次告警对账快照。
func (s *Server) LastAlerts() map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.alerts) == 0 {
		return nil
	}
	return s.alerts[len(s.alerts)-1]
}

// LastHealth 返回最近一次对象健康状态上报。
func (s *Server) LastHealth() map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.health) == 0 {
		return nil
	}
	return s.health[len(s.health)-1]
}

// SortedKeys 返回 map 的键，按字典序。
func SortedKeys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

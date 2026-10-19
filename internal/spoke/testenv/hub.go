package testenv

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Zzhihon/SreNautix/internal/spoke/tunnel"
)

// Hub 是工单协议（contract/gateway/v1/openapi.yaml）中心一侧的实现，供集成测试与不变量测试使用：
// 按 pulled 事件停止下发、按 event_id 去重、返回绑定、记录心跳。
type Hub struct {
	Server  *httptest.Server
	Cluster string
	Token   string

	mu         sync.Mutex
	pending    []tunnel.Ticket
	delivered  map[string]bool // ticket_id → 已收到 pulled
	bindings   map[string]tunnel.Binding
	events     []tunnel.ExecutionEvent
	seen       map[string]bool
	heartbeats []tunnel.Heartbeat
	restoredAt *string
	softPaused bool
	down       bool
	duplicates int
}

// StartHub 启动中心；token 写入 TokenFile 供客户端读取。
func StartHub(t testing.TB, cluster, token string) *Hub {
	t.Helper()
	h := &Hub{Cluster: cluster, Token: token, delivered: map[string]bool{}, bindings: map[string]tunnel.Binding{}, seen: map[string]bool{}}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/spoke/tickets", h.tickets)
	mux.HandleFunc("POST /v1/spoke/events", h.pushEvents)
	mux.HandleFunc("GET /v1/spoke/proposals/{id}/binding", h.binding)
	mux.HandleFunc("POST /v1/spoke/heartbeat", h.heartbeat)
	h.Server = httptest.NewServer(h.auth(mux))
	t.Cleanup(h.Server.Close)
	return h
}

func (h *Hub) problem(w http.ResponseWriter, status int, code, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(tunnel.Problem{Code: code, Message: msg})
}

func (h *Hub) auth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h.mu.Lock()
		down := h.down
		h.mu.Unlock()
		if down {
			h.problem(w, http.StatusServiceUnavailable, "hub_down", "hub is unavailable")
			return
		}
		if r.Header.Get("Authorization") != "Bearer "+h.Token {
			h.problem(w, http.StatusUnauthorized, "unauthorized", "bad token")
			return
		}
		if r.Header.Get(tunnel.ClusterHeader) != h.Cluster {
			h.problem(w, http.StatusForbidden, "cluster_mismatch", "cluster header does not match the token")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (h *Hub) clock() tunnel.HubClock {
	return tunnel.HubClock{ServerTime: time.Now().UTC().Format(time.RFC3339Nano), RestoredAt: h.restoredAt}
}

func (h *Hub) write(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func (h *Hub) tickets(w http.ResponseWriter, r *http.Request) {
	deadline := time.Now().Add(2 * time.Second)
	for {
		h.mu.Lock()
		var out []tunnel.Ticket
		for _, t := range h.pending {
			if !h.delivered[t.TicketID] && !h.softPaused {
				out = append(out, t)
			}
		}
		c := h.clock()
		h.mu.Unlock()
		if len(out) > 0 || time.Now().After(deadline) || r.URL.Query().Get("wait") == "0" {
			if out == nil {
				out = []tunnel.Ticket{}
			}
			h.write(w, tunnel.TicketBatch{HubClock: c, Tickets: out})
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func (h *Hub) pushEvents(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Events []tunnel.ExecutionEvent `json:"events"`
	}
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&body); err != nil || len(body.Events) == 0 {
		h.problem(w, http.StatusBadRequest, "bad_request", "events required")
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	res := tunnel.PushResult{Accepted: []string{}, Duplicates: []string{}}
	for _, ev := range body.Events {
		if h.seen[ev.EventID] {
			h.duplicates++
			res.Duplicates = append(res.Duplicates, ev.EventID)
			continue
		}
		h.seen[ev.EventID] = true
		h.events = append(h.events, ev)
		res.Accepted = append(res.Accepted, ev.EventID)
		if ev.Phase == tunnel.PhasePulled {
			h.delivered[ev.TicketID] = true
		}
	}
	h.write(w, res)
}

func (h *Hub) binding(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	h.mu.Lock()
	b, ok := h.bindings[id]
	b.HubClock = h.clock()
	h.mu.Unlock()
	if !ok {
		h.problem(w, http.StatusNotFound, "not_found", "unknown proposal")
		return
	}
	h.write(w, b)
}

func (h *Hub) heartbeat(w http.ResponseWriter, r *http.Request) {
	var hb tunnel.Heartbeat
	if err := json.NewDecoder(r.Body).Decode(&hb); err != nil {
		h.problem(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	h.mu.Lock()
	h.heartbeats = append(h.heartbeats, hb)
	st := tunnel.HubStatus{HubClock: h.clock(), SoftPaused: h.softPaused}
	h.mu.Unlock()
	h.write(w, st)
}

// Offer 加入一张工单，并按工单内容登记当前绑定。
func (h *Hub) Offer(t tunnel.Ticket) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.pending = append(h.pending, t)
	h.bindings[t.Proposal.ProposalID] = tunnel.Binding{ProposalID: t.Proposal.ProposalID, State: tunnel.BindingCurrent,
		IncidentVersion: t.Proposal.IncidentVersion, RootComponent: t.Proposal.RootComponent, EvidenceFingerprint: t.Proposal.EvidenceFingerprint}
}

// LastOffered 返回最近加入的工单的提议 ID。
func (h *Hub) LastOffered() string {
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.pending) == 0 {
		return ""
	}
	return h.pending[len(h.pending)-1].Proposal.ProposalID
}

// Redeliver 让已确认拉取的工单再被下发一次（模拟中心重复下发）。
func (h *Hub) Redeliver(ticketID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.delivered, ticketID)
}

// SetBinding 修改提议的绑定（事件版本变化、撤回等）。
func (h *Hub) SetBinding(proposalID string, mutate func(*tunnel.Binding)) {
	h.mu.Lock()
	defer h.mu.Unlock()
	b := h.bindings[proposalID]
	mutate(&b)
	h.bindings[proposalID] = b
}

// SetRestoredAt 设置恢复标记。
func (h *Hub) SetRestoredAt(t time.Time) {
	h.mu.Lock()
	defer h.mu.Unlock()
	s := t.UTC().Format(time.RFC3339Nano)
	h.restoredAt = &s
}

// SetDown 让中心对所有请求返回 503。
func (h *Hub) SetDown(down bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.down = down
}

// Events 返回某个执行的事件（按接收顺序）；executionID 为空时返回全部。
func (h *Hub) Events(executionID string) []tunnel.ExecutionEvent {
	h.mu.Lock()
	defer h.mu.Unlock()
	var out []tunnel.ExecutionEvent
	for _, e := range h.events {
		if executionID == "" || e.ExecutionID == executionID {
			out = append(out, e)
		}
	}
	return out
}

// Phases 返回某个执行的事件阶段序列。
func (h *Hub) Phases(executionID string) []string {
	var out []string
	for _, e := range h.Events(executionID) {
		out = append(out, e.Phase)
	}
	return out
}

// EventsForProposal 返回某个提议的事件。
func (h *Hub) EventsForProposal(proposalID string) []tunnel.ExecutionEvent {
	var out []tunnel.ExecutionEvent
	for _, e := range h.Events("") {
		if e.ProposalID == proposalID {
			out = append(out, e)
		}
	}
	return out
}

// LastHeartbeat 返回最近一次心跳。
func (h *Hub) LastHeartbeat() (tunnel.Heartbeat, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.heartbeats) == 0 {
		return tunnel.Heartbeat{}, false
	}
	return h.heartbeats[len(h.heartbeats)-1], true
}

// HeartbeatsSince 返回 n 条之后的心跳数量。
func (h *Hub) HeartbeatCount() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.heartbeats)
}

// PhaseOf 返回某个提议最后一个事件的阶段与原因。
func (h *Hub) PhaseOf(proposalID string) (string, string, string) {
	evs := h.EventsForProposal(proposalID)
	if len(evs) == 0 {
		return "", "", ""
	}
	last := evs[len(evs)-1]
	return last.Phase, last.Reason, last.Requires
}

// HasPhase 表示某个提议有该阶段的事件。
func (h *Hub) HasPhase(proposalID, phase string) bool {
	for _, e := range h.EventsForProposal(proposalID) {
		if e.Phase == phase {
			return true
		}
	}
	return false
}

// Describe 返回提议的事件摘要（失败信息用）。
func (h *Hub) Describe(proposalID string) string {
	var parts []string
	for _, e := range h.EventsForProposal(proposalID) {
		parts = append(parts, e.Phase+"("+e.Reason+": "+e.Message+")")
	}
	return strings.Join(parts, " → ")
}

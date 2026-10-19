// Package tunnel 是分支（reader 与 gateway）到中心的出站连接：bearer token 鉴权、集群标识、请求与错误格式，
// 以及 contract/gateway/v1/openapi.yaml 中工单协议的消息类型。分支只发起出站请求，中心不持有成员集群的凭证。
package tunnel

import "encoding/json"

// TargetRef 是提议的目标对象。
type TargetRef struct {
	Group     string `json:"group"`
	Version   string `json:"version"`
	Kind      string `json:"kind"`
	Namespace string `json:"namespace,omitempty"`
	Name      string `json:"name"`
	UID       string `json:"uid"`
}

// Proposal 是工单中的提议。Params 保留原文：params_hash 基于它的 JCS 形式。
type Proposal struct {
	ProposalID          string          `json:"proposal_id"`
	Action              string          `json:"action"`
	Params              json.RawMessage `json:"params"`
	Target              TargetRef       `json:"target"`
	IncidentID          string          `json:"incident_id"`
	IncidentVersion     int64           `json:"incident_version"`
	RootComponent       string          `json:"root_component"`
	EvidenceFingerprint string          `json:"evidence_fingerprint"`
	IdempotencyKey      string          `json:"idempotency_key"`
	Source              string          `json:"source"`
	ProposalExpiresAt   string          `json:"proposal_expires_at"`
}

// Ticket 是中心下发的已批准工单。Envelope 保留原文：签名基于其中断言的 JCS 形式。
type Ticket struct {
	TicketID    string          `json:"ticket_id"`
	Cluster     string          `json:"cluster"`
	Proposal    Proposal        `json:"proposal"`
	Envelope    json.RawMessage `json:"envelope"`
	DeliveredAt string          `json:"delivered_at"`
}

// HubClock 是中心在每个响应中给出的时间与恢复标记。
type HubClock struct {
	ServerTime string  `json:"server_time"`
	RestoredAt *string `json:"restored_at"`
}

// TicketBatch 是长轮询的响应。
type TicketBatch struct {
	HubClock
	Tickets []Ticket `json:"tickets"`
}

// 执行阶段（DESIGN §9.4）。
const (
	PhasePulled                       = "pulled"
	PhasePrechecked                   = "prechecked"
	PhaseExecuting                    = "executing"
	PhaseVerifying                    = "verifying"
	PhaseVerified                     = "verified"
	PhaseFailed                       = "failed"
	PhaseVerifyFailed                 = "verify_failed"
	PhaseReverted                     = "reverted"
	PhaseAwaitingCompensationApproval = "awaiting_compensation_approval"
	PhaseNeedsHuman                   = "needs_human"
	PhaseStale                        = "stale"
	PhaseExpired                      = "expired"
	PhaseRejected                     = "rejected"
	PhaseIndeterminate                = "indeterminate"
)

// 执行事件的 requires 取值。
const (
	RequiresHumanApproval = "human_approval"
	RequiresTierH         = "tier_h"
	RequiresReapproval    = "reapproval"
)

// AuditRef 指向执行审计链中的一条记录。
type AuditRef struct {
	Seq  int64  `json:"seq"`
	Hash string `json:"hash"`
}

// Compensation 是 compensable 动作校验失败后建议的补偿动作。
type Compensation struct {
	Action string          `json:"action"`
	Params json.RawMessage `json:"params"`
	Reason string          `json:"reason"`
}

// ExecutionEvent 是推回中心的执行事件。
type ExecutionEvent struct {
	EventID       string        `json:"event_id"`
	ExecutionID   string        `json:"execution_id"`
	TicketID      string        `json:"ticket_id"`
	ProposalID    string        `json:"proposal_id"`
	Seq           int64         `json:"seq"`
	Phase         string        `json:"phase"`
	At            string        `json:"at"`
	Reason        string        `json:"reason"`
	Message       string        `json:"message,omitempty"`
	Requires      string        `json:"requires,omitempty"`
	QueuePosition int           `json:"queue_position,omitempty"`
	Audit         *AuditRef     `json:"audit,omitempty"`
	Compensation  *Compensation `json:"compensation,omitempty"`
}

// PushResult 是推送事件的响应。
type PushResult struct {
	Accepted   []string `json:"accepted"`
	Duplicates []string `json:"duplicates"`
}

// 绑定状态。
const (
	BindingCurrent   = "current"
	BindingStale     = "stale"
	BindingWithdrawn = "withdrawn"
	BindingExpired   = "expired"
)

// Binding 是执行前从中心复核的提议绑定。
type Binding struct {
	HubClock
	ProposalID          string `json:"proposal_id"`
	State               string `json:"state"`
	IncidentVersion     int64  `json:"incident_version"`
	RootComponent       string `json:"root_component"`
	EvidenceFingerprint string `json:"evidence_fingerprint"`
}

// Condition 是 gateway 的状态条件（DESIGN §12.4）。
type Condition struct {
	Type    string `json:"type"`
	Status  string `json:"status"`
	Reason  string `json:"reason"`
	Message string `json:"message,omitempty"`
	Since   string `json:"since"`
}

// QueueDomain 是一个冲突域的执行与排队情况。
type QueueDomain struct {
	ConflictDomain    string   `json:"conflict_domain"`
	ActiveExecutionID string   `json:"active_execution_id,omitempty"`
	Queued            []string `json:"queued"`
}

// ClockSkew 是测得的时钟偏差（秒）。
type ClockSkew struct {
	Apiserver float64  `json:"apiserver"`
	NTP       *float64 `json:"ntp,omitempty"`
}

// Heartbeat 是 gateway 上报的状态。
type Heartbeat struct {
	GatewayID   string        `json:"gateway_id"`
	Version     string        `json:"version"`
	Leader      bool          `json:"leader"`
	ProposeOnly bool          `json:"propose_only"`
	Conditions  []Condition   `json:"conditions"`
	Queue       []QueueDomain `json:"queue"`
	ClockSkew   ClockSkew     `json:"clock_skew_seconds"`
}

// HubStatus 是心跳的响应。
type HubStatus struct {
	HubClock
	SoftPaused bool `json:"soft_paused"`
}

// Problem 是中心的错误响应。
type Problem struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

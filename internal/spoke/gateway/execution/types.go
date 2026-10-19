// Package execution 定义 ActionExecution（srenautix.io/v1），gateway 在所在集群中的执行状态（DESIGN §2.1、§9.4）。
// CRD 由 controller-gen 从本文件生成到 contract/gateway/v1/crd/ 与 deploy/helm/srenautix/crds/（make gateway-generate）。
// 名称等于 spec.executionId；spec 创建后不可修改；status 只由持有 Lease 的 gateway 写入，每次阶段迁移追加一条 history。
//
// +groupName=srenautix.io
// +versionName=v1
package execution

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

// GVR 是 ActionExecution 的资源。
var GVR = schema.GroupVersionResource{Group: "srenautix.io", Version: "v1", Resource: "actionexecutions"}

// AnnotationExecutionID 写在每个被 gateway 修改或创建的对象上（DESIGN §2.4）。
const AnnotationExecutionID = "srenautix.io/execution-id"

// LabelExecutionID 写在 gateway 创建的对象（Workflow）上，恢复时按它查找。
const LabelExecutionID = "srenautix.io/execution-id"

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

// TargetRef 是目标对象。
type TargetRef struct {
	Group     string `json:"group"`
	Version   string `json:"version"`
	Kind      string `json:"kind"`
	Resource  string `json:"resource"`
	Namespace string `json:"namespace,omitempty"`
	Name      string `json:"name"`
	UID       string `json:"uid"`
}

// Approver 是批准者。
type Approver struct {
	Principal string `json:"principal"`
	Channel   string `json:"channel"`
}

// Incident 是提议绑定的事件。
type Incident struct {
	ID                  string `json:"id"`
	Version             int64  `json:"version"`
	RootComponent       string `json:"rootComponent"`
	EvidenceFingerprint string `json:"evidenceFingerprint"`
}

// Spec 是不可修改的工单内容。
//
// +kubebuilder:validation:XValidation:rule="self == oldSelf",message="spec is immutable"
type Spec struct {
	// 十六进制 sha256("srenautix-execution-v1\n" + proposal_id + "\n" + assertion_hash) 的前 32 位。
	// +kubebuilder:validation:Pattern=`^[0-9a-f]{32}$`
	ExecutionID string `json:"executionId"`
	// +kubebuilder:validation:MaxLength=64
	TicketID string `json:"ticketId"`
	// +kubebuilder:validation:Pattern=`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`
	ProposalID string `json:"proposalId"`
	// +kubebuilder:validation:MaxLength=63
	Cluster string `json:"cluster"`
	// +kubebuilder:validation:Pattern=`^[a-z][a-z0-9_]{0,62}$`
	Action string `json:"action"`
	// +kubebuilder:validation:Enum=reversible;reversible_recreatable;compensable;irreversible
	Level string `json:"level"`
	// +kubebuilder:validation:Enum=L;H
	Tier   string    `json:"tier"`
	Target TargetRef `json:"target"`
	// 动作参数原文。
	// +kubebuilder:pruning:PreserveUnknownFields
	// +kubebuilder:validation:Type=object
	Params runtime.RawExtension `json:"params"`
	// +kubebuilder:validation:Pattern=`^sha256:[0-9a-f]{64}$`
	ParamsHash string `json:"paramsHash"`
	// +kubebuilder:validation:Pattern=`^sha256:[0-9a-f]{64}$`
	AssertionHash string `json:"assertionHash"`
	// +kubebuilder:validation:Enum=jcs-sha256-v1
	CanonVersion string `json:"canonVersion"`
	// ApprovalEnvelope 的 JSON 原文，供重启后与审计时重新校验。
	// +kubebuilder:validation:MaxLength=65536
	Envelope string   `json:"envelope"`
	Approver Approver `json:"approver"`
	Incident Incident `json:"incident"`
	// +kubebuilder:validation:MaxLength=512
	ConflictDomain    string      `json:"conflictDomain"`
	PulledAt          metav1.Time `json:"pulledAt"`
	ApprovalExpiresAt metav1.Time `json:"approvalExpiresAt"`
	ProposalExpiresAt metav1.Time `json:"proposalExpiresAt"`
}

// CheckResult 是一项预检或校验的结果。
type CheckResult struct {
	ID string `json:"id"`
	// +kubebuilder:validation:Enum=k8s;pdb;promql;git;policy;hub
	Kind   string `json:"kind"`
	Passed bool   `json:"passed"`
	Detail string `json:"detail,omitempty"`
}

// Verification 是执行后校验的结果。
type Verification struct {
	Passed bool          `json:"passed"`
	Checks []CheckResult `json:"checks,omitempty"`
}

// Undo 是撤销的尝试记录。
type Undo struct {
	AttemptID  string       `json:"attemptId,omitempty"`
	StartedAt  *metav1.Time `json:"startedAt,omitempty"`
	FinishedAt *metav1.Time `json:"finishedAt,omitempty"`
	Detail     string       `json:"detail,omitempty"`
}

// Compensation 是 compensable 动作校验失败后建议的补偿动作，需要再次审批。
type Compensation struct {
	Action string `json:"action"`
	// +kubebuilder:pruning:PreserveUnknownFields
	// +kubebuilder:validation:Type=object
	Params runtime.RawExtension `json:"params"`
	Reason string               `json:"reason"`
}

// HistoryEntry 是一次阶段迁移；每条对应一个推回中心的执行事件。
type HistoryEntry struct {
	Seq       int64       `json:"seq"`
	Phase     string      `json:"phase"`
	At        metav1.Time `json:"at"`
	Reason    string      `json:"reason,omitempty"`
	Message   string      `json:"message,omitempty"`
	Requires  string      `json:"requires,omitempty"`
	AuditSeq  int64       `json:"auditSeq,omitempty"`
	AuditHash string      `json:"auditHash,omitempty"`
}

// Status 是执行状态。
type Status struct {
	// +kubebuilder:validation:Enum=pulled;prechecked;executing;verifying;verified;failed;verify_failed;reverted;awaiting_compensation_approval;needs_human;stale;expired;rejected;indeterminate
	Phase string `json:"phase,omitempty"`
	// 进入当前阶段的原因码（小写下划线）。
	Reason string `json:"reason,omitempty"`
	// +kubebuilder:validation:MaxLength=4096
	Message string `json:"message,omitempty"`
	// 写入 executing 的 gateway Pod 名（Lease 身份）。
	Holder string `json:"holder,omitempty"`
	// 本次副作用尝试的 ID，在副作用之前写入。
	AttemptID string `json:"attemptId,omitempty"`
	// 执行前重新核对后的等级（pod_restart 不满足可重建条件时为 irreversible）。
	// +kubebuilder:validation:Enum=reversible;reversible_recreatable;compensable;irreversible
	EffectiveLevel string        `json:"effectiveLevel,omitempty"`
	BlastRadius    int64         `json:"blastRadius,omitempty"`
	Prechecks      []CheckResult `json:"prechecks,omitempty"`
	// 执行前的目标状态（resourceVersion 与撤销、校验所需的原值）。
	// +kubebuilder:pruning:PreserveUnknownFields
	// +kubebuilder:validation:Type=object
	Snapshot *runtime.RawExtension `json:"snapshot,omitempty"`
	// 分步执行的动作已经开始的步骤（例如逐个驱逐时的 Pod UID），在每一步的副作用之前写入。
	Progress     []string       `json:"progress,omitempty"`
	ExecutedAt   *metav1.Time   `json:"executedAt,omitempty"`
	VerifyDueAt  *metav1.Time   `json:"verifyDueAt,omitempty"`
	Verification *Verification  `json:"verification,omitempty"`
	Undo         *Undo          `json:"undo,omitempty"`
	Compensation *Compensation  `json:"compensation,omitempty"`
	History      []HistoryEntry `json:"history,omitempty"`
	// 中心已确认的最大事件序号。
	PushedSeq  int64        `json:"pushedSeq,omitempty"`
	FinishedAt *metav1.Time `json:"finishedAt,omitempty"`
}

// ActionExecution 是一次已批准动作在本集群中的执行。
//
// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:resource:shortName=ae,categories=srenautix
// +kubebuilder:printcolumn:name="Action",type=string,JSONPath=`.spec.action`
// +kubebuilder:printcolumn:name="Target",type=string,JSONPath=`.spec.target.name`
// +kubebuilder:printcolumn:name="Tier",type=string,JSONPath=`.spec.tier`
// +kubebuilder:printcolumn:name="Phase",type=string,JSONPath=`.status.phase`
// +kubebuilder:printcolumn:name="Reason",type=string,JSONPath=`.status.reason`
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=`.metadata.creationTimestamp`
// +kubebuilder:validation:XValidation:rule="self.metadata.name == self.spec.executionId",message="metadata.name must equal spec.executionId"
type ActionExecution struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`
	Spec              Spec   `json:"spec"`
	Status            Status `json:"status,omitempty"`
}

// ActionExecutionList 是列表。
//
// +kubebuilder:object:root=true
type ActionExecutionList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []ActionExecution `json:"items"`
}

// Terminal 表示阶段为终态。
func Terminal(phase string) bool {
	switch phase {
	case PhaseVerified, PhaseFailed, PhaseReverted, PhaseAwaitingCompensationApproval, PhaseNeedsHuman,
		PhaseStale, PhaseExpired, PhaseRejected, PhaseIndeterminate:
		return true
	}
	return false
}

// LastSeq 返回最后一条 history 的序号。
func (x *ActionExecution) LastSeq() int64 {
	if n := len(x.Status.History); n > 0 {
		return x.Status.History[n-1].Seq
	}
	return 0
}

package assertion

import (
	"encoding/json"
	"time"
)

// 绑定与时效的原因码。
const (
	ErrBindingProposal     = "binding_proposal_id"
	ErrBindingAction       = "binding_action"
	ErrBindingParams       = "binding_params_hash"
	ErrBindingTarget       = "binding_target_uid"
	ErrBindingCluster      = "binding_cluster"
	ErrBindingIncident     = "binding_incident_version"
	ErrBindingRoot         = "binding_root_component"
	ErrBindingEvidence     = "binding_evidence_fingerprint"
	ErrExpired             = "expired"
	ErrNotYetValid         = "not_yet_valid"
	ErrExpiresBeforeIssue  = "expires_before_issue"
	ErrIssuedBeforeRestore = "issued_before_restore"
	ErrProposalExpired     = "proposal_expired"
)

// MaxIssueSkew 是签发时间允许超前本地时间的上限（与 DESIGN §9.4 的时钟偏差上限相同）。
const MaxIssueSkew = 5 * time.Second

// Binding 是工单中与断言逐项比对的字段；Params 是工单中动作参数的原文。
type Binding struct {
	ProposalID          string
	Action              string
	Params              json.RawMessage
	TargetUID           string
	Cluster             string
	IncidentVersion     int64
	RootComponent       string
	EvidenceFingerprint string
	ProposalExpiresAt   time.Time
}

// CheckBinding 核对断言与工单的每个绑定字段、审批与提议的时效，以及签发时间晚于恢复标记（DESIGN §15.3）。
// restoredAt 为零值表示中心没有恢复过。
func CheckBinding(v *Verified, b Binding, now, restoredAt time.Time) error {
	a := v.Assertion
	paramsHash, err := Hash(b.Params)
	if err != nil {
		return fail(ErrBindingParams, "params: %v", err)
	}
	switch {
	case a.ProposalID != b.ProposalID:
		return fail(ErrBindingProposal, "assertion %s, ticket %s", a.ProposalID, b.ProposalID)
	case a.Action != b.Action:
		return fail(ErrBindingAction, "assertion %s, ticket %s", a.Action, b.Action)
	case a.ParamsHash != paramsHash:
		return fail(ErrBindingParams, "assertion %s, ticket params %s", a.ParamsHash, paramsHash)
	case a.TargetUID != b.TargetUID:
		return fail(ErrBindingTarget, "assertion %s, ticket %s", a.TargetUID, b.TargetUID)
	case a.Cluster != b.Cluster:
		return fail(ErrBindingCluster, "assertion %s, gateway %s", a.Cluster, b.Cluster)
	case a.IncidentVersion != b.IncidentVersion:
		return fail(ErrBindingIncident, "assertion %d, ticket %d", a.IncidentVersion, b.IncidentVersion)
	case a.RootComponent != b.RootComponent:
		return fail(ErrBindingRoot, "assertion %s, ticket %s", a.RootComponent, b.RootComponent)
	case a.EvidenceFingerprint != b.EvidenceFingerprint:
		return fail(ErrBindingEvidence, "assertion %s, ticket %s", a.EvidenceFingerprint, b.EvidenceFingerprint)
	}
	issued, err := ParseTime(a.IssuedAt)
	if err != nil {
		return fail(ErrSchema, "issued_at: %v", err)
	}
	expires, err := ParseTime(a.ExpiresAt)
	if err != nil {
		return fail(ErrSchema, "expires_at: %v", err)
	}
	switch {
	case !expires.After(issued):
		return fail(ErrExpiresBeforeIssue, "expires_at %s is not after issued_at %s", a.ExpiresAt, a.IssuedAt)
	case issued.After(now.Add(MaxIssueSkew)):
		return fail(ErrNotYetValid, "issued_at %s is ahead of gateway time %s", a.IssuedAt, FormatTime(now))
	case !now.Before(expires):
		return fail(ErrExpired, "approval expired at %s", a.ExpiresAt)
	case !b.ProposalExpiresAt.IsZero() && !now.Before(b.ProposalExpiresAt):
		return fail(ErrProposalExpired, "proposal expired at %s", FormatTime(b.ProposalExpiresAt))
	case !restoredAt.IsZero() && !issued.After(restoredAt):
		return fail(ErrIssuedBeforeRestore, "issued_at %s is not after the restore marker %s", a.IssuedAt, FormatTime(restoredAt))
	}
	return nil
}

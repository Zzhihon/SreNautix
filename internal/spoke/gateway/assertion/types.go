package assertion

import (
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

// 动作等级与风险档位（DESIGN §9.1、§9.2）。
const (
	LevelReversible            = "reversible"
	LevelReversibleRecreatable = "reversible_recreatable"
	LevelCompensable           = "compensable"
	LevelIrreversible          = "irreversible"

	TierL = "L"
	TierH = "H"
)

// 证明类型。
const (
	ProofService  = "service_ed25519"
	ProofWebAuthn = "webauthn_ed25519"
)

// ChannelAuto 是策略自动批准的渠道；审批人为 "auto:<规则名>"。
const ChannelAuto = "auto"

// Assertion 是审批断言 v1 的 15 个字段。
type Assertion struct {
	ProposalID          string `json:"proposal_id"`
	Action              string `json:"action"`
	Level               string `json:"level"`
	Tier                string `json:"tier"`
	ParamsHash          string `json:"params_hash"`
	CanonVersion        string `json:"canon_version"`
	TargetUID           string `json:"target_uid"`
	Cluster             string `json:"cluster"`
	IncidentVersion     int64  `json:"incident_version"`
	RootComponent       string `json:"root_component"`
	EvidenceFingerprint string `json:"evidence_fingerprint"`
	ApproverPrincipal   string `json:"approver_principal"`
	Channel             string `json:"channel"`
	IssuedAt            string `json:"issued_at"`
	ExpiresAt           string `json:"expires_at"`
}

// Reauth 是 H 档服务签名携带的重新认证凭据。
type Reauth struct {
	Method      string `json:"method"`
	AuthTime    string `json:"auth_time"`
	SessionHash string `json:"session_hash"`
}

// Proof 是签名证明；Type 决定哪些字段有效。
type Proof struct {
	Type string `json:"type"`
	// service_ed25519
	KeyID     string          `json:"key_id,omitempty"`
	Signature string          `json:"signature"`
	Reauth    json.RawMessage `json:"reauth,omitempty"`
	// webauthn_ed25519
	CredentialID      string `json:"credential_id,omitempty"`
	AuthenticatorData string `json:"authenticator_data,omitempty"`
	ClientDataJSON    string `json:"client_data_json,omitempty"`
}

// Envelope 保留断言的原始 JSON：哈希与签名都基于原文的 JCS 形式。
type Envelope struct {
	Assertion json.RawMessage `json:"assertion"`
	Proof     Proof           `json:"proof"`
}

// Error 是带原因码的校验错误；原因码与黄金向量中的 expect_error 一致。
type Error struct {
	Code string
	Msg  string
}

func (e *Error) Error() string { return e.Code + ": " + e.Msg }

func fail(code, format string, args ...any) error {
	return &Error{Code: code, Msg: fmt.Sprintf(format, args...)}
}

// Code 返回错误的原因码；不是 *Error 时返回空串。
func Code(err error) string {
	var e *Error
	if errors.As(err, &e) {
		return e.Code
	}
	return ""
}

// ParseTime 解析断言中的时间（UTC，RFC 3339，以 Z 结尾）。
func ParseTime(s string) (time.Time, error) {
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return time.Time{}, err
	}
	return t.UTC(), nil
}

// FormatTime 以契约要求的形式输出时间。
func FormatTime(t time.Time) string { return t.UTC().Format(time.RFC3339Nano) }

// TierRank 返回档位的大小关系：L < H。
func TierRank(t string) int {
	if t == TierH {
		return 2
	}
	return 1
}

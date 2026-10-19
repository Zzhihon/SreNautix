package testenv

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/assertion"
	"github.com/Zzhihon/SreNautix/internal/spoke/tunnel"
)

// Approver 以服务签名密钥签发审批断言（server 一侧的签发逻辑，按 ADR 0020）。
type Approver struct {
	KeyID string
	Key   ed25519.PrivateKey
}

// NewApprover 由固定种子派生服务签名密钥。
func NewApprover(label string) *Approver {
	seed := sha256.Sum256([]byte("srenautix-test-approver\n" + label))
	return &Approver{KeyID: label, Key: ed25519.NewKeyFromSeed(seed[:])}
}

// KeysFile 返回 approver-keys 文档。
func (a *Approver) KeysFile() []byte {
	b, _ := json.Marshal(map[string]any{"version": 1, "keys": []any{map[string]any{
		"use": "service", "key_id": a.KeyID, "public_key": base64.RawURLEncoding.EncodeToString(a.Key.Public().(ed25519.PublicKey))}}})
	return b
}

// Request 描述一次审批。
type Request struct {
	Cluster   string
	Action    string
	Params    map[string]any
	Target    tunnel.TargetRef
	Level     string
	Tier      string
	Principal string
	Channel   string
	// IssuedAt 为零值时取 now。
	IssuedAt time.Time
	TTL      time.Duration
	// Mutate 在签名之前修改断言（构造与工单不一致的断言）。
	Mutate func(*assertion.Assertion)
	// Tamper 在签名之后修改断言（构造签名无效的断言）。
	Tamper func(map[string]any)
}

// Ticket 签发断言并组装工单。
func (a *Approver) Ticket(t testing.TB, now time.Time, r Request) tunnel.Ticket {
	t.Helper()
	params, err := json.Marshal(r.Params)
	if err != nil {
		t.Fatal(err)
	}
	ph, err := assertion.Hash(params)
	if err != nil {
		t.Fatal(err)
	}
	issued := r.IssuedAt
	if issued.IsZero() {
		issued = now
	}
	ttl := r.TTL
	if ttl == 0 {
		ttl = 30 * time.Minute
	}
	ev := sha256.Sum256([]byte("evidence " + r.Target.Name))
	pid := uuid.NewString()
	as := assertion.Assertion{
		ProposalID: pid, Action: r.Action, Level: r.Level, Tier: r.Tier, ParamsHash: ph, CanonVersion: assertion.CanonVersion,
		TargetUID: r.Target.UID, Cluster: r.Cluster, IncidentVersion: 3, RootComponent: "test/" + r.Target.Name,
		EvidenceFingerprint: "sha256:" + hex.EncodeToString(ev[:]), ApproverPrincipal: r.Principal, Channel: r.Channel,
		IssuedAt: assertion.FormatTime(issued), ExpiresAt: assertion.FormatTime(issued.Add(ttl)),
	}
	prop := tunnel.Proposal{ProposalID: pid, Action: r.Action, Params: params, Target: r.Target,
		IncidentID: uuid.NewString(), IncidentVersion: as.IncidentVersion, RootComponent: as.RootComponent,
		EvidenceFingerprint: as.EvidenceFingerprint, IdempotencyKey: ph, Source: "rule",
		ProposalExpiresAt: assertion.FormatTime(issued.Add(2 * ttl))}
	if r.Mutate != nil {
		r.Mutate(&as)
	}
	araw, err := json.Marshal(as)
	if err != nil {
		t.Fatal(err)
	}
	var reauthRaw []byte
	proof := map[string]any{"type": assertion.ProofService, "key_id": a.KeyID}
	if as.Tier == assertion.TierH {
		reauth := map[string]any{"method": "oidc_max_age", "auth_time": assertion.FormatTime(issued.Add(-time.Minute)),
			"session_hash": "sha256:" + hex.EncodeToString(ev[:])}
		proof["reauth"] = reauth
		if reauthRaw, err = json.Marshal(reauth); err != nil {
			t.Fatal(err)
		}
	}
	msg, err := assertion.ServiceSigningInput(araw, reauthRaw)
	if err != nil {
		t.Fatal(err)
	}
	proof["signature"] = base64.RawURLEncoding.EncodeToString(ed25519.Sign(a.Key, msg))
	var am map[string]any
	if err := json.Unmarshal(araw, &am); err != nil {
		t.Fatal(err)
	}
	if r.Tamper != nil {
		r.Tamper(am)
	}
	env, err := json.Marshal(map[string]any{"assertion": am, "proof": proof})
	if err != nil {
		t.Fatal(err)
	}
	return tunnel.Ticket{TicketID: uuid.NewString(), Cluster: r.Cluster, Proposal: prop, Envelope: env, DeliveredAt: assertion.FormatTime(now)}
}

// ExecutionID 返回工单对应的执行 ID。
func ExecutionID(t testing.TB, tk tunnel.Ticket) string {
	t.Helper()
	var env struct {
		Assertion json.RawMessage `json:"assertion"`
	}
	if err := json.Unmarshal(tk.Envelope, &env); err != nil {
		t.Fatal(err)
	}
	h, err := assertion.Hash(env.Assertion)
	if err != nil {
		t.Fatal(err)
	}
	return assertion.ExecutionID(tk.Proposal.ProposalID, h)
}

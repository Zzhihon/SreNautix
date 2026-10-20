package testenv

import (
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
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

// WebAuthn 依赖方设置（测试用）。
const (
	PasskeyRPID   = "console.srenautix.example"
	PasskeyOrigin = "https://console.srenautix.example"
)

// Passkey 是审批人的 ES256 平台通行密钥（P-256），模拟认证器按 WebAuthn Level 3 生成断言。
type Passkey struct {
	CredentialID string
	Principal    string
	Key          *ecdsa.PrivateKey
}

// NewPasskey 由固定种子派生通行密钥。
func NewPasskey(principal string) *Passkey {
	seed := sha256.Sum256([]byte("srenautix-test-passkey\n" + principal))
	k, err := ecdsa.ParseRawPrivateKey(elliptic.P256(), seed[:])
	if err != nil {
		panic(err)
	}
	return &Passkey{CredentialID: base64.RawURLEncoding.EncodeToString([]byte("passkey " + principal)), Principal: principal, Key: k}
}

// KeysFile 返回 approver-keys 文档：服务签名公钥，加上登记的 ES256 通行密钥。
func (a *Approver) KeysFile(passkeys ...*Passkey) []byte {
	keys := []any{map[string]any{
		"use": "service", "key_id": a.KeyID, "public_key": base64.RawURLEncoding.EncodeToString(a.Key.Public().(ed25519.PublicKey))}}
	doc := map[string]any{"version": 1}
	for _, p := range passkeys {
		pub, err := p.Key.PublicKey.Bytes()
		if err != nil {
			panic(err)
		}
		keys = append(keys, map[string]any{"use": "webauthn", "credential_id": p.CredentialID, "principal": p.Principal,
			"alg": assertion.AlgES256, "public_key": base64.RawURLEncoding.EncodeToString(pub)})
		doc["webauthn"] = map[string]any{"rp_id": PasskeyRPID, "origins": []string{PasskeyOrigin}}
	}
	doc["keys"] = keys
	b, _ := json.Marshal(doc)
	return b
}

// proof 生成通行密钥证明：clientDataJSON 的 challenge 绑定断言，签名为 DER 编码的 ECDSA。
func (p *Passkey) proof(t testing.TB, assertionRaw []byte, proofType string) map[string]any {
	t.Helper()
	challenge, err := assertion.WebAuthnChallenge(assertionRaw)
	if err != nil {
		t.Fatal(err)
	}
	cd, err := json.Marshal(map[string]any{"type": "webauthn.get", "challenge": challenge, "origin": PasskeyOrigin, "crossOrigin": false})
	if err != nil {
		t.Fatal(err)
	}
	rp := sha256.Sum256([]byte(PasskeyRPID))
	ad := append(append([]byte{}, rp[:]...), 0x05, 0, 0, 0, 1)
	cdHash := sha256.Sum256(cd)
	digest := sha256.Sum256(append(append([]byte{}, ad...), cdHash[:]...))
	sig, err := ecdsa.SignASN1(rand.Reader, p.Key, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	b := base64.RawURLEncoding.EncodeToString
	return map[string]any{"type": proofType, "credential_id": p.CredentialID, "authenticator_data": b(ad),
		"client_data_json": b(cd), "signature": b(sig)}
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
	// Passkey 不为 nil 时用审批人的通行密钥签名（WebAuthn 证明），ProofType 为空时取 webauthn。
	Passkey   *Passkey
	ProofType string
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
	var proof map[string]any
	if r.Passkey != nil {
		pt := r.ProofType
		if pt == "" {
			pt = assertion.ProofWebAuthn
		}
		proof = r.Passkey.proof(t, araw, pt)
	} else {
		var reauthRaw []byte
		proof = map[string]any{"type": assertion.ProofService, "key_id": a.KeyID}
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
	}
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

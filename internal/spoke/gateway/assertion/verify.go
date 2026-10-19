package assertion

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"time"

	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/schema"
)

// MaxReauthAge 是 H 档重新认证到签发之间允许的最长间隔（DESIGN §9.2：5 分钟内重新认证）。
const MaxReauthAge = 5 * time.Minute

// 签名校验的原因码。
const (
	ErrSchema               = "schema_invalid"
	ErrUnknownKey           = "unknown_key"
	ErrKeyExpired           = "key_expired"
	ErrBadSignature         = "bad_signature"
	ErrReauthRequired       = "reauth_required"
	ErrReauthStale          = "reauth_stale"
	ErrWebAuthnRequired     = "webauthn_required"
	ErrWebAuthnNotSetUp     = "webauthn_not_configured"
	ErrWebAuthnCredential   = "webauthn_unknown_credential"
	ErrWebAuthnPrincipal    = "webauthn_principal_mismatch"
	ErrWebAuthnClientData   = "webauthn_bad_client_data"
	ErrWebAuthnChallenge    = "webauthn_challenge_mismatch"
	ErrWebAuthnOrigin       = "webauthn_origin"
	ErrWebAuthnRPID         = "webauthn_rp_id"
	ErrWebAuthnFlags        = "webauthn_flags"
	ErrWebAuthnBadSignature = "webauthn_bad_signature"
)

// VerifyOptions 是签名校验的配置；RequireWebAuthnForH 对应合规配置。
type VerifyOptions struct {
	RequireWebAuthnForH bool
}

// Verified 是签名校验通过的断言。
type Verified struct {
	Assertion     Assertion
	AssertionRaw  json.RawMessage
	AssertionHash string
	ProofType     string
	KeyID         string
	Reauth        *Reauth
}

// ServiceSigningInput 返回服务签名的签名输入：前缀加 JCS(statement)。
func ServiceSigningInput(assertionRaw, reauthRaw []byte) ([]byte, error) {
	st := map[string]json.RawMessage{"assertion": assertionRaw}
	if len(reauthRaw) > 0 {
		st["reauth"] = reauthRaw
	}
	raw, err := json.Marshal(st)
	if err != nil {
		return nil, err
	}
	c, err := Canonical(raw)
	if err != nil {
		return nil, err
	}
	return append([]byte(ServiceSigningPrefix), c...), nil
}

// WebAuthnChallenge 返回断言对应的 WebAuthn challenge：sha256(JCS(assertion)) 原始字节的 base64url。
func WebAuthnChallenge(assertionRaw []byte) (string, error) {
	c, err := Canonical(assertionRaw)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(c)
	return base64.RawURLEncoding.EncodeToString(sum[:]), nil
}

// Verify 校验信封的结构与签名；绑定、时效与作用域由 CheckBinding 与 gateway 的策略核对。
func (k *Keyring) Verify(envelope []byte, opts VerifyOptions) (*Verified, error) {
	if err := schema.ValidateJSON(schema.ApprovalEnvelope, envelope); err != nil {
		return nil, fail(ErrSchema, "%v", err)
	}
	var env Envelope
	dec := json.NewDecoder(bytes.NewReader(envelope))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&env); err != nil {
		return nil, fail(ErrSchema, "%v", err)
	}
	var a Assertion
	ad := json.NewDecoder(bytes.NewReader(env.Assertion))
	ad.DisallowUnknownFields()
	if err := ad.Decode(&a); err != nil {
		return nil, fail(ErrSchema, "assertion: %v", err)
	}
	issued, err := ParseTime(a.IssuedAt)
	if err != nil {
		return nil, fail(ErrSchema, "issued_at: %v", err)
	}
	hash, err := Hash(env.Assertion)
	if err != nil {
		return nil, fail(ErrSchema, "%v", err)
	}
	v := &Verified{Assertion: a, AssertionRaw: env.Assertion, AssertionHash: hash, ProofType: env.Proof.Type}
	switch env.Proof.Type {
	case ProofService:
		if a.Tier == TierH && opts.RequireWebAuthnForH {
			return nil, fail(ErrWebAuthnRequired, "H 档审批在合规配置下必须使用通行密钥签名")
		}
		if err := k.verifyService(v, env.Proof, issued); err != nil {
			return nil, err
		}
	case ProofWebAuthn:
		if err := k.verifyWebAuthn(v, env.Proof); err != nil {
			return nil, err
		}
	default:
		return nil, fail(ErrSchema, "unknown proof type %q", env.Proof.Type)
	}
	return v, nil
}

func (k *Keyring) verifyService(v *Verified, p Proof, issued time.Time) error {
	key, ok := k.Service[p.KeyID]
	if !ok {
		return fail(ErrUnknownKey, "service key %q is not trusted", p.KeyID)
	}
	if !key.NotAfter.IsZero() && !issued.Before(key.NotAfter) {
		return fail(ErrKeyExpired, "service key %q signs only assertions issued before %s", p.KeyID, FormatTime(key.NotAfter))
	}
	sig, err := base64.RawURLEncoding.DecodeString(p.Signature)
	if err != nil || len(sig) != ed25519.SignatureSize {
		return fail(ErrBadSignature, "signature is not a base64url Ed25519 signature")
	}
	msg, err := ServiceSigningInput(v.AssertionRaw, p.Reauth)
	if err != nil {
		return fail(ErrSchema, "%v", err)
	}
	if !ed25519.Verify(key.Public, msg, sig) {
		return fail(ErrBadSignature, "service signature does not verify with key %q", p.KeyID)
	}
	v.KeyID = p.KeyID
	if len(p.Reauth) > 0 {
		var r Reauth
		if err := json.Unmarshal(p.Reauth, &r); err != nil {
			return fail(ErrSchema, "reauth: %v", err)
		}
		v.Reauth = &r
	}
	if v.Assertion.Tier != TierH {
		return nil
	}
	if v.Reauth == nil {
		return fail(ErrReauthRequired, "H 档服务签名必须携带重新认证凭据")
	}
	at, err := ParseTime(v.Reauth.AuthTime)
	if err != nil {
		return fail(ErrSchema, "reauth.auth_time: %v", err)
	}
	if at.After(issued) || issued.Sub(at) > MaxReauthAge {
		return fail(ErrReauthStale, "重新认证时间 %s 与签发时间 %s 相差超过 5 分钟或晚于签发", v.Reauth.AuthTime, v.Assertion.IssuedAt)
	}
	return nil
}

type clientData struct {
	Type      string `json:"type"`
	Challenge string `json:"challenge"`
	Origin    string `json:"origin"`
}

// authenticatorData 的标志位（WebAuthn §6.1）。
const (
	flagUserPresent  = 0x01
	flagUserVerified = 0x04
)

func (k *Keyring) verifyWebAuthn(v *Verified, p Proof) error {
	if k.RPID == "" {
		return fail(ErrWebAuthnNotSetUp, "approver keys have no webauthn section")
	}
	cred, ok := k.WebAuthn[p.CredentialID]
	if !ok {
		return fail(ErrWebAuthnCredential, "credential %q is not registered", p.CredentialID)
	}
	if cred.Principal != v.Assertion.ApproverPrincipal {
		return fail(ErrWebAuthnPrincipal, "credential belongs to %q, assertion names %q", cred.Principal, v.Assertion.ApproverPrincipal)
	}
	cdj, err := base64.RawURLEncoding.DecodeString(p.ClientDataJSON)
	if err != nil {
		return fail(ErrWebAuthnClientData, "client_data_json: %v", err)
	}
	var cd clientData
	if err := json.Unmarshal(cdj, &cd); err != nil {
		return fail(ErrWebAuthnClientData, "client_data_json: %v", err)
	}
	if cd.Type != "webauthn.get" {
		return fail(ErrWebAuthnClientData, "clientData.type is %q", cd.Type)
	}
	want, err := WebAuthnChallenge(v.AssertionRaw)
	if err != nil {
		return fail(ErrSchema, "%v", err)
	}
	if cd.Challenge != want {
		return fail(ErrWebAuthnChallenge, "challenge does not commit to this assertion")
	}
	if !k.Origins[cd.Origin] {
		return fail(ErrWebAuthnOrigin, "origin %q is not allowed", cd.Origin)
	}
	ad, err := base64.RawURLEncoding.DecodeString(p.AuthenticatorData)
	if err != nil || len(ad) < 37 {
		return fail(ErrWebAuthnClientData, "authenticator_data is shorter than 37 bytes")
	}
	rp := sha256.Sum256([]byte(k.RPID))
	if !bytes.Equal(ad[:32], rp[:]) {
		return fail(ErrWebAuthnRPID, "rpIdHash does not match %q", k.RPID)
	}
	if ad[32]&flagUserPresent == 0 || ad[32]&flagUserVerified == 0 {
		return fail(ErrWebAuthnFlags, "authenticator flags 0x%02x lack UP or UV", ad[32])
	}
	sig, err := base64.RawURLEncoding.DecodeString(p.Signature)
	if err != nil || len(sig) != ed25519.SignatureSize {
		return fail(ErrWebAuthnBadSignature, "signature is not a base64url Ed25519 signature")
	}
	cdHash := sha256.Sum256(cdj)
	msg := append(append([]byte{}, ad...), cdHash[:]...)
	if !ed25519.Verify(cred.Public, msg, sig) {
		return fail(ErrWebAuthnBadSignature, "webauthn signature does not verify")
	}
	v.KeyID = p.CredentialID
	return nil
}

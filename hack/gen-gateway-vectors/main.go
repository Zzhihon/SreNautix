// gen-gateway-vectors 生成 contract/gateway/v1/testvectors/approval-vectors.json：审批断言的规范化、哈希、
// 服务签名与通行密钥签名的黄金向量，以及每个校验失败原因码的反例。Ed25519 签名是确定性的，密钥由固定种子派生，
// 重复运行得到逐字节相同的文件。用法：go run ./hack/gen-gateway-vectors
package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"

	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/assertion"
)

func must[T any](v T, err error) T {
	if err != nil {
		panic(err)
	}
	return v
}

func b64(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

func seed(label string) []byte {
	s := sha256.Sum256([]byte("srenautix-test-vector-seed\n" + label))
	return s[:]
}

type key struct {
	label string
	priv  ed25519.PrivateKey
}

func newKey(label string) key {
	return key{label: label, priv: ed25519.NewKeyFromSeed(seed(label))}
}

func (k key) pub() string { return b64(k.priv.Public().(ed25519.PublicKey)) }

const (
	rpID   = "console.srenautix.example"
	origin = "https://console.srenautix.example"
)

var (
	serviceKey     = newKey("service-2026-10")
	retiredKey     = newKey("service-2026-01")
	untrustedKey   = newKey("untrusted")
	approverCred   = newKey("webauthn-alice")
	credentialID   = b64([]byte("credential-alice-0001"))
	otherCredID    = b64([]byte("credential-bob-0001"))
	otherCredKey   = newKey("webauthn-bob")
	approverAlice  = "oidc:alice@example.org"
	approverBob    = "oidc:bob@example.org"
	baseParams     = map[string]any{"namespace": "payments", "kind": "Deployment", "name": "checkout", "replicas": 3}
	baseProposalID = "6f1c2a8e-4b7d-4e2a-9c3f-1d2e3f4a5b6c"
)

func baseAssertion() map[string]any {
	return map[string]any{
		"proposal_id":          baseProposalID,
		"action":               "workload_scale",
		"level":                "reversible",
		"tier":                 "L",
		"params_hash":          must(assertion.HashValue(baseParams)),
		"canon_version":        assertion.CanonVersion,
		"target_uid":           "0b9c5e7a-3f1d-4c2b-8a6e-5d4c3b2a1f0e",
		"cluster":              "prod-east",
		"incident_version":     7,
		"root_component":       "payments/checkout",
		"evidence_fingerprint": "sha256:" + hex.EncodeToString(seed("evidence")),
		"approver_principal":   approverAlice,
		"channel":              "telegram",
		"issued_at":            "2026-10-20T08:00:00Z",
		"expires_at":           "2026-10-20T08:30:00Z",
	}
}

func clone(m map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range m {
		out[k] = v
	}
	return out
}

func binding() map[string]any {
	return map[string]any{
		"proposal_id":          baseProposalID,
		"action":               "workload_scale",
		"params":               baseParams,
		"target_uid":           "0b9c5e7a-3f1d-4c2b-8a6e-5d4c3b2a1f0e",
		"cluster":              "prod-east",
		"incident_version":     7,
		"root_component":       "payments/checkout",
		"evidence_fingerprint": "sha256:" + hex.EncodeToString(seed("evidence")),
		"proposal_expires_at":  "2026-10-20T09:00:00Z",
	}
}

func signService(k key, keyID string, a map[string]any, reauth map[string]any) map[string]any {
	araw := must(json.Marshal(a))
	var rraw []byte
	if reauth != nil {
		rraw = must(json.Marshal(reauth))
	}
	msg := must(assertion.ServiceSigningInput(araw, rraw))
	proof := map[string]any{"type": assertion.ProofService, "key_id": keyID, "signature": b64(ed25519.Sign(k.priv, msg))}
	if reauth != nil {
		proof["reauth"] = reauth
	}
	return map[string]any{"assertion": a, "proof": proof}
}

type webauthnOpts struct {
	origin    string
	rpID      string
	flags     byte
	typ       string
	challenge string
}

func signWebAuthn(k key, credID string, a map[string]any, o webauthnOpts) map[string]any {
	araw := must(json.Marshal(a))
	challenge := o.challenge
	if challenge == "" {
		challenge = must(assertion.WebAuthnChallenge(araw))
	}
	cd := must(json.Marshal(map[string]any{"type": o.typ, "challenge": challenge, "origin": o.origin, "crossOrigin": false}))
	rp := sha256.Sum256([]byte(o.rpID))
	ad := append(append([]byte{}, rp[:]...), o.flags, 0, 0, 0, 0)
	cdHash := sha256.Sum256(cd)
	sig := ed25519.Sign(k.priv, append(append([]byte{}, ad...), cdHash[:]...))
	return map[string]any{"assertion": a, "proof": map[string]any{
		"type": assertion.ProofWebAuthn, "credential_id": credID, "authenticator_data": b64(ad),
		"client_data_json": b64(cd), "signature": b64(sig),
	}}
}

func goodWebAuthn() webauthnOpts {
	return webauthnOpts{origin: origin, rpID: rpID, flags: 0x05, typ: "webauthn.get"}
}

type envelopeCase struct {
	Name                string         `json:"name"`
	Description         string         `json:"description"`
	Envelope            map[string]any `json:"envelope"`
	Binding             map[string]any `json:"binding"`
	Now                 string         `json:"now"`
	RestoredAt          *string        `json:"restored_at"`
	RequireWebAuthnForH bool           `json:"require_webauthn_for_h"`
	AssertionCanonical  string         `json:"assertion_canonical"`
	AssertionHash       string         `json:"assertion_hash"`
	ExecutionID         string         `json:"execution_id"`
	SigningInput        string         `json:"signing_input_b64url,omitempty"`
	ExpectError         string         `json:"expect_error"`
}

func describe(c envelopeCase) envelopeCase {
	araw := must(json.Marshal(c.Envelope["assertion"]))
	canon := must(assertion.Canonical(araw))
	c.AssertionCanonical = string(canon)
	c.AssertionHash = assertion.Digest(canon)
	c.ExecutionID = assertion.ExecutionID(c.Envelope["assertion"].(map[string]any)["proposal_id"].(string), c.AssertionHash)
	proof := c.Envelope["proof"].(map[string]any)
	if proof["type"] == assertion.ProofService {
		var rraw []byte
		if r, ok := proof["reauth"]; ok {
			rraw = must(json.Marshal(r))
		}
		c.SigningInput = b64(must(assertion.ServiceSigningInput(araw, rraw)))
	}
	if c.Binding == nil {
		c.Binding = binding()
	}
	if c.Now == "" {
		c.Now = "2026-10-20T08:05:00Z"
	}
	return c
}

func str(s string) *string { return &s }

func envelopeCases() []envelopeCase {
	var cases []envelopeCase
	add := func(c envelopeCase) { cases = append(cases, describe(c)) }

	reauth := map[string]any{"method": "oidc_max_age", "auth_time": "2026-10-20T07:58:30Z",
		"session_hash": "sha256:" + hex.EncodeToString(seed("session"))}

	add(envelopeCase{Name: "service_l_valid", Description: "L 档服务签名，全部绑定一致",
		Envelope: signService(serviceKey, "service-2026-10", baseAssertion(), nil)})

	h := baseAssertion()
	h["tier"] = "H"
	h["channel"] = "console"
	add(envelopeCase{Name: "service_h_valid_reauth", Description: "H 档服务签名，携带 90 秒前的重新认证",
		Envelope: signService(serviceKey, "service-2026-10", h, reauth)})
	add(envelopeCase{Name: "service_h_missing_reauth", Description: "H 档服务签名没有重新认证凭据",
		Envelope: signService(serviceKey, "service-2026-10", h, nil), ExpectError: assertion.ErrReauthRequired})
	stale := clone(reauth)
	stale["auth_time"] = "2026-10-20T07:54:59Z"
	add(envelopeCase{Name: "service_h_stale_reauth", Description: "重新认证早于签发 5 分钟以上",
		Envelope: signService(serviceKey, "service-2026-10", h, stale), ExpectError: assertion.ErrReauthStale})
	future := clone(reauth)
	future["auth_time"] = "2026-10-20T08:00:01Z"
	add(envelopeCase{Name: "service_h_reauth_after_issue", Description: "重新认证时间晚于签发时间",
		Envelope: signService(serviceKey, "service-2026-10", h, future), ExpectError: assertion.ErrReauthStale})
	add(envelopeCase{Name: "service_h_compliance_requires_webauthn", Description: "合规配置下 H 档必须用通行密钥",
		Envelope: signService(serviceKey, "service-2026-10", h, reauth), RequireWebAuthnForH: true,
		ExpectError: assertion.ErrWebAuthnRequired})

	// 签名之后篡改断言的任一字段：签名失效
	tamper := map[string]any{
		"proposal_id": "6f1c2a8e-4b7d-4e2a-9c3f-1d2e3f4a5b6d", "action": "workload_rolling_restart",
		"level": "irreversible", "tier": "H", "params_hash": "sha256:" + hex.EncodeToString(seed("other-params")),
		"target_uid": "0b9c5e7a-3f1d-4c2b-8a6e-5d4c3b2a1f0f", "cluster": "prod-west", "incident_version": 8,
		"root_component": "payments/gateway", "evidence_fingerprint": "sha256:" + hex.EncodeToString(seed("other-evidence")),
		"approver_principal": approverBob, "channel": "console", "issued_at": "2026-10-20T08:01:00Z",
		"expires_at": "2026-10-20T09:30:00Z",
	}
	names := []string{"proposal_id", "action", "level", "tier", "params_hash", "target_uid", "cluster", "incident_version",
		"root_component", "evidence_fingerprint", "approver_principal", "channel", "issued_at", "expires_at"}
	for _, field := range names {
		env := signService(serviceKey, "service-2026-10", baseAssertion(), nil)
		a := clone(env["assertion"].(map[string]any))
		a[field] = tamper[field]
		env["assertion"] = a
		add(envelopeCase{Name: "tampered_" + field, Description: "签名后修改 " + field, Envelope: env, ExpectError: assertion.ErrBadSignature})
	}

	// 签名有效，但工单与断言的绑定不一致
	bindingTamper := map[string]struct {
		key   string
		value any
		code  string
	}{
		"proposal_id":          {"proposal_id", "6f1c2a8e-4b7d-4e2a-9c3f-1d2e3f4a5b6d", assertion.ErrBindingProposal},
		"action":               {"action", "workload_rolling_restart", assertion.ErrBindingAction},
		"params":               {"params", map[string]any{"namespace": "payments", "kind": "Deployment", "name": "checkout", "replicas": 30}, assertion.ErrBindingParams},
		"target_uid":           {"target_uid", "0b9c5e7a-3f1d-4c2b-8a6e-5d4c3b2a1f0f", assertion.ErrBindingTarget},
		"cluster":              {"cluster", "prod-west", assertion.ErrBindingCluster},
		"incident_version":     {"incident_version", 8, assertion.ErrBindingIncident},
		"root_component":       {"root_component", "payments/gateway", assertion.ErrBindingRoot},
		"evidence_fingerprint": {"evidence_fingerprint", "sha256:" + hex.EncodeToString(seed("other-evidence")), assertion.ErrBindingEvidence},
	}
	for _, name := range []string{"proposal_id", "action", "params", "target_uid", "cluster", "incident_version", "root_component", "evidence_fingerprint"} {
		bt := bindingTamper[name]
		b := binding()
		b[bt.key] = bt.value
		add(envelopeCase{Name: "binding_" + name, Description: "工单的 " + name + " 与断言不一致",
			Envelope: signService(serviceKey, "service-2026-10", baseAssertion(), nil), Binding: b, ExpectError: bt.code})
	}

	add(envelopeCase{Name: "expired", Description: "审批已过期", Now: "2026-10-20T08:30:00Z",
		Envelope: signService(serviceKey, "service-2026-10", baseAssertion(), nil), ExpectError: assertion.ErrExpired})
	add(envelopeCase{Name: "not_yet_valid", Description: "签发时间超前 gateway 时间 5 秒以上", Now: "2026-10-20T07:59:54Z",
		Envelope: signService(serviceKey, "service-2026-10", baseAssertion(), nil), ExpectError: assertion.ErrNotYetValid})
	add(envelopeCase{Name: "issued_before_restore", Description: "签发时间早于恢复标记", RestoredAt: str("2026-10-20T08:00:00Z"),
		Envelope: signService(serviceKey, "service-2026-10", baseAssertion(), nil), ExpectError: assertion.ErrIssuedBeforeRestore})
	add(envelopeCase{Name: "issued_after_restore", Description: "签发时间晚于恢复标记", RestoredAt: str("2026-10-20T07:59:59Z"),
		Envelope: signService(serviceKey, "service-2026-10", baseAssertion(), nil)})
	pb := binding()
	pb["proposal_expires_at"] = "2026-10-20T08:04:00Z"
	add(envelopeCase{Name: "proposal_expired", Description: "提议的 TTL 已过，审批仍在有效期内", Binding: pb,
		Envelope: signService(serviceKey, "service-2026-10", baseAssertion(), nil), ExpectError: assertion.ErrProposalExpired})
	inv := baseAssertion()
	inv["expires_at"] = "2026-10-20T08:00:00Z"
	add(envelopeCase{Name: "expires_before_issue", Description: "expires_at 不晚于 issued_at",
		Envelope: signService(serviceKey, "service-2026-10", inv, nil), ExpectError: assertion.ErrExpiresBeforeIssue})

	add(envelopeCase{Name: "unknown_key", Description: "key_id 不在信任列表中",
		Envelope: signService(untrustedKey, "service-unknown", baseAssertion(), nil), ExpectError: assertion.ErrUnknownKey})
	add(envelopeCase{Name: "wrong_key_same_id", Description: "用另一把私钥冒用受信任的 key_id",
		Envelope: signService(untrustedKey, "service-2026-10", baseAssertion(), nil), ExpectError: assertion.ErrBadSignature})
	add(envelopeCase{Name: "retired_key", Description: "轮换后的旧密钥签发了 not_after 之后的断言",
		Envelope: signService(retiredKey, "service-2026-01", baseAssertion(), nil), ExpectError: assertion.ErrKeyExpired})

	extra := signService(serviceKey, "service-2026-10", baseAssertion(), nil)
	ea := clone(extra["assertion"].(map[string]any))
	ea["note"] = "extra"
	extra["assertion"] = ea
	add(envelopeCase{Name: "schema_extra_field", Description: "断言带有字段列表之外的字段", Envelope: extra, ExpectError: assertion.ErrSchema})
	cv := baseAssertion()
	cv["canon_version"] = "jcs-sha256-v2"
	add(envelopeCase{Name: "schema_canon_version", Description: "不支持的 canon_version",
		Envelope: signService(serviceKey, "service-2026-10", cv, nil), ExpectError: assertion.ErrSchema})

	wa := baseAssertion()
	wa["tier"] = "H"
	wa["channel"] = "console"
	add(envelopeCase{Name: "webauthn_h_valid", Description: "H 档通行密钥签名", RequireWebAuthnForH: true,
		Envelope: signWebAuthn(approverCred, credentialID, wa, goodWebAuthn())})
	o := goodWebAuthn()
	o.origin = "https://evil.example"
	add(envelopeCase{Name: "webauthn_origin", Description: "origin 不在白名单中",
		Envelope: signWebAuthn(approverCred, credentialID, wa, o), ExpectError: assertion.ErrWebAuthnOrigin})
	o = goodWebAuthn()
	o.rpID = "evil.example"
	add(envelopeCase{Name: "webauthn_rp_id", Description: "rpIdHash 不是依赖方",
		Envelope: signWebAuthn(approverCred, credentialID, wa, o), ExpectError: assertion.ErrWebAuthnRPID})
	o = goodWebAuthn()
	o.flags = 0x01
	add(envelopeCase{Name: "webauthn_no_user_verification", Description: "没有 UV 标志",
		Envelope: signWebAuthn(approverCred, credentialID, wa, o), ExpectError: assertion.ErrWebAuthnFlags})
	o = goodWebAuthn()
	o.typ = "webauthn.create"
	add(envelopeCase{Name: "webauthn_wrong_type", Description: "clientData.type 不是 webauthn.get",
		Envelope: signWebAuthn(approverCred, credentialID, wa, o), ExpectError: assertion.ErrWebAuthnClientData})
	o = goodWebAuthn()
	o.challenge = must(assertion.WebAuthnChallenge(must(json.Marshal(baseAssertion()))))
	add(envelopeCase{Name: "webauthn_challenge_other_assertion", Description: "challenge 是另一份断言的哈希",
		Envelope: signWebAuthn(approverCred, credentialID, wa, o), ExpectError: assertion.ErrWebAuthnChallenge})
	add(envelopeCase{Name: "webauthn_principal_mismatch", Description: "凭据属于另一个审批人",
		Envelope: signWebAuthn(otherCredKey, otherCredID, wa, goodWebAuthn()), ExpectError: assertion.ErrWebAuthnPrincipal})
	add(envelopeCase{Name: "webauthn_unknown_credential", Description: "凭据未登记",
		Envelope: signWebAuthn(approverCred, b64([]byte("credential-unknown")), wa, goodWebAuthn()), ExpectError: assertion.ErrWebAuthnCredential})
	add(envelopeCase{Name: "webauthn_bad_signature", Description: "用另一把私钥伪造 alice 的签名",
		Envelope: signWebAuthn(otherCredKey, credentialID, wa, goodWebAuthn()), ExpectError: assertion.ErrWebAuthnBadSignature})
	return cases
}

var escapeMark = regexp.MustCompile(`%u[0-9a-fA-F]{4}`)

// jsonEscapes 把 %uXXXX 换成 JSON 的反斜杠 u 转义，让输入保持为转义形式（JCS 要输出它们的规范形式）。
func jsonEscapes(s string) string {
	return escapeMark.ReplaceAllStringFunc(s, func(m string) string { return string([]byte{92, 'u'}) + m[2:] })
}

func canonicalizationCases() []map[string]any {
	inputs := []struct{ name, input string }{
		{"key_order_utf16", jsonEscapes(`{"%u20ac":"Euro Sign","%u000d":"Carriage Return","%ufb33":"Hebrew Letter Dalet With Dagesh","1":"One","%ud83d%ude00":"Emoji: Grinning Face","%u0080":"Control","%u00f6":"Latin Small Letter O With Diaeresis"}`)},
		{"numbers_es6", `{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001,-0,9007199254740991,1e21,1e-7]}`},
		{"string_escapes", jsonEscapes(`{"string":"%u20ac$%u000F%u000aA'%u0042%u0022%u005c%u005c%u0022/","emoji":"%ud83d%ude00","ls":"%u2028"}`)},
		{"literals_nested", `{"literals":[null,true,false],"nested":{"b":[{"d":1,"c":2}],"a":{}}}`},
		{"whitespace", "{ \"b\" : 1 ,\n \"a\" : [ 1 , 2 ] }"},
	}
	var out []map[string]any
	for _, c := range inputs {
		canon := must(assertion.Canonical([]byte(c.input)))
		out = append(out, map[string]any{"name": c.name, "input": c.input, "canonical": string(canon), "sha256": assertion.Digest(canon)})
	}
	return out
}

func paramsHashCases() []map[string]any {
	var out []map[string]any
	for name, p := range map[string]any{
		"workload_scale":   baseParams,
		"pod_restart":      map[string]any{"namespace": "observability", "pod": "vmagent-0"},
		"with_verify":      map[string]any{"namespace": "drill", "kind": "Deployment", "name": "drill", "replicas": 2, "verify": []any{map[string]any{"id": "never", "query": "vector(1)", "op": "lt", "threshold": 0}}},
		"unicode_title":    map[string]any{"repository": "acme/infra", "base": "main", "title": "调高 HPA 上限 — ü", "patch": "--- a/x\n+++ b/x\n"},
		"empty_parameters": map[string]any{"namespace": "ci", "template": "drain-queue", "parameters": map[string]any{}},
	} {
		raw := must(json.Marshal(p))
		c := must(assertion.Canonical(raw))
		out = append(out, map[string]any{"name": name, "params": p, "canonical": string(c), "params_hash": assertion.Digest(c)})
	}
	sort.Slice(out, func(i, j int) bool { return out[i]["name"].(string) < out[j]["name"].(string) })
	return out
}

func main() {
	cases := envelopeCases()
	keys := map[string]any{
		"version":  1,
		"webauthn": map[string]any{"rp_id": rpID, "origins": []string{origin}},
		"keys": []any{
			map[string]any{"use": "service", "key_id": "service-2026-10", "public_key": serviceKey.pub()},
			map[string]any{"use": "service", "key_id": "service-2026-01", "public_key": retiredKey.pub(), "not_after": "2026-10-01T00:00:00Z"},
			map[string]any{"use": "webauthn", "credential_id": credentialID, "principal": approverAlice, "public_key": approverCred.pub()},
			map[string]any{"use": "webauthn", "credential_id": otherCredID, "principal": approverBob, "public_key": otherCredKey.pub()},
		},
	}
	seeds := map[string]any{}
	for _, k := range []key{serviceKey, retiredKey, untrustedKey, approverCred, otherCredKey} {
		seeds[k.label] = map[string]string{"seed_hex": hex.EncodeToString(seed(k.label)), "public_key": k.pub()}
	}
	doc := map[string]any{
		"version":                 1,
		"canon_version":           assertion.CanonVersion,
		"generator":               "hack/gen-gateway-vectors",
		"service_prefix":          assertion.ServiceSigningPrefix,
		"keys":                    seeds,
		"approver_keys":           keys,
		"canonicalization":        canonicalizationCases(),
		"canonicalization_errors": []map[string]any{{"name": "duplicate_key", "input": `{"a":1,"a":2}`}},
		"params_hash":             paramsHashCases(),
		"envelopes":               cases,
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(doc); err != nil {
		panic(err)
	}
	_, file, _, _ := runtime.Caller(0)
	out := filepath.Join(filepath.Dir(file), "..", "..", "contract", "gateway", "v1", "testvectors", "approval-vectors.json")
	if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
		panic(err)
	}
	if err := os.WriteFile(out, buf.Bytes(), 0o644); err != nil {
		panic(err)
	}
	fmt.Println("wrote", out, len(cases), "envelope cases")
}

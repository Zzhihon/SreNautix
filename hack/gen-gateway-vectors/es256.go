package main

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/sha256"
	"encoding/asn1"
	"encoding/hex"
	"encoding/json"
	"math/big"

	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/assertion"
)

// p256Key 是由固定种子派生的 P-256 私钥；签名使用 RFC 6979 的确定性 ECDSA（Sign 的随机源为 nil），
// 生成结果逐字节可重复。
type p256Key struct {
	label string
	priv  *ecdsa.PrivateKey
}

func newP256Key(label string) p256Key {
	priv, err := ecdsa.ParseRawPrivateKey(elliptic.P256(), seed(label))
	if err != nil {
		panic(err)
	}
	return p256Key{label: label, priv: priv}
}

func (k p256Key) pub() string {
	b, err := k.priv.PublicKey.Bytes()
	if err != nil {
		panic(err)
	}
	return b64(b)
}

type ecdsaSig struct {
	R, S *big.Int
}

var p256N = elliptic.P256().Params().N

// signDER 返回低 S 形式的 DER 签名。
func (k p256Key) signDER(msg []byte) []byte {
	digest := sha256.Sum256(msg)
	der := must(k.priv.Sign(nil, digest[:], crypto.SHA256))
	var s ecdsaSig
	if _, err := asn1.Unmarshal(der, &s); err != nil {
		panic(err)
	}
	half := new(big.Int).Rsh(p256N, 1)
	if s.S.Cmp(half) > 0 {
		s.S = new(big.Int).Sub(p256N, s.S)
	}
	return must(asn1.Marshal(s))
}

// highS 把低 S 签名换成同样有效的高 S 形式（S' = N − S）。
func highS(der []byte) []byte {
	var s ecdsaSig
	if _, err := asn1.Unmarshal(der, &s); err != nil {
		panic(err)
	}
	s.S = new(big.Int).Sub(p256N, s.S)
	return must(asn1.Marshal(s))
}

// rawRS 把 DER 签名换成 r‖s 各 32 字节的原始形式（WebAuthn 不接受）。
func rawRS(der []byte) []byte {
	var s ecdsaSig
	if _, err := asn1.Unmarshal(der, &s); err != nil {
		panic(err)
	}
	out := make([]byte, 64)
	s.R.FillBytes(out[:32])
	s.S.FillBytes(out[32:])
	return out
}

var (
	es256Alice   = newP256Key("es256-alice")
	es256Bob     = newP256Key("es256-bob")
	es256Mallory = newP256Key("es256-mallory")
	es256AliceID = b64([]byte("credential-alice-es256"))
	es256BobID   = b64([]byte("credential-bob-es256"))
	eddsaCarol   = newKey("webauthn-carol")
	eddsaCarolID = b64([]byte("credential-carol-eddsa"))
	approverCaro = "oidc:carol@example.org"
)

// webauthnArgs 描述一份 WebAuthn 断言的各个部分；零值字段取正常值。
type webauthnArgs struct {
	proofType   string
	credID      string
	origin      string
	rpID        string
	flags       byte
	clientType  string
	challenge   string
	crossOrigin bool
	topOrigin   string
	// sign 对 authenticatorData‖sha256(clientDataJSON) 签名
	sign func(msg []byte) []byte
	// afterSign 在签名之后修改 clientDataJSON 与 authenticatorData
	afterSign func(cd map[string]any, ad []byte) []byte
}

func webauthnEnvelope(a map[string]any, w webauthnArgs) map[string]any {
	araw := must(json.Marshal(a))
	if w.proofType == "" {
		w.proofType = assertion.ProofWebAuthn
	}
	if w.origin == "" {
		w.origin = origin
	}
	if w.rpID == "" {
		w.rpID = rpID
	}
	if w.flags == 0 {
		w.flags = 0x05
	}
	if w.clientType == "" {
		w.clientType = "webauthn.get"
	}
	if w.challenge == "" {
		w.challenge = must(assertion.WebAuthnChallenge(araw))
	}
	cdm := map[string]any{"type": w.clientType, "challenge": w.challenge, "origin": w.origin, "crossOrigin": w.crossOrigin}
	if w.topOrigin != "" {
		cdm["topOrigin"] = w.topOrigin
	}
	cd := must(json.Marshal(cdm))
	rp := sha256.Sum256([]byte(w.rpID))
	ad := append(append([]byte{}, rp[:]...), w.flags, 0, 0, 0, 7)
	cdHash := sha256.Sum256(cd)
	sig := w.sign(append(append([]byte{}, ad...), cdHash[:]...))
	if w.afterSign != nil {
		ad = w.afterSign(cdm, ad)
		cd = must(json.Marshal(cdm))
	}
	return map[string]any{"assertion": a, "proof": map[string]any{
		"type": w.proofType, "credential_id": w.credID, "authenticator_data": b64(ad),
		"client_data_json": b64(cd), "signature": b64(sig),
	}}
}

func es256Assertion(principal string) map[string]any {
	a := baseAssertion()
	a["tier"] = assertion.TierH
	a["channel"] = "console"
	a["approver_principal"] = principal
	return a
}

func es256Cases() []envelopeCase {
	var cases []envelopeCase
	add := func(c envelopeCase) { cases = append(cases, describe(c)) }
	alice := es256Assertion(approverAlice)
	low := func(msg []byte) []byte { return es256Alice.signDER(msg) }
	ok := func(w webauthnArgs) webauthnArgs {
		if w.credID == "" {
			w.credID = es256AliceID
		}
		if w.sign == nil {
			w.sign = low
		}
		return w
	}

	add(envelopeCase{Name: "es256_h_valid_low_s", Description: "H 档 ES256 通行密钥签名，低 S 形式", RequireWebAuthnForH: true,
		Envelope: webauthnEnvelope(alice, ok(webauthnArgs{}))})
	add(envelopeCase{Name: "es256_h_valid_high_s", Description: "同一签名换成高 S 形式，同样接受；断言哈希与执行 ID 不变", RequireWebAuthnForH: true,
		Envelope: webauthnEnvelope(alice, ok(webauthnArgs{sign: func(m []byte) []byte { return highS(low(m)) }}))})
	add(envelopeCase{Name: "es256_tampered_client_data", Description: "签名后在 clientDataJSON 中加入字段",
		Envelope:    webauthnEnvelope(alice, ok(webauthnArgs{afterSign: func(cd map[string]any, ad []byte) []byte { cd["extra"] = "x"; return ad }})),
		ExpectError: assertion.ErrWebAuthnBadSignature})
	add(envelopeCase{Name: "es256_tampered_authenticator_data", Description: "签名后修改 authenticatorData 的签名计数",
		Envelope: webauthnEnvelope(alice, ok(webauthnArgs{afterSign: func(_ map[string]any, ad []byte) []byte {
			out := append([]byte{}, ad...)
			out[len(out)-1] ^= 0xff
			return out
		}})),
		ExpectError: assertion.ErrWebAuthnBadSignature})
	add(envelopeCase{Name: "es256_origin", Description: "签名覆盖的 origin 不在白名单中",
		Envelope: webauthnEnvelope(alice, ok(webauthnArgs{origin: "https://evil.example"})), ExpectError: assertion.ErrWebAuthnOrigin})
	add(envelopeCase{Name: "es256_rp_id", Description: "rpIdHash 不是依赖方",
		Envelope: webauthnEnvelope(alice, ok(webauthnArgs{rpID: "evil.example"})), ExpectError: assertion.ErrWebAuthnRPID})
	add(envelopeCase{Name: "es256_challenge_other_assertion", Description: "challenge 是另一份断言的哈希",
		Envelope:    webauthnEnvelope(alice, ok(webauthnArgs{challenge: must(assertion.WebAuthnChallenge(must(json.Marshal(baseAssertion()))))})),
		ExpectError: assertion.ErrWebAuthnChallenge})
	add(envelopeCase{Name: "es256_wrong_type", Description: "clientData.type 不是 webauthn.get",
		Envelope: webauthnEnvelope(alice, ok(webauthnArgs{clientType: "webauthn.create"})), ExpectError: assertion.ErrWebAuthnClientData})
	add(envelopeCase{Name: "es256_cross_origin", Description: "crossOrigin 为 true",
		Envelope: webauthnEnvelope(alice, ok(webauthnArgs{crossOrigin: true})), ExpectError: assertion.ErrWebAuthnCrossOrigin})
	add(envelopeCase{Name: "es256_top_origin", Description: "clientDataJSON 带 topOrigin",
		Envelope: webauthnEnvelope(alice, ok(webauthnArgs{topOrigin: "https://evil.example"})), ExpectError: assertion.ErrWebAuthnCrossOrigin})
	add(envelopeCase{Name: "es256_no_user_verification", Description: "没有 UV 标志",
		Envelope: webauthnEnvelope(alice, ok(webauthnArgs{flags: 0x01})), ExpectError: assertion.ErrWebAuthnFlags})
	add(envelopeCase{Name: "es256_raw_signature", Description: "签名是 r‖s 原始形式，不是 DER",
		Envelope:    webauthnEnvelope(alice, ok(webauthnArgs{sign: func(m []byte) []byte { return rawRS(low(m)) }})),
		ExpectError: assertion.ErrWebAuthnBadSignature})
	add(envelopeCase{Name: "es256_der_trailing_bytes", Description: "DER 签名后有多余字节",
		Envelope:    webauthnEnvelope(alice, ok(webauthnArgs{sign: func(m []byte) []byte { return append(low(m), 0) }})),
		ExpectError: assertion.ErrWebAuthnBadSignature})
	add(envelopeCase{Name: "es256_signed_by_other_key", Description: "用另一把 P-256 私钥冒充 alice 的凭据",
		Envelope: webauthnEnvelope(alice, ok(webauthnArgs{sign: es256Mallory.signDER})), ExpectError: assertion.ErrWebAuthnBadSignature})
	add(envelopeCase{Name: "es256_principal_mismatch", Description: "凭据属于 bob，断言写的是 alice",
		Envelope: webauthnEnvelope(alice, webauthnArgs{credID: es256BobID, sign: es256Bob.signDER}), ExpectError: assertion.ErrWebAuthnPrincipal})

	// 算法混淆：算法只取自登记的凭据
	add(envelopeCase{Name: "alg_confusion_ed25519_label_on_es256_credential", Description: "信封标为 webauthn_ed25519，凭据是 ES256（签名本身有效）",
		Envelope: webauthnEnvelope(alice, ok(webauthnArgs{proofType: assertion.ProofWebAuthnEd25519})), ExpectError: assertion.ErrWebAuthnAlgMismatch})
	carol := es256Assertion(approverCaro)
	add(envelopeCase{Name: "eddsa_credential_webauthn_type_valid", Description: "EdDSA 凭据使用 webauthn 类型",
		Envelope: webauthnEnvelope(carol, webauthnArgs{credID: eddsaCarolID, sign: func(m []byte) []byte { return ed25519Sign(eddsaCarol, m) }})})
	add(envelopeCase{Name: "alg_confusion_es256_signature_on_eddsa_credential", Description: "EdDSA 凭据配上一个 ES256 DER 签名，按 EdDSA 校验失败",
		Envelope: webauthnEnvelope(carol, webauthnArgs{credID: eddsaCarolID, sign: es256Alice.signDER}), ExpectError: assertion.ErrWebAuthnBadSignature})
	add(envelopeCase{Name: "alg_confusion_ed25519_signature_on_es256_credential", Description: "ES256 凭据配上一个 64 字节 Ed25519 签名，按 ES256 校验失败",
		Envelope:    webauthnEnvelope(alice, ok(webauthnArgs{sign: func(m []byte) []byte { return ed25519Sign(approverCred, m) }})),
		ExpectError: assertion.ErrWebAuthnBadSignature})
	return cases
}

func ed25519Sign(k key, msg []byte) []byte {
	return must(k.priv.Sign(nil, msg, crypto.Hash(0)))
}

func es256Keys() map[string]any {
	return map[string]any{
		"version":  1,
		"webauthn": map[string]any{"rp_id": rpID, "origins": []string{origin}},
		"keys": []any{
			map[string]any{"use": "service", "key_id": "service-2026-10", "public_key": serviceKey.pub()},
			map[string]any{"use": "webauthn", "credential_id": es256AliceID, "principal": approverAlice, "alg": assertion.AlgES256, "public_key": es256Alice.pub()},
			map[string]any{"use": "webauthn", "credential_id": es256BobID, "principal": approverBob, "alg": assertion.AlgES256, "public_key": es256Bob.pub()},
			map[string]any{"use": "webauthn", "credential_id": eddsaCarolID, "principal": approverCaro, "alg": assertion.AlgEdDSA, "public_key": eddsaCarol.pub()},
		},
	}
}

// keyErrorCases 是必须被拒绝的 approver-keys 文档。
func keyErrorCases() []map[string]any {
	doc := func(alg, pub string) map[string]any {
		e := map[string]any{"use": "webauthn", "credential_id": es256AliceID, "principal": approverAlice, "public_key": pub}
		if alg != "" {
			e["alg"] = alg
		}
		return map[string]any{"version": 1, "webauthn": map[string]any{"rp_id": rpID, "origins": []string{origin}}, "keys": []any{e}}
	}
	notOnCurve := must(es256Alice.priv.PublicKey.Bytes())
	notOnCurve = append([]byte{}, notOnCurve...)
	notOnCurve[64] ^= 0x01
	compressed := must(es256Alice.priv.PublicKey.Bytes())[:33]
	compressed[0] = 0x02 | (must(es256Alice.priv.PublicKey.Bytes())[64] & 1)
	return []map[string]any{
		{"name": "es256_point_not_on_curve", "approver_keys": doc(assertion.AlgES256, b64(notOnCurve))},
		{"name": "es256_compressed_point", "approver_keys": doc(assertion.AlgES256, b64(compressed))},
		{"name": "es256_alg_with_ed25519_key", "approver_keys": doc(assertion.AlgES256, approverCred.pub())},
		{"name": "eddsa_alg_with_p256_key", "approver_keys": doc(assertion.AlgEdDSA, es256Alice.pub())},
		{"name": "default_alg_with_p256_key", "approver_keys": doc("", es256Alice.pub())},
		{"name": "unknown_alg", "approver_keys": doc("RS256", es256Alice.pub())},
	}
}

func es256Document() map[string]any {
	keys := map[string]any{}
	for _, k := range []p256Key{es256Alice, es256Bob, es256Mallory} {
		keys[k.label] = map[string]string{"alg": assertion.AlgES256, "seed_hex": hex.EncodeToString(seed(k.label)), "public_key": k.pub()}
	}
	keys[eddsaCarol.label] = map[string]string{"alg": assertion.AlgEdDSA, "seed_hex": hex.EncodeToString(seed(eddsaCarol.label)), "public_key": eddsaCarol.pub()}
	return map[string]any{
		"version":              1,
		"canon_version":        assertion.CanonVersion,
		"generator":            "hack/gen-gateway-vectors",
		"signature_note":       "ES256 签名为 RFC 6979 确定性 ECDSA，基准用例为低 S 形式；ES256 私钥是 seed_hex 作为 P-256 标量",
		"keys":                 keys,
		"approver_keys":        es256Keys(),
		"approver_keys_errors": keyErrorCases(),
		"envelopes":            es256Cases(),
	}
}

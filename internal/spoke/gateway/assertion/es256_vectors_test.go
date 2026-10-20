package assertion_test

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io/fs"
	"testing"
	"time"

	contract "github.com/Zzhihon/SreNautix/contract/gateway"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/assertion"
)

type es256Vectors struct {
	Keys map[string]struct {
		Alg       string `json:"alg"`
		SeedHex   string `json:"seed_hex"`
		PublicKey string `json:"public_key"`
	} `json:"keys"`
	ApproverKeys       json.RawMessage `json:"approver_keys"`
	ApproverKeysErrors []struct {
		Name         string          `json:"name"`
		ApproverKeys json.RawMessage `json:"approver_keys"`
	} `json:"approver_keys_errors"`
	Envelopes []struct {
		Name                string          `json:"name"`
		Envelope            json.RawMessage `json:"envelope"`
		Binding             json.RawMessage `json:"binding"`
		Now                 string          `json:"now"`
		RequireWebAuthnForH bool            `json:"require_webauthn_for_h"`
		AssertionHash       string          `json:"assertion_hash"`
		ExecutionID         string          `json:"execution_id"`
		ExpectError         string          `json:"expect_error"`
	} `json:"envelopes"`
}

func TestES256Vectors(t *testing.T) {
	raw, err := fs.ReadFile(contract.FS, "v1/testvectors/approval-vectors-es256.json")
	if err != nil {
		t.Fatal(err)
	}
	var v es256Vectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	for label, k := range v.Keys {
		if k.Alg != assertion.AlgES256 {
			continue
		}
		seed, err := hex.DecodeString(k.SeedHex)
		if err != nil {
			t.Fatal(err)
		}
		priv, err := ecdsa.ParseRawPrivateKey(elliptic.P256(), seed)
		if err != nil {
			t.Fatal(err)
		}
		pub, err := priv.PublicKey.Bytes()
		if err != nil || base64.RawURLEncoding.EncodeToString(pub) != k.PublicKey {
			t.Fatalf("%s: public key does not derive from seed", label)
		}
	}
	for _, c := range v.ApproverKeysErrors {
		if _, err := assertion.ParseKeyring(c.ApproverKeys); err == nil {
			t.Errorf("%s: keyring loaded", c.Name)
		}
	}
	ring, err := assertion.ParseKeyring(v.ApproverKeys)
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, c := range v.Envelopes {
		t.Run(c.Name, func(t *testing.T) {
			got := ""
			ver, err := ring.Verify(c.Envelope, assertion.VerifyOptions{RequireWebAuthnForH: c.RequireWebAuthnForH})
			if err == nil {
				if ver.AssertionHash != c.AssertionHash || assertion.ExecutionID(ver.Assertion.ProposalID, ver.AssertionHash) != c.ExecutionID {
					t.Fatalf("hash or execution id differs")
				}
				var b bindingDoc
				if err := json.Unmarshal(c.Binding, &b); err != nil {
					t.Fatal(err)
				}
				pexp, _ := assertion.ParseTime(b.ProposalExpiresAt)
				now, _ := assertion.ParseTime(c.Now)
				err = assertion.CheckBinding(ver, assertion.Binding{
					ProposalID: b.ProposalID, Action: b.Action, Params: b.Params, TargetUID: b.TargetUID, Cluster: b.Cluster,
					IncidentVersion: b.IncidentVersion, RootComponent: b.RootComponent, EvidenceFingerprint: b.EvidenceFingerprint,
					ProposalExpiresAt: pexp,
				}, now, time.Time{})
			}
			if err != nil {
				if got = assertion.Code(err); got == "" {
					t.Fatalf("error without a reason code: %v", err)
				}
			}
			if got != c.ExpectError {
				t.Fatalf("want %q, got %q (%v)", c.ExpectError, got, err)
			}
			if err == nil && ver.Alg != expectedAlg(c.Name) {
				t.Fatalf("verified with %s", ver.Alg)
			}
			seen[got] = true
		})
	}
	for _, code := range []string{"", assertion.ErrWebAuthnBadSignature, assertion.ErrWebAuthnOrigin, assertion.ErrWebAuthnRPID,
		assertion.ErrWebAuthnChallenge, assertion.ErrWebAuthnAlgMismatch, assertion.ErrWebAuthnCrossOrigin, assertion.ErrWebAuthnFlags,
		assertion.ErrWebAuthnClientData, assertion.ErrWebAuthnPrincipal} {
		if !seen[code] {
			t.Errorf("no ES256 vector covers %q", code)
		}
	}
}

func expectedAlg(name string) string {
	if name == "eddsa_credential_webauthn_type_valid" {
		return assertion.AlgEdDSA
	}
	return assertion.AlgES256
}

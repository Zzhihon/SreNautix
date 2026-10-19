package assertion_test

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io/fs"
	"testing"
	"time"

	contract "github.com/Zzhihon/SreNautix/contract/gateway"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/assertion"
)

type vectors struct {
	CanonVersion  string `json:"canon_version"`
	ServicePrefix string `json:"service_prefix"`
	Keys          map[string]struct {
		SeedHex   string `json:"seed_hex"`
		PublicKey string `json:"public_key"`
	} `json:"keys"`
	ApproverKeys     json.RawMessage `json:"approver_keys"`
	Canonicalization []struct {
		Name      string `json:"name"`
		Input     string `json:"input"`
		Canonical string `json:"canonical"`
		SHA256    string `json:"sha256"`
	} `json:"canonicalization"`
	CanonicalizationErrors []struct {
		Name  string `json:"name"`
		Input string `json:"input"`
	} `json:"canonicalization_errors"`
	ParamsHash []struct {
		Name       string          `json:"name"`
		Params     json.RawMessage `json:"params"`
		Canonical  string          `json:"canonical"`
		ParamsHash string          `json:"params_hash"`
	} `json:"params_hash"`
	Envelopes []struct {
		Name                string          `json:"name"`
		Envelope            json.RawMessage `json:"envelope"`
		Binding             json.RawMessage `json:"binding"`
		Now                 string          `json:"now"`
		RestoredAt          *string         `json:"restored_at"`
		RequireWebAuthnForH bool            `json:"require_webauthn_for_h"`
		AssertionCanonical  string          `json:"assertion_canonical"`
		AssertionHash       string          `json:"assertion_hash"`
		ExecutionID         string          `json:"execution_id"`
		SigningInput        string          `json:"signing_input_b64url"`
		ExpectError         string          `json:"expect_error"`
	} `json:"envelopes"`
}

func loadVectors(t *testing.T) vectors {
	t.Helper()
	raw, err := fs.ReadFile(contract.FS, "v1/testvectors/approval-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var v vectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func TestCanonicalizationVectors(t *testing.T) {
	v := loadVectors(t)
	if v.CanonVersion != assertion.CanonVersion || v.ServicePrefix != assertion.ServiceSigningPrefix {
		t.Fatalf("vector header %q %q", v.CanonVersion, v.ServicePrefix)
	}
	for _, c := range v.Canonicalization {
		got, err := assertion.Canonical([]byte(c.Input))
		if err != nil {
			t.Fatalf("%s: %v", c.Name, err)
		}
		if string(got) != c.Canonical || assertion.Digest(got) != c.SHA256 {
			t.Fatalf("%s: got %q", c.Name, got)
		}
	}
	for _, c := range v.CanonicalizationErrors {
		if _, err := assertion.Canonical([]byte(c.Input)); err == nil {
			t.Fatalf("%s: canonicalization accepted %s", c.Name, c.Input)
		}
	}
	for _, c := range v.ParamsHash {
		h, err := assertion.Hash(c.Params)
		if err != nil || h != c.ParamsHash {
			t.Fatalf("%s: params hash %s %v", c.Name, h, err)
		}
	}
}

func TestKeysDeriveFromSeeds(t *testing.T) {
	v := loadVectors(t)
	for label, k := range v.Keys {
		seed, err := hex.DecodeString(k.SeedHex)
		if err != nil {
			t.Fatal(err)
		}
		pub := ed25519.NewKeyFromSeed(seed).Public().(ed25519.PublicKey)
		if base64.RawURLEncoding.EncodeToString(pub) != k.PublicKey {
			t.Fatalf("%s: public key does not derive from seed", label)
		}
	}
}

type bindingDoc struct {
	ProposalID          string          `json:"proposal_id"`
	Action              string          `json:"action"`
	Params              json.RawMessage `json:"params"`
	TargetUID           string          `json:"target_uid"`
	Cluster             string          `json:"cluster"`
	IncidentVersion     int64           `json:"incident_version"`
	RootComponent       string          `json:"root_component"`
	EvidenceFingerprint string          `json:"evidence_fingerprint"`
	ProposalExpiresAt   string          `json:"proposal_expires_at"`
}

func TestEnvelopeVectors(t *testing.T) {
	v := loadVectors(t)
	ring, err := assertion.ParseKeyring(v.ApproverKeys)
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, c := range v.Envelopes {
		t.Run(c.Name, func(t *testing.T) {
			var env struct {
				Assertion json.RawMessage `json:"assertion"`
			}
			if err := json.Unmarshal(c.Envelope, &env); err != nil {
				t.Fatal(err)
			}
			canon, err := assertion.Canonical(env.Assertion)
			if err != nil {
				t.Fatal(err)
			}
			if string(canon) != c.AssertionCanonical || assertion.Digest(canon) != c.AssertionHash {
				t.Fatalf("assertion canonical form differs: %s", canon)
			}
			var pid struct {
				ProposalID string `json:"proposal_id"`
			}
			if err := json.Unmarshal(env.Assertion, &pid); err != nil {
				t.Fatal(err)
			}
			if assertion.ExecutionID(pid.ProposalID, c.AssertionHash) != c.ExecutionID {
				t.Fatalf("execution id differs")
			}
			got := ""
			ver, err := ring.Verify(c.Envelope, assertion.VerifyOptions{RequireWebAuthnForH: c.RequireWebAuthnForH})
			if err == nil {
				var b bindingDoc
				if err := json.Unmarshal(c.Binding, &b); err != nil {
					t.Fatal(err)
				}
				pexp, perr := assertion.ParseTime(b.ProposalExpiresAt)
				now, nerr := assertion.ParseTime(c.Now)
				if perr != nil || nerr != nil {
					t.Fatal(perr, nerr)
				}
				var restored time.Time
				if c.RestoredAt != nil {
					if restored, err = assertion.ParseTime(*c.RestoredAt); err != nil {
						t.Fatal(err)
					}
				}
				err = assertion.CheckBinding(ver, assertion.Binding{
					ProposalID: b.ProposalID, Action: b.Action, Params: b.Params, TargetUID: b.TargetUID, Cluster: b.Cluster,
					IncidentVersion: b.IncidentVersion, RootComponent: b.RootComponent, EvidenceFingerprint: b.EvidenceFingerprint,
					ProposalExpiresAt: pexp,
				}, now, restored)
			}
			if err != nil {
				got = assertion.Code(err)
				if got == "" {
					t.Fatalf("error without a reason code: %v", err)
				}
			}
			if got != c.ExpectError {
				t.Fatalf("want %q, got %q (%v)", c.ExpectError, got, err)
			}
			seen[got] = true
		})
	}
	// 每个原因码至少有一个反例
	for _, code := range []string{
		assertion.ErrSchema, assertion.ErrUnknownKey, assertion.ErrKeyExpired, assertion.ErrBadSignature,
		assertion.ErrReauthRequired, assertion.ErrReauthStale, assertion.ErrWebAuthnRequired, assertion.ErrWebAuthnCredential,
		assertion.ErrWebAuthnPrincipal, assertion.ErrWebAuthnClientData, assertion.ErrWebAuthnChallenge, assertion.ErrWebAuthnOrigin,
		assertion.ErrWebAuthnRPID, assertion.ErrWebAuthnFlags, assertion.ErrWebAuthnBadSignature, assertion.ErrBindingProposal,
		assertion.ErrBindingAction, assertion.ErrBindingParams, assertion.ErrBindingTarget, assertion.ErrBindingCluster,
		assertion.ErrBindingIncident, assertion.ErrBindingRoot, assertion.ErrBindingEvidence, assertion.ErrExpired,
		assertion.ErrNotYetValid, assertion.ErrExpiresBeforeIssue, assertion.ErrIssuedBeforeRestore, assertion.ErrProposalExpired, "",
	} {
		if !seen[code] {
			t.Errorf("no vector covers %q", code)
		}
	}
}

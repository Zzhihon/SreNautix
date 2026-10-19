package assertion

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"time"

	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/schema"
)

// ServiceKey 是 server 的服务签名公钥。
type ServiceKey struct {
	Public   ed25519.PublicKey
	NotAfter time.Time // 零值表示不限
}

// Credential 是审批人通行密钥的公钥。
type Credential struct {
	Principal string
	Public    ed25519.PublicKey
}

// Keyring 是 gateway 信任的公钥（approver-keys.schema.json）。
type Keyring struct {
	Service  map[string]ServiceKey
	WebAuthn map[string]Credential // 键为 credential_id（base64url）
	RPID     string
	Origins  map[string]bool
}

type keysFile struct {
	Version  int `json:"version"`
	WebAuthn *struct {
		RPID    string   `json:"rp_id"`
		Origins []string `json:"origins"`
	} `json:"webauthn"`
	Keys []struct {
		Use          string `json:"use"`
		KeyID        string `json:"key_id"`
		CredentialID string `json:"credential_id"`
		Principal    string `json:"principal"`
		PublicKey    string `json:"public_key"`
		NotAfter     string `json:"not_after"`
	} `json:"keys"`
}

// DecodeKey 解码 base64url（不带填充）的 Ed25519 公钥。
func DecodeKey(s string) (ed25519.PublicKey, error) {
	b, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return nil, err
	}
	if len(b) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("ed25519 public key has %d bytes", len(b))
	}
	return ed25519.PublicKey(b), nil
}

// ParseKeyring 解析 approver-keys 文档（YAML 或 JSON），先按契约 schema 校验。
func ParseKeyring(doc []byte) (*Keyring, error) {
	raw, err := schema.ValidateYAML(schema.ApproverKeys, doc)
	if err != nil {
		return nil, err
	}
	var f keysFile
	if err := json.Unmarshal(raw, &f); err != nil {
		return nil, err
	}
	k := &Keyring{Service: map[string]ServiceKey{}, WebAuthn: map[string]Credential{}, Origins: map[string]bool{}}
	if f.WebAuthn != nil {
		k.RPID = f.WebAuthn.RPID
		for _, o := range f.WebAuthn.Origins {
			k.Origins[o] = true
		}
	}
	for _, e := range f.Keys {
		pub, err := DecodeKey(e.PublicKey)
		if err != nil {
			return nil, fmt.Errorf("approver keys: %w", err)
		}
		switch e.Use {
		case "service":
			if _, dup := k.Service[e.KeyID]; dup {
				return nil, fmt.Errorf("approver keys: duplicate service key %s", e.KeyID)
			}
			sk := ServiceKey{Public: pub}
			if e.NotAfter != "" {
				if sk.NotAfter, err = ParseTime(e.NotAfter); err != nil {
					return nil, fmt.Errorf("approver keys: %s not_after: %w", e.KeyID, err)
				}
			}
			k.Service[e.KeyID] = sk
		case "webauthn":
			if _, dup := k.WebAuthn[e.CredentialID]; dup {
				return nil, fmt.Errorf("approver keys: duplicate credential %s", e.CredentialID)
			}
			k.WebAuthn[e.CredentialID] = Credential{Principal: e.Principal, Public: pub}
		}
	}
	if len(k.WebAuthn) > 0 && k.RPID == "" {
		return nil, fmt.Errorf("approver keys: webauthn credentials require the webauthn section")
	}
	return k, nil
}

// LoadKeyring 读取挂载的 approver-keys 文件。
func LoadKeyring(path string) (*Keyring, error) {
	doc, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return ParseKeyring(doc)
}

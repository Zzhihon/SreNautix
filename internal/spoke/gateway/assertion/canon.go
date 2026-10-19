// Package assertion 实现审批断言 v1（contract/gateway/v1/approval-*.schema.json）的规范化、签名校验与绑定核对。
// 规范化使用 RFC 8785 JCS；哈希为 "sha256:" 加小写十六进制。Go 与 TS 共用 contract/gateway/v1/testvectors 中的黄金向量。
package assertion

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strconv"

	"github.com/gowebpki/jcs"
)

// CanonVersion 是本包实现的规范化版本。
const CanonVersion = "jcs-sha256-v1"

// ZeroHash 是哈希链第一条记录的 prev_hash。
const ZeroHash = "sha256:0000000000000000000000000000000000000000000000000000000000000000"

// 签名输入与派生 ID 的域分隔前缀。
const (
	ServiceSigningPrefix = "srenautix-approval-v1\n"
	executionIDPrefix    = "srenautix-execution-v1\n"
	eventIDPrefix        = "srenautix-event-v1\n"
)

// Canonical 返回 JSON 文本的 JCS 规范化形式；重复的键、非法 JSON 都返回错误。
func Canonical(raw []byte) ([]byte, error) {
	out, err := jcs.Transform(raw)
	if err != nil {
		return nil, fmt.Errorf("jcs: %w", err)
	}
	return out, nil
}

// Digest 返回 "sha256:" 加 b 的 SHA-256 小写十六进制。
func Digest(b []byte) string {
	sum := sha256.Sum256(b)
	return "sha256:" + hex.EncodeToString(sum[:])
}

// Hash 返回 sha256(JCS(raw))。
func Hash(raw []byte) (string, error) {
	c, err := Canonical(raw)
	if err != nil {
		return "", err
	}
	return Digest(c), nil
}

// HashValue 把 v 编码为 JSON 后返回 sha256(JCS(v))。
func HashValue(v any) (string, error) {
	raw, err := json.Marshal(v)
	if err != nil {
		return "", err
	}
	return Hash(raw)
}

// ExecutionID 由提议 ID 与断言哈希确定性地派生：重复下发同一工单得到同一个 ID。
func ExecutionID(proposalID, assertionHash string) string {
	sum := sha256.Sum256([]byte(executionIDPrefix + proposalID + "\n" + assertionHash))
	return hex.EncodeToString(sum[:])[:32]
}

// EventID 是执行事件的去重键。
func EventID(executionID string, seq int64) string {
	sum := sha256.Sum256([]byte(eventIDPrefix + executionID + "\n" + strconv.FormatInt(seq, 10)))
	return hex.EncodeToString(sum[:])[:32]
}

package topology

import (
	"fmt"
	"regexp"
	"strings"
	"unicode/utf8"
)

// builtinGroups 中的资源在 ComponentKey 里只写 Kind；其余 API 组写成 Kind.group，避免不同 CRD 的同名 Kind 冲突。
var builtinGroups = map[string]bool{
	"":                          true,
	"apps":                      true,
	"batch":                     true,
	"networking.k8s.io":         true,
	"discovery.k8s.io":          true,
	"storage.k8s.io":            true,
	"policy":                    true,
	"autoscaling":               true,
	"rbac.authorization.k8s.io": true,
}

// KindName 返回 ComponentKey 中使用的 kind 名称。
func KindName(group, kind string) string {
	if builtinGroups[group] {
		return kind
	}
	return kind + "." + group
}

// MaxKeyLength 是 ComponentKey 的最大长度（contract/schemas/common.schema.json）。
const MaxKeyLength = 400

var (
	// keyPattern 与契约中 ComponentKey 的 pattern 相同
	keyPattern       = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9.-]*:([a-z0-9]([-a-z0-9]*[a-z0-9])?/)?([A-Za-z0-9._-]|%[0-9A-F]{2})+$`)
	kindPattern      = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9.-]*$`)
	namespacePattern = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`)
)

// KeyError 说明为什么一个对象无法生成合法的 ComponentKey。
type KeyError struct {
	Kind      string
	Namespace string
	Name      string
	Reason    string
}

func (e *KeyError) Error() string {
	return fmt.Sprintf("topology: no component key for kind %q namespace %q name %q: %s", e.Kind, e.Namespace, e.Name, e.Reason)
}

// unreserved 判断字节在名称段中是否原样保留：ASCII 字母、数字、'-'、'.'、'_'。
func unreserved(b byte) bool {
	return 'A' <= b && b <= 'Z' || 'a' <= b && b <= 'z' || '0' <= b && b <= '9' || b == '-' || b == '.' || b == '_'
}

const upperHex = "0123456789ABCDEF"

// EscapeName 把对象名编码成 ComponentKey 的名称段（ADR 0034）：名称的 UTF-8 字节中，ASCII 字母、数字、'-'、'.'、'_' 原样保留，
// 其余每个字节写成 '%' 加两位大写十六进制。只含保留字符的名称（全部 DNS 名称）编码后不变。
func EscapeName(name string) string {
	n := 0
	for i := 0; i < len(name); i++ {
		if !unreserved(name[i]) {
			n++
		}
	}
	if n == 0 {
		return name
	}
	var b strings.Builder
	b.Grow(len(name) + 2*n)
	for i := 0; i < len(name); i++ {
		c := name[i]
		if unreserved(c) {
			b.WriteByte(c)
			continue
		}
		b.WriteByte('%')
		b.WriteByte(upperHex[c>>4])
		b.WriteByte(upperHex[c&0x0f])
	}
	return b.String()
}

func unhex(c byte) (byte, bool) {
	switch {
	case '0' <= c && c <= '9':
		return c - '0', true
	case 'A' <= c && c <= 'F':
		return c - 'A' + 10, true
	}
	return 0, false
}

// UnescapeName 是 EscapeName 的逆运算。只接受规范编码：'%' 后必须是两位大写十六进制，且解出的字节不是保留字符，
// 解码结果必须是合法的 UTF-8；因此每个名称恰好对应一个名称段。
func UnescapeName(s string) (string, error) {
	if s == "" {
		return "", fmt.Errorf("empty name segment")
	}
	var b strings.Builder
	b.Grow(len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		if unreserved(c) {
			b.WriteByte(c)
			continue
		}
		if c != '%' {
			return "", fmt.Errorf("byte %q at offset %d must be percent-encoded", c, i)
		}
		if i+2 >= len(s) {
			return "", fmt.Errorf("truncated escape at offset %d", i)
		}
		hi, ok1 := unhex(s[i+1])
		lo, ok2 := unhex(s[i+2])
		if !ok1 || !ok2 {
			return "", fmt.Errorf("escape at offset %d is not two upper-case hex digits", i)
		}
		v := hi<<4 | lo
		if unreserved(v) {
			return "", fmt.Errorf("escape at offset %d encodes %q, which must appear literally", i, v)
		}
		b.WriteByte(v)
		i += 2
	}
	out := b.String()
	if !utf8.ValidString(out) {
		return "", fmt.Errorf("decoded name is not valid UTF-8")
	}
	return out, nil
}

// Key 返回 ComponentKey：命名空间内对象为 <kind>:<namespace>/<名称段>，集群级对象为 <kind>:<名称段>，名称段由 EscapeName 得到。
// kind、namespace 不合法，名称为空或不是合法的 UTF-8，或者结果超过 MaxKeyLength 时返回 *KeyError。
func Key(kind, namespace, name string) (string, error) {
	fail := func(reason string) (string, error) {
		return "", &KeyError{Kind: kind, Namespace: namespace, Name: name, Reason: reason}
	}
	switch {
	case !kindPattern.MatchString(kind):
		return fail("kind must match " + kindPattern.String())
	case namespace != "" && !namespacePattern.MatchString(namespace):
		return fail("namespace must be a DNS label")
	case name == "":
		return fail("name is empty")
	case !utf8.ValidString(name):
		return fail("name is not valid UTF-8")
	}
	var k string
	if namespace == "" {
		k = kind + ":" + EscapeName(name)
	} else {
		k = kind + ":" + namespace + "/" + EscapeName(name)
	}
	if len(k) > MaxKeyLength {
		return fail(fmt.Sprintf("key is %d bytes, longer than %d", len(k), MaxKeyLength))
	}
	if !keyPattern.MatchString(k) {
		return fail("key does not match the contract pattern")
	}
	return k, nil
}

// ParseKey 拆分 ComponentKey，返回 kind、命名空间（集群级对象为空）与解码后的名称。
func ParseKey(key string) (kind, namespace, name string, err error) {
	if len(key) > MaxKeyLength || !keyPattern.MatchString(key) {
		return "", "", "", fmt.Errorf("topology: %q is not a component key", key)
	}
	kind, rest, _ := strings.Cut(key, ":")
	seg := rest
	if ns, n, has := strings.Cut(rest, "/"); has {
		namespace, seg = ns, n
	}
	name, err = UnescapeName(seg)
	if err != nil {
		return "", "", "", fmt.Errorf("topology: component key %q: %w", key, err)
	}
	return kind, namespace, name, nil
}

// NewNode 构造一个节点。namespace 与 uid 为空字符串时输出 null；Name 是对象的原始名称，Key 中是编码后的名称段。
func NewNode(kind, namespace, name, uid string, labels map[string]string) (Node, error) {
	k, err := Key(kind, namespace, name)
	if err != nil {
		return Node{}, err
	}
	n := Node{Key: k, Kind: kind, Name: name, Labels: map[string]string{}}
	if namespace != "" {
		ns := namespace
		n.Namespace = &ns
	}
	if uid != "" {
		u := uid
		n.UID = &u
	}
	for k, v := range labels {
		n.Labels[k] = v
	}
	return n, nil
}

// Structural 构造一条结构性边（置信度 1.0）。
func Structural(from, to, relation string, scope Scope, evidence string) Edge {
	return Edge{From: from, To: to, Relation: relation, Provenance: ProvStructural, Confidence: ConfStructural, Scope: scope, Evidence: clip(evidence)}
}

func clip(s string) string {
	r := []rune(s)
	if len(r) > 500 {
		return string(r[:500])
	}
	return s
}

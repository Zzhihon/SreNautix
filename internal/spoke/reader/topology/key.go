package topology

import (
	"fmt"
	"regexp"
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

var keyPattern = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9.-]*:([a-z0-9]([-a-z0-9]*[a-z0-9])?/)?[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$`)

// Key 返回 ComponentKey：命名空间内对象为 <kind>:<namespace>/<name>，集群级对象为 <kind>:<name>。
func Key(kind, namespace, name string) string {
	var k string
	if namespace == "" {
		k = kind + ":" + name
	} else {
		k = kind + ":" + namespace + "/" + name
	}
	if !keyPattern.MatchString(k) || len(k) > 400 {
		panic(fmt.Sprintf("topology: invalid component key %q", k))
	}
	return k
}

// NewNode 构造一个节点。namespace 与 uid 为空字符串时输出 null。
func NewNode(kind, namespace, name, uid string, labels map[string]string) Node {
	n := Node{Key: Key(kind, namespace, name), Kind: kind, Name: name, Labels: map[string]string{}}
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
	return n
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

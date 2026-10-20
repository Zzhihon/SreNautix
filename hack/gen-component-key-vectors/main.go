// gen-component-key-vectors 生成 contract/testvectors/component-keys.json：ComponentKey 的编码黄金向量（ADR 0034）。
// 期望的键在这里逐个手写（长度边界用 strings.Repeat 构造），不调用任何实现；Go（internal/spoke/reader/topology）
// 与 TypeScript（packages/core）的实现都必须对每个用例给出相同的结果。用法：go run ./hack/gen-component-key-vectors
package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// object 是一个对象到键的用例：kind、namespace（集群级对象为 null）、对象原名，以及唯一正确的键。
type object struct {
	Name      string  `json:"name"`
	Kind      string  `json:"kind"`
	Namespace *string `json:"namespace"`
	Object    string  `json:"object_name"`
	Key       string  `json:"key"`
}

// rejectedObject 是无法生成键的对象：实现必须报错，不能截断、替换或忽略非法部分。
type rejectedObject struct {
	Name      string  `json:"name"`
	Kind      string  `json:"kind"`
	Namespace *string `json:"namespace"`
	Object    string  `json:"object_name"`
	Reason    string  `json:"reason"`
}

// rejectedKey 是解析时必须拒绝的字符串：不符合契约模式，或者名称段不是规范编码。
type rejectedKey struct {
	Name   string `json:"name"`
	Key    string `json:"key"`
	Reason string `json:"reason"`
}

func ns(s string) *string { return &s }

func main() {
	long := strings.Repeat("a", 388)
	doc := map[string]any{
		"description": "ComponentKey 编码（ADR 0034）。keys：对象（kind、namespace、object_name）编码后必须恰好等于 key，" +
			"key 解析后必须还原出同样的三元组。rejected_objects：编码必须报错。rejected_keys：解析必须报错。" +
			"名称段：object_name 的 UTF-8 字节中 A–Z a–z 0–9 '-' '.' '_' 原样保留，其余每个字节写成 '%' 加两位大写十六进制；" +
			"解析只接受这种规范编码。键的长度上限 400 按编码后的字节计算。",
		"max_length": 400,
		"keys": []object{
			{"dns_name_unchanged", "Deployment", ns("app"), "api", "Deployment:app/api"},
			{"cluster_scoped", "Node", nil, "n1", "Node:n1"},
			{"crd_kind_with_group", "Application.argoproj.io", ns("argocd"), "app", "Application.argoproj.io:argocd/app"},
			{"namespace_pseudo_component", "Namespace", nil, "app", "Namespace:app"},
			{"domain_pack_kind_upper_and_underscore", "postgres.cluster", ns("db"), "Main_DB.v2", "postgres.cluster:db/Main_DB.v2"},
			{"rbac_colon", "ClusterRole", nil, "cert-manager-controller-approve:cert-manager-io",
				"ClusterRole:cert-manager-controller-approve%3Acert-manager-io"},
			{"rbac_system_prefix", "ClusterRoleBinding", nil, "system:kube-controller-manager", "ClusterRoleBinding:system%3Akube-controller-manager"},
			{"namespaced_rbac_double_colon", "RoleBinding", ns("kube-system"), "system::leader-locking-kube-controller-manager",
				"RoleBinding:kube-system/system%3A%3Aleader-locking-kube-controller-manager"},
			{"percent_is_escaped", "Role", ns("app"), "50%-quota", "Role:app/50%25-quota"},
			{"already_escaped_looking_name", "Role", ns("app"), "a%3Ab", "Role:app/a%253Ab"},
			{"slash_cannot_fake_namespace", "ClusterRole", nil, "app/api", "ClusterRole:app%2Fapi"},
			{"space_at_plus", "ClusterRole", nil, "edit view@team+ops", "ClusterRole:edit%20view%40team%2Bops"},
			{"tilde_is_escaped", "ClusterRole", nil, "~admin", "ClusterRole:%7Eadmin"},
			{"leading_and_trailing_punctuation", "ClusterRole", nil, "-x.", "ClusterRole:-x."},
			{"non_ascii_two_byte", "ClusterRole", nil, "café", "ClusterRole:caf%C3%A9"},
			{"non_ascii_cjk", "Role", ns("ops"), "运维", "Role:ops/%E8%BF%90%E7%BB%B4"},
			{"non_ascii_four_byte", "ClusterRole", nil, "on-call-\U0001F4DF", "ClusterRole:on-call-%F0%9F%93%9F"},
			{"length_exactly_400", "ClusterRole", nil, long, "ClusterRole:" + long},
		},
		"rejected_objects": []rejectedObject{
			{"empty_name", "Pod", ns("app"), "", "name is empty"},
			{"kind_with_space", "Bad Kind", nil, "x", "kind must start with a letter and contain only letters, digits, '.' and '-'"},
			{"kind_starts_with_digit", "1Pod", ns("app"), "x", "kind must start with a letter"},
			{"kind_with_colon", "Cluster:Role", nil, "x", "kind must not contain ':'"},
			{"namespace_upper_case", "Pod", ns("App"), "x", "namespace must be a DNS label"},
			{"namespace_with_underscore", "Pod", ns("not_a_label"), "x", "namespace must be a DNS label"},
			{"namespace_with_slash", "Pod", ns("a/b"), "x", "namespace must be a DNS label"},
			{"length_401", "ClusterRole", nil, long + "a", "key longer than 400"},
			{"escaping_overflows_length", "ClusterRole", nil, strings.Repeat(":", 130), "escaped key is 402 bytes"},
		},
		"rejected_keys": []rejectedKey{
			{"raw_colon_in_name", "ClusterRole:a:b", "':' must be escaped"},
			{"raw_space_in_name", "ClusterRole:a b", "' ' must be escaped"},
			{"lower_case_hex", "ClusterRole:a%3ab", "escapes use upper-case hex"},
			{"escaped_unreserved", "ClusterRole:%41dmin", "'A' must appear literally"},
			{"truncated_escape", "ClusterRole:a%3", "escape needs two hex digits"},
			{"bare_percent", "ClusterRole:100%", "escape needs two hex digits"},
			{"invalid_utf8", "ClusterRole:caf%C3", "decoded name is not valid UTF-8"},
			{"overlong_utf8", "ClusterRole:%C0%AF", "decoded name is not valid UTF-8"},
			{"empty_name", "Pod:app/", "name segment is empty"},
			{"empty_kind", ":app/x", "kind is empty"},
			{"no_separator", "Pod", "missing ':'"},
			{"bad_namespace", "Pod:App/x", "namespace must be a DNS label"},
			{"two_slashes", "Pod:a/b/c", "'/' in the name must be escaped"},
			{"too_long", "ClusterRole:" + long + "a", "longer than 400"},
		},
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(doc); err != nil {
		panic(err)
	}
	_, file, _, _ := runtime.Caller(0)
	out := filepath.Join(filepath.Dir(file), "..", "..", "contract", "testvectors", "component-keys.json")
	if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
		panic(err)
	}
	if err := os.WriteFile(out, buf.Bytes(), 0o644); err != nil {
		panic(err)
	}
}

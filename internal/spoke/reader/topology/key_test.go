package topology

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func repoFile(t *testing.T, parts ...string) []byte {
	t.Helper()
	_, file, _, _ := runtime.Caller(0)
	b, err := os.ReadFile(filepath.Join(append([]string{filepath.Dir(file), "..", "..", "..", ".."}, parts...)...))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

type keyVectors struct {
	MaxLength int `json:"max_length"`
	Keys      []struct {
		Name      string  `json:"name"`
		Kind      string  `json:"kind"`
		Namespace *string `json:"namespace"`
		Object    string  `json:"object_name"`
		Key       string  `json:"key"`
	} `json:"keys"`
	RejectedObjects []struct {
		Name      string  `json:"name"`
		Kind      string  `json:"kind"`
		Namespace *string `json:"namespace"`
		Object    string  `json:"object_name"`
	} `json:"rejected_objects"`
	RejectedKeys []struct {
		Name string `json:"name"`
		Key  string `json:"key"`
	} `json:"rejected_keys"`
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// TestComponentKeyVectors 校验 contract/testvectors/component-keys.json：TypeScript 一侧用同一个文件，两边的键逐字节相同。
func TestComponentKeyVectors(t *testing.T) {
	var v keyVectors
	if err := json.Unmarshal(repoFile(t, "contract", "testvectors", "component-keys.json"), &v); err != nil {
		t.Fatal(err)
	}
	if v.MaxLength != MaxKeyLength || len(v.Keys) == 0 || len(v.RejectedObjects) == 0 || len(v.RejectedKeys) == 0 {
		t.Fatalf("vector file: max_length %d, %d keys, %d rejected objects, %d rejected keys", v.MaxLength, len(v.Keys), len(v.RejectedObjects), len(v.RejectedKeys))
	}
	for _, c := range v.Keys {
		t.Run("key/"+c.Name, func(t *testing.T) {
			ns := deref(c.Namespace)
			k, err := Key(c.Kind, ns, c.Object)
			if err != nil || k != c.Key {
				t.Fatalf("Key(%q, %q, %q) = %q, %v; want %q", c.Kind, ns, c.Object, k, err, c.Key)
			}
			kind, gotNS, name, err := ParseKey(c.Key)
			if err != nil || kind != c.Kind || gotNS != ns || name != c.Object {
				t.Fatalf("ParseKey(%q) = %q %q %q %v", c.Key, kind, gotNS, name, err)
			}
			n, err := NewNode(c.Kind, ns, c.Object, "", nil)
			if err != nil || n.Key != c.Key || n.Name != c.Object {
				t.Fatalf("NewNode: %+v %v (the node keeps the original name)", n, err)
			}
		})
	}
	for _, c := range v.RejectedObjects {
		t.Run("rejected-object/"+c.Name, func(t *testing.T) {
			k, err := Key(c.Kind, deref(c.Namespace), c.Object)
			var ke *KeyError
			if !errors.As(err, &ke) || k != "" {
				t.Fatalf("Key accepted %q/%q/%q as %q (err %v)", c.Kind, deref(c.Namespace), c.Object, k, err)
			}
		})
	}
	for _, c := range v.RejectedKeys {
		t.Run("rejected-key/"+c.Name, func(t *testing.T) {
			if kind, ns, name, err := ParseKey(c.Key); err == nil {
				t.Fatalf("ParseKey accepted %q as %q %q %q", c.Key, kind, ns, name)
			}
		})
	}
}

// 契约中的 pattern 与实现使用的必须是同一个表达式。
func TestComponentKeyPatternMatchesContract(t *testing.T) {
	var schema struct {
		Defs map[string]struct {
			Pattern   string `json:"pattern"`
			MaxLength int    `json:"maxLength"`
		} `json:"$defs"`
	}
	if err := json.Unmarshal(repoFile(t, "contract", "schemas", "common.schema.json"), &schema); err != nil {
		t.Fatal(err)
	}
	d := schema.Defs["ComponentKey"]
	if d.Pattern != keyPattern.String() || d.MaxLength != MaxKeyLength {
		t.Fatalf("contract ComponentKey pattern %q / maxLength %d, implementation %q / %d", d.Pattern, d.MaxLength, keyPattern.String(), MaxKeyLength)
	}
}

func TestKeyRejectsInvalidUTF8Name(t *testing.T) {
	if _, err := Key("ClusterRole", "", "caf\xc3"); err == nil {
		t.Fatal("name with invalid UTF-8 accepted")
	}
}

// 回归：Argo CD status.resources 中名称带冒号的 RBAC 对象（CCHP 影子环境中 reader 曾因此 panic 退出）。
// 冒号按规范编码进入拓扑；仍然无法生成键的条目只跳过它自己，Application 与其余受管资源照常贡献。
func TestArgoApplicationWithColonAndInvalidResources(t *testing.T) {
	app := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "argoproj.io/v1alpha1", "kind": "Application",
		"metadata": map[string]any{"namespace": "argocd", "name": "cert-manager", "uid": "u-app"},
		"spec":     map[string]any{"destination": map[string]any{"server": "https://kubernetes.default.svc"}},
		"status": map[string]any{"resources": []any{
			map[string]any{"group": "rbac.authorization.k8s.io", "kind": "ClusterRole", "name": "cert-manager-controller-approve:cert-manager-io"},
			map[string]any{"group": "apps", "kind": "Deployment", "namespace": "cert-manager", "name": "cert-manager"},
			map[string]any{"kind": "ConfigMap", "namespace": "Not_A_Label", "name": "x"},
			map[string]any{"kind": "Service", "namespace": "cert-manager", "name": "cert-manager"},
		}},
	}}
	c := argoApplication{}.Extract(app)
	const appKey = "Application.argoproj.io:argocd/cert-manager"
	want := map[string]bool{
		"ClusterRole:cert-manager-controller-approve%3Acert-manager-io|managed_by|" + appKey: true,
		"Deployment:cert-manager/cert-manager|managed_by|" + appKey:                          true,
		"Service:cert-manager/cert-manager|managed_by|" + appKey:                             true,
	}
	if len(c.Edges) != len(want) {
		t.Fatalf("edges %+v", c.Edges)
	}
	for _, e := range c.Edges {
		if !want[e.ID()] {
			t.Fatalf("unexpected edge %s", e.ID())
		}
	}
	var role *Node
	for i := range c.Nodes {
		if c.Nodes[i].Node.Kind == "ClusterRole" {
			role = &c.Nodes[i].Node
		}
	}
	if role == nil || role.Name != "cert-manager-controller-approve:cert-manager-io" {
		t.Fatalf("ClusterRole node keeps its original name: %+v", role)
	}
	if len(c.Problems) != 1 || !c.Problems[0].InvalidKey || c.Problems[0].Kind != "ConfigMap" || c.Problems[0].Namespace != "Not_A_Label" {
		t.Fatalf("problems %+v", c.Problems)
	}

	// 字段类型与预期不符：记录问题，不 panic
	bad := app.DeepCopy()
	bad.Object["status"] = map[string]any{"resources": "not-a-list"}
	c = argoApplication{}.Extract(bad)
	if len(c.Edges) != 0 || len(c.Problems) != 1 || c.Problems[0].InvalidKey {
		t.Fatalf("malformed status.resources: %+v", c)
	}
}

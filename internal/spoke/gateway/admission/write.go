package admission

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	yamlv3 "go.yaml.in/yaml/v3"
)

const header = "# 由 internal/spoke/gateway/admission 生成（make gateway-generate），不要手工修改。\n"

// encode 输出不折行的 YAML：CEL 表达式与 Helm 的 include 必须保持在一行内，tpl 渲染前后含义一致。
func encode(v any) ([]byte, error) {
	raw, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	var generic any
	if err := json.Unmarshal(raw, &generic); err != nil {
		return nil, err
	}
	var buf bytes.Buffer
	enc := yamlv3.NewEncoder(&buf)
	enc.SetIndent(2)
	if err := enc.Encode(generic); err != nil {
		return nil, err
	}
	if err := enc.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// Marshal 返回策略文件内容。
func (p Policy) Marshal() ([]byte, error) {
	b, err := encode(p.Doc)
	if err != nil {
		return nil, err
	}
	return append([]byte(header), b...), nil
}

// Files 返回全部输出文件：文件名到内容。
func (o *Output) Files() (map[string][]byte, error) {
	files := map[string][]byte{}
	idx, err := encode(o.Index)
	if err != nil {
		return nil, err
	}
	files["index.yaml"] = append([]byte(header), idx...)
	for _, p := range o.Policies {
		b, err := p.Marshal()
		if err != nil {
			return nil, err
		}
		files[p.File] = b
	}
	return files, nil
}

// WriteDir 把输出写入 dir：先删除 dir 中已有的 .yaml 文件（这个目录只放生成结果），再写入。
func (o *Output) WriteDir(dir string) error {
	files, err := o.Files()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	old, err := filepath.Glob(filepath.Join(dir, "*.yaml"))
	if err != nil {
		return err
	}
	for _, f := range old {
		if err := os.Remove(f); err != nil {
			return err
		}
	}
	for name, b := range files {
		if err := os.WriteFile(filepath.Join(dir, name), b, 0o644); err != nil {
			return err
		}
	}
	return nil
}

// Binding 返回与 chart 相同形状的 Binding：paramRef 指向 srenautix-freeze，ConfigMap 缺失时拒绝。
func Binding(policyName, freezeNamespace string) map[string]any {
	return map[string]any{
		"apiVersion": "admissionregistration.k8s.io/v1",
		"kind":       "ValidatingAdmissionPolicyBinding",
		"metadata":   map[string]any{"name": policyName},
		"spec": map[string]any{
			"policyName":        policyName,
			"validationActions": []any{"Deny"},
			"paramRef": map[string]any{
				"name": "srenautix-freeze", "namespace": freezeNamespace, "parameterNotFoundAction": "Deny",
			},
		},
	}
}

// Join 把多个 YAML 文档拼成一个多文档流。
func Join(docs ...[]byte) []byte {
	var buf bytes.Buffer
	for i, d := range docs {
		if i > 0 {
			buf.WriteString("---\n")
		}
		buf.Write(d)
	}
	return buf.Bytes()
}

// MarshalDoc 输出一个对象的 YAML。
func MarshalDoc(doc map[string]any) ([]byte, error) {
	b, err := encode(doc)
	if err != nil {
		return nil, fmt.Errorf("marshal %v: %w", doc["kind"], err)
	}
	return b, nil
}

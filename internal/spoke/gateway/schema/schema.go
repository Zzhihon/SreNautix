// Package schema 编译 contract/gateway/v1 中的 JSON Schema，并按 schema 校验 JSON 或 YAML 文档。
package schema

import (
	"bytes"
	"fmt"
	"io/fs"
	"path"
	"strings"
	"sync"

	"github.com/santhosh-tekuri/jsonschema/v6"
	"sigs.k8s.io/yaml"

	contract "github.com/Zzhihon/SreNautix/contract/gateway"
)

// 契约中的 schema 文件名。
const (
	ApprovalAssertion = "approval-assertion.schema.json"
	ApprovalEnvelope  = "approval-envelope.schema.json"
	ApproverKeys      = "approver-keys.schema.json"
	ActionCatalog     = "action-catalog.schema.json"
	GatewayPolicy     = "gateway-policy.schema.json"
	AuditRecord       = "audit-record.schema.json"
)

var (
	once     sync.Once
	compiled map[string]*jsonschema.Schema
	compiler *jsonschema.Compiler
	defsMu   sync.Mutex
	initErr  error
)

// GetDef 返回某个 schema 文件中 $defs/<def> 的编译结果。
func GetDef(name, def string) (*jsonschema.Schema, error) {
	if _, err := Get(name); err != nil {
		return nil, err
	}
	defsMu.Lock()
	defer defsMu.Unlock()
	return compiler.Compile(contract.SchemaBase + name + "#/$defs/" + def)
}

func load() {
	c := jsonschema.NewCompiler()
	entries, err := fs.ReadDir(contract.FS, "v1")
	if err != nil {
		initErr = err
		return
	}
	var names []string
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".schema.json") {
			continue
		}
		raw, err := fs.ReadFile(contract.FS, path.Join("v1", e.Name()))
		if err != nil {
			initErr = err
			return
		}
		doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
		if err != nil {
			initErr = fmt.Errorf("%s: %w", e.Name(), err)
			return
		}
		if err := c.AddResource(contract.SchemaBase+e.Name(), doc); err != nil {
			initErr = fmt.Errorf("%s: %w", e.Name(), err)
			return
		}
		names = append(names, e.Name())
	}
	compiled = map[string]*jsonschema.Schema{}
	compiler = c
	for _, n := range names {
		s, err := c.Compile(contract.SchemaBase + n)
		if err != nil {
			initErr = fmt.Errorf("compile %s: %w", n, err)
			return
		}
		compiled[n] = s
	}
}

// Get 返回编译好的 schema；name 为契约中的文件名。
func Get(name string) (*jsonschema.Schema, error) {
	once.Do(load)
	if initErr != nil {
		return nil, initErr
	}
	s, ok := compiled[name]
	if !ok {
		return nil, fmt.Errorf("schema %s is not in contract/gateway/v1", name)
	}
	return s, nil
}

// ValidateJSON 按 schema 校验一段 JSON。
func ValidateJSON(name string, raw []byte) error {
	s, err := Get(name)
	if err != nil {
		return err
	}
	inst, err := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
	if err != nil {
		return fmt.Errorf("%s: %w", name, err)
	}
	if err := s.Validate(inst); err != nil {
		return fmt.Errorf("%s: %w", name, err)
	}
	return nil
}

// ValidateYAML 把 YAML 转成 JSON 后校验，返回 JSON 形式供调用方解码。
func ValidateYAML(name string, doc []byte) ([]byte, error) {
	raw, err := yaml.YAMLToJSON(doc)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", name, err)
	}
	if err := ValidateJSON(name, raw); err != nil {
		return nil, err
	}
	return raw, nil
}

// ValidateValue 按 schema 校验已解码的值（jsonschema 使用的 any 形式）。
func ValidateValue(s *jsonschema.Schema, raw []byte) error {
	inst, err := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
	if err != nil {
		return err
	}
	return s.Validate(inst)
}

// CompileInline 编译一个内联的 JSON Schema（动作参数、工作流参数约束），按 2020-12 解释。
func CompileInline(id string, raw []byte) (*jsonschema.Schema, error) {
	doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	c := jsonschema.NewCompiler()
	c.DefaultDraft(jsonschema.Draft2020)
	url := "https://srenautix.io/inline/" + id + ".json"
	if err := c.AddResource(url, doc); err != nil {
		return nil, err
	}
	return c.Compile(url)
}

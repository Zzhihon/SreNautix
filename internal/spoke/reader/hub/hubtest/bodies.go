package hubtest

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"

	"github.com/getkin/kin-openapi/openapi3"
	"github.com/santhosh-tekuri/jsonschema/v6"
	"sigs.k8s.io/yaml"
)

// 契约文件的 $id 前缀，与 contract/gateway/embed.go 的 SchemaBase 和 contract/schemas 的 $id 一致。
const (
	gatewayBase = "https://srenautix.io/contract/gateway/v1/"
	schemasBase = "https://srenautix.io/contract/schemas/"
)

// bodies 按 JSON Schema 2020-12 校验请求体与响应体。schema 直接按 JSON 指针从 OpenAPI 文档里编译，
// $ref 由 jsonschema 按文档 URL 解析（reader.openapi.yaml → openapi.yaml → contract/schemas/*.json）。
// kin-openapi v0.151.0 把 #/components/schemas 引用改写到 $defs 时，在遍历 map 的同时向其中插入，
// 三层以上嵌套的引用有时会漏掉改写、编译失败，所以请求体与响应体不交给它校验。
type bodies struct {
	c     *jsonschema.Compiler
	mu    sync.Mutex
	cache map[string]*jsonschema.Schema
}

func addFile(c *jsonschema.Compiler, url, path string) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if strings.HasSuffix(path, ".yaml") {
		raw, err = yaml.YAMLToJSON(raw)
		if err != nil {
			return fmt.Errorf("%s: %w", path, err)
		}
	}
	doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
	if err != nil {
		return fmt.Errorf("%s: %w", path, err)
	}
	return c.AddResource(url, doc)
}

func newBodies() (*bodies, error) {
	c := jsonschema.NewCompiler()
	c.DefaultDraft(jsonschema.Draft2020)
	gw := filepath.Dir(ContractPath())
	gwFiles, err := filepath.Glob(filepath.Join(gw, "*"))
	if err != nil {
		return nil, err
	}
	for _, f := range gwFiles {
		name := filepath.Base(f)
		if strings.HasSuffix(name, ".schema.json") || strings.HasSuffix(name, ".openapi.yaml") || name == "openapi.yaml" {
			if err := addFile(c, gatewayBase+name, f); err != nil {
				return nil, err
			}
		}
	}
	schemaFiles, err := filepath.Glob(filepath.Join(gw, "..", "..", "schemas", "*.schema.json"))
	if err != nil {
		return nil, err
	}
	for _, f := range schemaFiles {
		if err := addFile(c, schemasBase+filepath.Base(f), f); err != nil {
			return nil, err
		}
	}
	return &bodies{c: c, cache: map[string]*jsonschema.Schema{}}, nil
}

func escape(token string) string {
	return strings.NewReplacer("~", "~0", "/", "~1").Replace(token)
}

func (b *bodies) compile(loc string) (*jsonschema.Schema, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if s, ok := b.cache[loc]; ok {
		return s, nil
	}
	s, err := b.c.Compile(loc)
	if err != nil {
		return nil, err
	}
	b.cache[loc] = s
	return s, nil
}

func (b *bodies) validate(loc string, body []byte) error {
	s, err := b.compile(loc)
	if err != nil {
		return fmt.Errorf("compile %s: %w", loc, err)
	}
	inst, err := jsonschema.UnmarshalJSON(bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("body is not JSON: %w", err)
	}
	return s.Validate(inst)
}

// requestLoc 返回操作请求体 schema 的位置；操作没有请求体时返回空串。
func requestLoc(path, method string, op *openapi3.Operation) string {
	if op.RequestBody == nil {
		return ""
	}
	return gatewayBase + "reader.openapi.yaml#/paths/" + escape(path) + "/" + strings.ToLower(method) + "/requestBody/content/application~1json/schema"
}

// responseLoc 返回状态码 status 的响应体 schema 位置。响应以 $ref 引用 components/responses 时，位置在被引用的响应里。
func responseLoc(path, method string, op *openapi3.Operation, status int) (string, error) {
	code := strconv.Itoa(status)
	ref := op.Responses.Value(code)
	if ref == nil {
		return "", fmt.Errorf("status %d is not declared for %s %s", status, method, path)
	}
	if ref.Ref != "" {
		if !strings.HasPrefix(ref.Ref, "#/") {
			return "", fmt.Errorf("response ref %q outside the reader contract", ref.Ref)
		}
		return gatewayBase + "reader.openapi.yaml" + ref.Ref + "/content/application~1json/schema", nil
	}
	return gatewayBase + "reader.openapi.yaml#/paths/" + escape(path) + "/" + strings.ToLower(method) + "/responses/" + code + "/content/application~1json/schema", nil
}

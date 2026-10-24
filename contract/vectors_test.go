// Package contract_test 用 Go 的 JSON Schema 实现核对 contract/testvectors 中的黄金夹具：
// 与 packages/contract 的 TS（ajv）测试读取同一份文件，两边对每个用例给出相同的结果。
package contract_test

import (
	"bytes"
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

const base = "https://srenautix.io/contract/"

func contractDir(t *testing.T) string {
	t.Helper()
	_, file, _, _ := runtime.Caller(0)
	return filepath.Dir(file)
}

// compiler 注册 contract/ 下的全部 *.schema.json（按文件中的 $id），并像 ajv-formats 一样断言 format
func compiler(t *testing.T, dir string) *jsonschema.Compiler {
	t.Helper()
	c := jsonschema.NewCompiler()
	c.DefaultDraft(jsonschema.Draft2020)
	c.AssertFormat()
	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(path, ".schema.json") {
			return err
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(dir, path)
		if err != nil {
			return err
		}
		return c.AddResource(base+filepath.ToSlash(rel), doc)
	})
	if err != nil {
		t.Fatal(err)
	}
	return c
}

type vector struct {
	Name     string          `json:"name"`
	Schema   string          `json:"schema"`
	Instance json.RawMessage `json:"instance"`
}

func TestOptimizationVectors(t *testing.T) {
	dir := contractDir(t)
	raw, err := os.ReadFile(filepath.Join(dir, "testvectors", "optimization.json"))
	if err != nil {
		t.Fatal(err)
	}
	var vectors struct {
		Valid   []vector `json:"valid"`
		Invalid []vector `json:"invalid"`
	}
	if err := json.Unmarshal(raw, &vectors); err != nil {
		t.Fatal(err)
	}
	if len(vectors.Valid) == 0 || len(vectors.Invalid) == 0 {
		t.Fatal("夹具为空")
	}
	c := compiler(t, dir)
	check := func(v vector, wantValid bool) {
		t.Run(v.Name, func(t *testing.T) {
			s, err := c.Compile(base + v.Schema)
			if err != nil {
				t.Fatalf("编译 %s：%v", v.Schema, err)
			}
			inst, err := jsonschema.UnmarshalJSON(bytes.NewReader(v.Instance))
			if err != nil {
				t.Fatal(err)
			}
			err = s.Validate(inst)
			if wantValid && err != nil {
				t.Fatalf("应当通过：%v", err)
			}
			if !wantValid && err == nil {
				t.Fatal("应当被拒绝")
			}
		})
	}
	for _, v := range vectors.Valid {
		check(v, true)
	}
	for _, v := range vectors.Invalid {
		check(v, false)
	}
}

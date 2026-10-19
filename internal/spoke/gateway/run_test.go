package gateway_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Zzhihon/SreNautix/internal/spoke/gateway"
	"github.com/Zzhihon/SreNautix/internal/spoke/testenv"
)

// docs/gateway/README.md 中的配置示例必须能被加载。
func TestDocumentedConfigLoads(t *testing.T) {
	doc, err := os.ReadFile(filepath.Join(testenv.Root(), "docs", "gateway", "README.md"))
	if err != nil {
		t.Fatal(err)
	}
	start := strings.Index(string(doc), "```yaml\ncluster_id:")
	if start < 0 {
		t.Fatal("docs/gateway/README.md has no config example")
	}
	body := string(doc)[start+len("```yaml\n"):]
	body = body[:strings.Index(body, "```")]
	path := filepath.Join(testenv.Scratch(t, "config"), "config.yaml")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	fc, err := gateway.LoadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if fc.Gateway.MaxConcurrent != 4 || fc.Audit.ObjectLock.Mode != "GOVERNANCE" {
		t.Fatalf("loaded %+v", fc)
	}
	if err := os.WriteFile(path, []byte(body+"unknown_field: 1\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := gateway.LoadConfig(path); err == nil {
		t.Fatal("config with an unknown field loaded")
	}
}

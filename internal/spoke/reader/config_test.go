package reader

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/Zzhihon/SreNautix/internal/spoke/reader/testenv"
)

// docSample 取出 docs/reader/README.md 中"配置"一节的 YAML 示例，保证文档与解析器一致。
func docSample(t *testing.T) string {
	t.Helper()
	_, file, _, _ := runtime.Caller(0)
	b, err := os.ReadFile(filepath.Join(filepath.Dir(file), "..", "..", "..", "docs", "reader", "README.md"))
	if err != nil {
		t.Fatal(err)
	}
	doc := string(b)
	start := strings.Index(doc, "## 配置\n\n```yaml\n")
	if start < 0 {
		t.Fatal("config section not found in docs/reader/README.md")
	}
	body := doc[start+len("## 配置\n\n```yaml\n"):]
	return body[:strings.Index(body, "```")]
}

func TestDocumentedConfigLoads(t *testing.T) {
	dir := testenv.Scratch(t, "config")
	path := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(path, []byte(docSample(t)), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := LoadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ClusterID != "edge-1" || cfg.Alerts.MetricsDatasource != "metrics" || cfg.History.Step != Duration(5*time.Minute) {
		t.Fatalf("parsed config: %+v", cfg)
	}
	if cfg.Datasources[0].HTTP.Authorization == nil || cfg.Datasources[0].HTTP.Authorization.CredentialsFile != "/var/run/srenautix/metrics-token" {
		t.Fatalf("datasource http config: %+v", cfg.Datasources[0].HTTP)
	}
	l := cfg.limits()
	if l.MaxRange != 7*24*time.Hour || l.Concurrency != 8 || l.Timeout != 10*time.Second || l.MaxBytes != 16<<20 {
		t.Fatalf("limits: %+v", l)
	}

	// 未知的键与引用未配置的数据源直接报错
	for name, extra := range map[string]string{
		"unknown key":        "\nunknown_key: 1\n",
		"unknown datasource": "",
	} {
		content := docSample(t) + extra
		if name == "unknown datasource" {
			content = strings.Replace(content, "  metrics_datasource: metrics", "  metrics_datasource: other", 1)
		}
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := LoadConfig(path); err == nil {
			t.Fatalf("%s: config loaded", name)
		}
	}
}

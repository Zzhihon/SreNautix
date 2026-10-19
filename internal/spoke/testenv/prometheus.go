package testenv

import (
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Prometheus 是一个真实的 Prometheus 进程（SRENAUTIX_TEST_BIN 目录中的 prometheus，与
// .github/scripts/install-test-binaries.sh 相同），每秒抓取一次测试进程暴露的指标端点 Registry。
type Prometheus struct {
	URL      string
	Registry *prometheus.Registry
}

// StartPrometheus 启动指标端点与 Prometheus，等到第一次抓取成功。
func StartPrometheus(t testing.TB) *Prometheus {
	t.Helper()
	bin := filepath.Join(RequireEnv(t, "SRENAUTIX_TEST_BIN"), "prometheus")
	reg := prometheus.NewRegistry()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: promhttp.HandlerFor(reg, promhttp.HandlerOpts{}), ReadHeaderTimeout: 5 * time.Second}
	go func() { _ = srv.Serve(l) }()
	t.Cleanup(func() { _ = srv.Close() })
	dir := Scratch(t, "prometheus")
	cfg := "global:\n  scrape_interval: 1s\n  evaluation_interval: 1s\nscrape_configs:\n  - job_name: target\n    static_configs:\n      - targets: ['" + l.Addr().String() + "']\n"
	if err := os.WriteFile(filepath.Join(dir, "prometheus.yml"), []byte(cfg), 0o644); err != nil {
		t.Fatal(err)
	}
	port := FreePort(t)
	cmd := exec.Command(bin, "--config.file="+filepath.Join(dir, "prometheus.yml"), "--storage.tsdb.path="+filepath.Join(dir, "data"),
		"--web.listen-address=127.0.0.1:"+strconv.Itoa(port), "--log.level=error")
	logf, err := os.Create(filepath.Join(dir, "prometheus.log"))
	if err != nil {
		t.Fatal(err)
	}
	cmd.Stdout, cmd.Stderr = logf, logf
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		_ = logf.Close()
	})
	p := &Prometheus{URL: "http://127.0.0.1:" + strconv.Itoa(port), Registry: reg}
	Eventually(t, 60*time.Second, "prometheus ready", func() (bool, string) {
		resp, err := http.Get(p.URL + "/-/ready")
		if err != nil {
			return false, err.Error()
		}
		resp.Body.Close()
		return resp.StatusCode == 200, resp.Status
	})
	return p
}

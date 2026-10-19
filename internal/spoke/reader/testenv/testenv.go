// Package testenv 为 reader 的集成测试启动真实的依赖：envtest 的 kube-apiserver + etcd、Prometheus、VictoriaMetrics 单机版、
// vmalert、Alertmanager。二进制位置由环境变量给出，缺少时测试直接失败：
//
//	KUBEBUILDER_ASSETS             setup-envtest 下载的 kube-apiserver / etcd 目录
//	SRENAUTIX_TEST_BIN             prometheus、promtool、victoria-metrics-prod、vmalert-prod、alertmanager 所在目录
//
// 运行时目录都在仓库根目录的 .scratch/test 下（已被 gitignore）。crds/ 是上游原样的 CRD：
// Argo CD v3.1.8 Application、Flux kustomize-controller v1.7.0 Kustomization、CNPG v1.27.0 Cluster、Gateway API v1.5.1 HTTPRoute。
package testenv

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"testing"
	"time"

	"k8s.io/client-go/rest"
	"sigs.k8s.io/controller-runtime/pkg/envtest"
)

func repoRoot() string {
	_, file, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(file), "..", "..", "..", "..")
}

// Scratch 返回本次测试的工作目录（.scratch/test/<name>-<随机>），测试结束时删除。
func Scratch(t testing.TB, name string) string {
	t.Helper()
	root := filepath.Join(repoRoot(), ".scratch", "test")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	dir, err := os.MkdirTemp(root, name+"-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return dir
}

func requireEnv(t testing.TB, name string) string {
	t.Helper()
	v := os.Getenv(name)
	if v == "" {
		t.Fatalf("%s is required for this integration test (see internal/spoke/reader/testenv)", name)
	}
	return v
}

// Bin 返回 SRENAUTIX_TEST_BIN 下的可执行文件路径。
func Bin(t testing.TB, name string) string {
	t.Helper()
	p := filepath.Join(requireEnv(t, "SRENAUTIX_TEST_BIN"), name)
	if _, err := os.Stat(p); err != nil {
		t.Fatalf("test binary %s: %v", name, err)
	}
	return p
}

// FreePort 返回一个当前空闲的本地端口。
func FreePort(t testing.TB) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

// CRDDir 返回上游 CRD 目录。
func CRDDir() string {
	_, file, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(file), "crds")
}

// StartKube 启动 envtest 的 kube-apiserver 与 etcd。withCRDs 为 true 时安装 crds/ 下的全部 CRD。
func StartKube(t testing.TB, withCRDs bool) (*rest.Config, *envtest.Environment) {
	t.Helper()
	requireEnv(t, "KUBEBUILDER_ASSETS")
	env := &envtest.Environment{ErrorIfCRDPathMissing: true}
	if withCRDs {
		env.CRDDirectoryPaths = []string{CRDDir()}
	}
	cfg, err := env.Start()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := env.Stop(); err != nil {
			t.Errorf("envtest stop: %v", err)
		}
	})
	return cfg, env
}

// Process 是一个由测试启动的外部进程。
type Process struct {
	URL string
	Dir string
	cmd *exec.Cmd
	log syncBuffer
}

// Log 返回进程的输出。
func (p *Process) Log() string {
	p.log.mu <- struct{}{}
	defer func() { <-p.log.mu }()
	return p.log.buf.String()
}

// Stop 结束进程（SIGKILL）并等待退出。
func (p *Process) Stop() {
	if p.cmd.ProcessState == nil {
		_ = p.cmd.Process.Kill()
		_ = p.cmd.Wait()
	}
}

type syncBuffer struct {
	buf *bytes.Buffer
	mu  chan struct{}
}

func (s syncBuffer) Write(p []byte) (int, error) {
	s.mu <- struct{}{}
	defer func() { <-s.mu }()
	return s.buf.Write(p)
}

func start(t testing.TB, name, dir, readyURL string, bin string, args ...string) *Process {
	t.Helper()
	cmd := exec.Command(bin, args...)
	cmd.Dir = dir
	w := syncBuffer{buf: &bytes.Buffer{}, mu: make(chan struct{}, 1)}
	cmd.Stdout, cmd.Stderr = w, w
	if err := cmd.Start(); err != nil {
		t.Fatalf("start %s: %v", name, err)
	}
	p := &Process{Dir: dir, cmd: cmd, log: w}
	t.Cleanup(p.Stop)
	deadline := time.Now().Add(60 * time.Second)
	for {
		resp, err := http.Get(readyURL)
		if err == nil {
			_, _ = io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return p
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("%s did not become ready at %s: %v\n%s", name, readyURL, err, p.Log())
		}
		time.Sleep(200 * time.Millisecond)
	}
}

// StartPrometheus 启动 Prometheus。dataDir 可以是 promtool 回填过的 TSDB 目录；configYAML 是完整的 prometheus.yml 内容。
func StartPrometheus(t testing.TB, dataDir, configYAML string) *Process {
	t.Helper()
	dir := Scratch(t, "prometheus")
	cfg := filepath.Join(dir, "prometheus.yml")
	if err := os.WriteFile(cfg, []byte(configYAML), 0o644); err != nil {
		t.Fatal(err)
	}
	port := FreePort(t)
	url := fmt.Sprintf("http://127.0.0.1:%d", port)
	p := start(t, "prometheus", dir, url+"/-/ready", Bin(t, "prometheus"),
		"--config.file="+cfg, "--storage.tsdb.path="+dataDir, "--web.listen-address=127.0.0.1:"+strconv.Itoa(port),
		"--storage.tsdb.retention.time=3650d", "--query.lookback-delta=5m")
	p.URL = url
	return p
}

// BackfillPrometheus 用 promtool 把 OpenMetrics 文本回填成 TSDB 块，返回数据目录。
func BackfillPrometheus(t testing.TB, openMetrics string) string {
	t.Helper()
	dir := Scratch(t, "prom-data")
	src := filepath.Join(dir, "input.om")
	if err := os.WriteFile(src, []byte(openMetrics), 0o644); err != nil {
		t.Fatal(err)
	}
	data := filepath.Join(dir, "data")
	out, err := exec.Command(Bin(t, "promtool"), "tsdb", "create-blocks-from", "openmetrics", src, data).CombinedOutput()
	if err != nil {
		t.Fatalf("promtool backfill: %v\n%s", err, out)
	}
	return data
}

// StartVictoriaMetrics 启动 VictoriaMetrics 单机版。latencyOffset 设为 0，测试中刚写入的样本立即可查。
func StartVictoriaMetrics(t testing.TB) *Process {
	t.Helper()
	dir := Scratch(t, "vm")
	port := FreePort(t)
	url := fmt.Sprintf("http://127.0.0.1:%d", port)
	p := start(t, "victoria-metrics", dir, url+"/health", Bin(t, "victoria-metrics-prod"),
		"-storageDataPath="+filepath.Join(dir, "data"), "-httpListenAddr=127.0.0.1:"+strconv.Itoa(port),
		"-retentionPeriod=100y", "-search.latencyOffset=0s", "-search.disableCache")
	p.URL = url
	return p
}

// ImportVictoriaMetrics 用 /api/v1/import/prometheus 写入带时间戳（毫秒）的 Prometheus 文本格式样本，并强制刷新。
func ImportVictoriaMetrics(t testing.TB, vmURL, text string) {
	t.Helper()
	resp, err := http.Post(vmURL+"/api/v1/import/prometheus", "text/plain", bytes.NewBufferString(text))
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		t.Fatalf("vm import: %d %s", resp.StatusCode, body)
	}
	resp, err = http.Get(vmURL + "/internal/force_flush")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
}

// StartAlertmanager 启动 Alertmanager（单实例，无集群）。
func StartAlertmanager(t testing.TB) *Process {
	t.Helper()
	dir := Scratch(t, "alertmanager")
	cfg := filepath.Join(dir, "alertmanager.yml")
	if err := os.WriteFile(cfg, []byte("route:\n  receiver: blackhole\n  group_wait: 0s\nreceivers:\n  - name: blackhole\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	port := FreePort(t)
	url := fmt.Sprintf("http://127.0.0.1:%d", port)
	p := start(t, "alertmanager", dir, url+"/-/ready", Bin(t, "alertmanager"),
		"--config.file="+cfg, "--storage.path="+filepath.Join(dir, "data"), "--web.listen-address=127.0.0.1:"+strconv.Itoa(port),
		"--cluster.listen-address=")
	p.URL = url
	return p
}

// StartVMAlert 启动 vmalert：从 VictoriaMetrics 读、把 ALERTS 写回 VictoriaMetrics、把告警发给 Alertmanager。
func StartVMAlert(t testing.TB, vmURL, amURL, rulesYAML string) *Process {
	t.Helper()
	dir := Scratch(t, "vmalert")
	rules := filepath.Join(dir, "rules.yml")
	if err := os.WriteFile(rules, []byte(rulesYAML), 0o644); err != nil {
		t.Fatal(err)
	}
	port := FreePort(t)
	url := fmt.Sprintf("http://127.0.0.1:%d", port)
	p := start(t, "vmalert", dir, url+"/health", Bin(t, "vmalert-prod"),
		"-rule="+rules, "-datasource.url="+vmURL, "-remoteWrite.url="+vmURL, "-remoteRead.url="+vmURL,
		"-notifier.url="+amURL, "-evaluationInterval=1s", "-httpListenAddr=127.0.0.1:"+strconv.Itoa(port),
		"-remoteWrite.flushInterval=200ms")
	p.URL = url
	return p
}

// Eventually 每 200ms 调用 cond，直到返回 nil 或超时。
func Eventually(t testing.TB, timeout time.Duration, cond func() error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	var last error
	for {
		if last = cond(); last == nil {
			return
		}
		select {
		case <-ctx.Done():
			t.Fatalf("condition not met within %s: %v", timeout, last)
		case <-time.After(200 * time.Millisecond):
		}
	}
}

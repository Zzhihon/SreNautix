package testenv

import (
	"context"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

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

// MinIO 是一个单机 MinIO 服务（SRENAUTIX_MINIO_BIN 指向 minio 可执行文件，与 .github/scripts/install-test-binaries.sh 相同）。
type MinIO struct {
	t         testing.TB
	bin, dir  string
	Port      int
	AccessKey string
	SecretKey string
	cmd       *exec.Cmd
}

// Endpoint 返回 host:port。
func (m *MinIO) Endpoint() string { return "127.0.0.1:" + strconv.Itoa(m.Port) }

// StartMinIO 启动 MinIO，数据目录在 .scratch/test 下。
func StartMinIO(t testing.TB) *MinIO {
	t.Helper()
	m := &MinIO{t: t, bin: RequireEnv(t, "SRENAUTIX_MINIO_BIN"), dir: Scratch(t, "minio"), Port: FreePort(t),
		AccessKey: "srenautix-test", SecretKey: "srenautix-test-secret"}
	m.Start()
	t.Cleanup(m.Stop)
	return m
}

// Start 启动（或重新启动）进程并等待就绪。
func (m *MinIO) Start() {
	m.t.Helper()
	console := FreePort(m.t)
	cmd := exec.Command(m.bin, "server", filepath.Join(m.dir, "data"), "--address", m.Endpoint(), "--console-address", "127.0.0.1:"+strconv.Itoa(console), "--quiet")
	cmd.Env = append(os.Environ(), "MINIO_ROOT_USER="+m.AccessKey, "MINIO_ROOT_PASSWORD="+m.SecretKey, "MINIO_BROWSER=off")
	logf, err := os.OpenFile(filepath.Join(m.dir, "minio.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		m.t.Fatal(err)
	}
	cmd.Stdout, cmd.Stderr = logf, logf
	if err := cmd.Start(); err != nil {
		m.t.Fatal(err)
	}
	m.cmd = cmd
	Eventually(m.t, 60*time.Second, "minio ready", func() (bool, string) {
		resp, err := http.Get("http://" + m.Endpoint() + "/minio/health/ready")
		if err != nil {
			return false, err.Error()
		}
		resp.Body.Close()
		return resp.StatusCode == 200, resp.Status
	})
}

// Stop 结束进程（审计汇不可用的场景）。
func (m *MinIO) Stop() {
	if m.cmd == nil {
		return
	}
	_ = m.cmd.Process.Kill()
	_ = m.cmd.Wait()
	m.cmd = nil
}

// Client 返回 S3 客户端。
func (m *MinIO) Client(t testing.TB) *minio.Client {
	t.Helper()
	c, err := minio.New(m.Endpoint(), &minio.Options{Creds: credentials.NewStaticV4(m.AccessKey, m.SecretKey, ""), Secure: false})
	if err != nil {
		t.Fatal(err)
	}
	return c
}

// LockedBucket 创建启用对象锁定的存储桶。
func (m *MinIO) LockedBucket(t testing.TB, name string) {
	t.Helper()
	if err := m.Client(t).MakeBucket(context.Background(), name, minio.MakeBucketOptions{ObjectLocking: true}); err != nil {
		t.Fatal(err)
	}
}

package gwtest

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"syscall"
	"testing"
	"time"

	"k8s.io/client-go/tools/clientcmd"
	"k8s.io/utils/clock"
)

// ChildEnv 是子进程读取的环境变量：值为 ChildSpec 的 JSON 文件路径。
const ChildEnv = "SRENAUTIX_GATEWAY_CHILD"

// ChildSpec 描述以子进程运行的 gateway（故障注入测试用 kill -9 结束它）。
type ChildSpec struct {
	Config Config `json:"config"`
	// FaultPoint 不为空时，执行到该点立即以 SIGKILL 结束自身。
	FaultPoint string `json:"faultPoint"`
}

// RunChildIfRequested 在测试二进制的 TestMain 中调用：设置了 ChildEnv 时以子进程身份运行 gateway，直到收到 SIGTERM
// 或在故障点结束自身，然后退出进程；否则返回 false。
func RunChildIfRequested() bool {
	path := os.Getenv(ChildEnv)
	if path == "" {
		return false
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		panic(err)
	}
	var spec ChildSpec
	if err := json.Unmarshal(raw, &spec); err != nil {
		panic(err)
	}
	rc, err := clientcmd.BuildConfigFromFlags("", spec.Config.Kubeconfig)
	if err != nil {
		panic(err)
	}
	t := &childT{}
	var fault func(point, id string)
	if spec.FaultPoint != "" {
		fault = func(point, id string) {
			if point == spec.FaultPoint {
				_ = syscall.Kill(os.Getpid(), syscall.SIGKILL)
				time.Sleep(time.Hour)
			}
		}
	}
	eng, chain, _ := Build(t, rc, spec.Config, clock.RealClock{}, fault, nil)
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM)
	defer stop()
	err = eng.Run(ctx)
	_ = chain.Close()
	if err != nil {
		os.Stderr.WriteString("gateway child: " + err.Error() + "\n")
		os.Exit(1)
	}
	os.Exit(0)
	return true
}

// childT 让 Build 在子进程中把 Fatal 变为进程退出。
type childT struct{ testing.TB }

func (c *childT) Helper()                   {}
func (c *childT) Fatal(args ...any)         { panic(args) }
func (c *childT) Fatalf(f string, a ...any) { panic(append([]any{f}, a...)) }

// Child 是一个以子进程运行的 gateway。
type Child struct {
	Cmd  *exec.Cmd
	Done chan error
}

// StartChild 以子进程运行 gateway（重新执行当前测试二进制）。
func (e *Env) StartChild(o Options, faultPoint string) *Child {
	e.T.Helper()
	cfg := e.Config(o)
	cfg.Kubeconfig = e.Kubeconfig()
	spec, err := json.Marshal(ChildSpec{Config: cfg, FaultPoint: faultPoint})
	if err != nil {
		e.T.Fatal(err)
	}
	path := filepath.Join(e.Dir, "child-"+cfg.Identity+".json")
	if err := os.WriteFile(path, spec, 0o600); err != nil {
		e.T.Fatal(err)
	}
	cmd := exec.Command(os.Args[0], "-test.run=^$")
	cmd.Env = append(os.Environ(), ChildEnv+"="+path)
	logf, err := os.Create(filepath.Join(e.Dir, "child-"+cfg.Identity+".log"))
	if err != nil {
		e.T.Fatal(err)
	}
	cmd.Stdout, cmd.Stderr = logf, logf
	if err := cmd.Start(); err != nil {
		e.T.Fatal(err)
	}
	c := &Child{Cmd: cmd, Done: make(chan error, 1)}
	go func() { c.Done <- cmd.Wait(); _ = logf.Close() }()
	e.T.Cleanup(func() { c.Kill() })
	return c
}

// Kill 以 SIGKILL 结束子进程并等待。
func (c *Child) Kill() {
	if c.Cmd.ProcessState != nil {
		return
	}
	_ = c.Cmd.Process.Signal(syscall.SIGKILL)
	select {
	case <-c.Done:
	case <-time.After(10 * time.Second):
	}
}

// Signal 向子进程发送信号（SIGSTOP、SIGCONT 等）。
func (c *Child) Signal(sig syscall.Signal) error { return c.Cmd.Process.Signal(sig) }

// Exited 表示子进程已经退出。
func (c *Child) Exited(timeout time.Duration) bool {
	select {
	case err := <-c.Done:
		c.Done <- err
		return true
	case <-time.After(timeout):
		return false
	}
}

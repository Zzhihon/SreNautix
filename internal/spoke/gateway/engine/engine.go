// Package engine 是 gateway 的主循环（DESIGN §9.4）：单副本加 Lease 选主；主实例拉取工单、校验断言与策略、
// 在冲突域队列中逐个执行（先写 ActionExecution 再产生副作用）、执行后校验并撤销或转人工、维护执行审计链、
// 把执行事件推回中心。自检、熔断开关、审计汇、时钟偏差或 apiserver 限流任一不满足时只提议、不执行。
package engine

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	coordinationv1 "k8s.io/api/coordination/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/tools/leaderelection"
	"k8s.io/client-go/tools/leaderelection/resourcelock"
	"k8s.io/utils/clock"

	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/assertion"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/audit"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/catalog"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/execution"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/executor"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/github"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/kube"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/metrics"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/policy"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/verify"
	"github.com/Zzhihon/SreNautix/internal/spoke/tunnel"
)

// Config 是引擎的设置。
type Config struct {
	Cluster   string
	Namespace string
	// Identity 是 Lease 身份（Pod 名）；NodeName 是 gateway 所在节点（自我保护）。
	Identity  string
	NodeName  string
	LeaseName string
	Version   string
	// PolicyFile 与 KeysFile 是挂载的 Git 文件，每轮重新读取。
	PolicyFile string
	KeysFile   string
	// AdmissionPolicyPrefix 是生成的准入策略的名称前缀（chart 的 fullname），自检据此识别拒绝来源。
	AdmissionPolicyPrefix string
	// RequireWebAuthnForH 对应合规配置。
	RequireWebAuthnForH bool
	MaxConcurrent       int
	// SafetyInterval 是熔断开关、时钟偏差、策略重新加载与心跳的周期；PullWait 是长轮询的等待时长。
	SafetyInterval time.Duration
	// SelfCheckInterval 是周期性准入自检的间隔（ADR 0024）。启动时、启用的准入策略集合变化时、上一次自检失败之后的每个安全检查周期，
	// 以及每次执行之前，自检都会立即进行，不受这个间隔限制。
	SelfCheckInterval time.Duration
	PullWait          time.Duration
	PushInterval      time.Duration
	FlushInterval     time.Duration
	// MaxClockSkew 超过时只提议（DESIGN §9.4：5 秒）。
	MaxClockSkew time.Duration
	// ThrottleHold 是收到 429 之后保持只提议的时长。
	ThrottleHold time.Duration
	// LeaseDuration 等选主参数。
	LeaseDuration, RenewDeadline, RetryPeriod time.Duration
	// Fault 在执行路径的关键点被调用（不变量 8 的故障注入测试在这里结束进程）；生产中为 nil。
	// 取值：executing_written（executing 已写入、副作用之前）、side_effect_done（副作用之后、verifying 之前）、
	// verifying_written（verifying 已写入）。
	Fault func(point, executionID string)
}

// Deps 是引擎的依赖。
type Deps struct {
	Kube      *kube.Client
	Hub       *tunnel.Client
	Catalog   *catalog.Catalog
	Executors map[string]executor.Executor
	Audit     *audit.Chain
	Verify    *verify.Client
	Metrics   *metrics.Metrics
	// Clock 用于审批与提议的时效、校验时间窗的等待；测试用可推进的时钟。
	Clock clock.Clock
	// GitHub 是 gitops_pr 使用的 GitHub App；没有配置时为 nil。
	GitHub *github.App
}

// Engine 是 gateway 的主实例逻辑。
type Engine struct {
	cfg   Config
	d     Deps
	store *execution.Store

	mu          sync.Mutex
	policy      *policy.Policy
	keys        *assertion.Keyring
	restoredAt  time.Time
	conditions  map[string]tunnel.Condition
	proposeOnly bool
	softPaused  bool
	leader      bool
	lastSkew    time.Duration
	selfCheck   selfCheckResult

	q        *queue
	running  sync.WaitGroup
	execMu   sync.Map // 执行 ID → *sync.Mutex
	wake     chan struct{}
	stopping chan struct{}
}

// New 校验设置并创建引擎。策略与公钥在启动时必须能加载。
func New(cfg Config, d Deps) (*Engine, error) {
	if cfg.Cluster == "" || cfg.Namespace == "" || cfg.Identity == "" || cfg.LeaseName == "" || cfg.AdmissionPolicyPrefix == "" {
		return nil, errors.New("engine: cluster, namespace, identity, lease name and admission policy prefix are required")
	}
	if cfg.MaxConcurrent <= 0 || cfg.SafetyInterval <= 0 || cfg.SelfCheckInterval <= 0 || cfg.PullWait < 0 || cfg.PushInterval <= 0 || cfg.FlushInterval <= 0 ||
		cfg.MaxClockSkew <= 0 || cfg.LeaseDuration <= 0 || cfg.RenewDeadline <= 0 || cfg.RetryPeriod <= 0 {
		return nil, errors.New("engine: intervals and limits must be positive")
	}
	e := &Engine{cfg: cfg, d: d, store: execution.NewStore(d.Kube.Dyn, cfg.Namespace), conditions: map[string]tunnel.Condition{},
		proposeOnly: true, q: newQueue(), wake: make(chan struct{}, 1), stopping: make(chan struct{})}
	if err := e.reloadConfig(); err != nil {
		return nil, err
	}
	return e, nil
}

// reloadConfig 重新读取策略与公钥；失败时保留上一次的内容并把条件 PolicyLoaded 置为 False。
func (e *Engine) reloadConfig() error {
	pol, err := policy.Load(e.cfg.PolicyFile, e.d.Catalog)
	if err == nil && pol.Cluster != e.cfg.Cluster {
		err = fmt.Errorf("policy is for cluster %s, gateway runs in %s", pol.Cluster, e.cfg.Cluster)
	}
	var keys *assertion.Keyring
	if err == nil {
		keys, err = assertion.LoadKeyring(e.cfg.KeysFile)
	}
	if err != nil {
		e.setCondition(metrics.ConditionPolicyLoaded, false, "load_failed", err.Error())
		return err
	}
	e.mu.Lock()
	e.policy, e.keys = pol, keys
	e.mu.Unlock()
	e.setCondition(metrics.ConditionPolicyLoaded, true, "loaded", "")
	return nil
}

func (e *Engine) currentPolicy() *policy.Policy {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.policy
}

func (e *Engine) currentKeys() *assertion.Keyring {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.keys
}

// Policy 返回当前策略（执行器使用）。
func (e *Engine) Policy() *policy.Policy { return e.currentPolicy() }

func (e *Engine) now() time.Time { return e.d.Clock.Now().UTC() }

// observeHub 记录中心响应中的恢复标记（取最新的一个）。
func (e *Engine) observeHub(c tunnel.HubClock) {
	if c.RestoredAt == nil {
		return
	}
	t, err := assertion.ParseTime(*c.RestoredAt)
	if err != nil {
		slog.Error("hub restored_at", "value", *c.RestoredAt, "err", err)
		return
	}
	e.mu.Lock()
	if t.After(e.restoredAt) {
		e.restoredAt = t
	}
	e.mu.Unlock()
}

func (e *Engine) restoreMarker() time.Time {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.restoredAt
}

// ProposeOnly 表示 gateway 当前不认领新的执行。
func (e *Engine) ProposeOnly() bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.proposeOnly || !e.leader
}

// Conditions 返回当前的状态条件。
func (e *Engine) Conditions() []tunnel.Condition {
	e.mu.Lock()
	defer e.mu.Unlock()
	var out []tunnel.Condition
	for _, t := range []string{metrics.ConditionAdmissionSelfCheck, metrics.ConditionFreeze, metrics.ConditionAuditSink,
		metrics.ConditionClockSkew, metrics.ConditionLeader, metrics.ConditionApiserverThrottled, metrics.ConditionPolicyLoaded,
		metrics.ConditionGitHubBranchProtection} {
		if c, ok := e.conditions[t]; ok {
			out = append(out, c)
		}
	}
	return out
}

// setCondition 记录条件；status 为 true 表示该项正常（Freeze、ApiserverThrottled 的 True 表示处于冻结、限流）。
func (e *Engine) setCondition(typ string, ok bool, reason, msg string) {
	status := "True"
	if !ok {
		status = "False"
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	prev, had := e.conditions[typ]
	since := assertion.FormatTime(e.now())
	if had && prev.Status == status {
		since = prev.Since
	}
	e.conditions[typ] = tunnel.Condition{Type: typ, Status: status, Reason: reason, Message: msg, Since: since}
	v := 0.0
	if ok {
		v = 1
	}
	e.d.Metrics.Condition.WithLabelValues("gateway", typ).Set(v)
}

// Wake 让调度循环立即运行一轮。
func (e *Engine) Wake() {
	select {
	case e.wake <- struct{}{}:
	default:
	}
}

// Run 参与选主；成为主实例后运行各个循环，失去主实例身份时返回错误（进程退出后由 Kubernetes 重启）。
// ctx 结束（SIGTERM）时停止认领新工单，等进行中的动作完成后返回 nil。
func (e *Engine) Run(ctx context.Context) error {
	lock := &resourcelock.LeaseLock{
		LeaseMeta:  metav1.ObjectMeta{Name: e.cfg.LeaseName, Namespace: e.cfg.Namespace},
		Client:     e.d.Kube.Core.CoordinationV1(),
		LockConfig: resourcelock.ResourceLockConfig{Identity: e.cfg.Identity},
	}
	// 执行与校验使用独立的 context：收到 SIGTERM 后进行中的动作继续完成
	work, cancelWork := context.WithCancel(context.Background())
	defer cancelWork()
	lost := make(chan struct{})
	var runErr error
	le, err := leaderelection.NewLeaderElector(leaderelection.LeaderElectionConfig{
		Lock: lock, LeaseDuration: e.cfg.LeaseDuration, RenewDeadline: e.cfg.RenewDeadline, RetryPeriod: e.cfg.RetryPeriod,
		ReleaseOnCancel: true, Name: e.cfg.LeaseName,
		Callbacks: leaderelection.LeaderCallbacks{
			OnStartedLeading: func(lctx context.Context) { runErr = e.lead(ctx, work) },
			OnStoppedLeading: func() { close(lost) },
		},
	})
	if err != nil {
		return err
	}
	le.Run(ctx)
	select {
	case <-lost:
	default:
	}
	if ctx.Err() != nil {
		return runErr
	}
	return fmt.Errorf("lost the %s lease: %w", e.cfg.LeaseName, errors.Join(runErr, errors.New("leadership lost")))
}

// IsLeaseHolder 读取 Lease 并判断本实例是否是持有者（执行前的隔离检查）。
func (e *Engine) IsLeaseHolder(ctx context.Context) (bool, error) {
	l, err := e.d.Kube.Core.CoordinationV1().Leases(e.cfg.Namespace).Get(ctx, e.cfg.LeaseName, metav1.GetOptions{})
	if err != nil {
		return false, err
	}
	return holder(l) == e.cfg.Identity, nil
}

func holder(l *coordinationv1.Lease) string {
	if l.Spec.HolderIdentity == nil {
		return ""
	}
	return *l.Spec.HolderIdentity
}

// lead 是主实例的全部工作：恢复、各个循环；ctx 结束时停止认领，等待进行中的执行。
func (e *Engine) lead(ctx, work context.Context) error {
	e.mu.Lock()
	e.leader = true
	e.mu.Unlock()
	e.setCondition(metrics.ConditionLeader, true, "leading", e.cfg.Identity)
	if err := e.recover(work); err != nil {
		return fmt.Errorf("recover executions: %w", err)
	}
	e.safetyCheck(ctx)
	var loops sync.WaitGroup
	loop := func(f func()) {
		loops.Add(1)
		go func() { defer loops.Done(); f() }()
	}
	loop(func() { e.every(ctx, e.cfg.SafetyInterval, func() { e.safetyCheck(ctx) }) })
	loop(func() { e.pullLoop(ctx) })
	loop(func() { e.dispatchLoop(ctx, work) })
	// 推送与审计汇写入在停机时继续，直到进行中的执行结束
	pushCtx, stopPush := context.WithCancel(work)
	var bg sync.WaitGroup
	bg.Add(2)
	go func() { defer bg.Done(); e.every(pushCtx, e.cfg.PushInterval, func() { e.push(pushCtx) }) }()
	go func() { defer bg.Done(); e.every(pushCtx, e.cfg.FlushInterval, func() { e.flush(pushCtx) }) }()
	<-ctx.Done()
	close(e.stopping)
	loops.Wait()
	e.running.Wait()
	e.flush(work)
	e.push(work)
	stopPush()
	bg.Wait()
	return nil
}

// every 以墙上时钟周期运行 f；Deps.Clock 只用于时效判断与校验时间窗。
func (e *Engine) every(ctx context.Context, d time.Duration, f func()) {
	t := time.NewTicker(d)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			f()
		}
	}
}

func (e *Engine) flush(ctx context.Context) {
	err := e.d.Audit.Flush(ctx)
	e.d.Metrics.AuditExportLag.WithLabelValues("execution").Set(e.d.Audit.Lag().Seconds())
	if err != nil {
		slog.Error("audit flush", "err", err)
	}
}

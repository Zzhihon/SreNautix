// Package gwtest 为 gateway 的集成测试与不变量测试搭建完整的运行环境：envtest 的 kube-apiserver（带审计日志）、
// 生成的准入策略与 RBAC、中心（工单协议）、MinIO 审计汇、Prometheus，以及以 gateway ServiceAccount 身份运行的引擎。
package gwtest

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
	clientcmdapi "k8s.io/client-go/tools/clientcmd/api"
	"k8s.io/utils/clock"
	clocktesting "k8s.io/utils/clock/testing"
	"sigs.k8s.io/yaml"

	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/admission"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/audit"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/catalog"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/engine"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/execution"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/executor"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/kube"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/metrics"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/policy"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/verify"
	"github.com/Zzhihon/SreNautix/internal/spoke/testenv"
	"github.com/Zzhihon/SreNautix/internal/spoke/tunnel"
)

// 测试环境中的固定名称。
const (
	Cluster   = "test-cluster"
	AppNS     = "payments"
	Prefix    = "srenautix"
	LeaseName = "srenautix-gateway"
	Token     = "spoke-token"
	Approver  = "oidc:alice@example.org"
	Bucket    = "srenautix-audit"
)

// Env 是一套运行环境；Start 启动引擎。
type Env struct {
	T          testing.TB
	Kube       *testenv.Env
	F          *testenv.Fixtures
	Hub        *testenv.Hub
	MinIO      *testenv.MinIO
	Prometheus *testenv.Prometheus
	Approver   *testenv.Approver
	Catalog    *catalog.Catalog
	Admission  *admission.Output
	Dir        string
	PolicyFile string
	KeysFile   string
	TokenFile  string
	SigningKey ed25519.PrivateKey
	Clock      *clocktesting.FakeClock
	Actions    []string
}

// DefaultPolicy 是测试用的 gateway 策略：启用常用动作，payments 中的 pod_restart、workload_scale 允许自动执行。
func DefaultPolicy(actions []string) string {
	var b strings.Builder
	b.WriteString("version: 1\ncluster: " + Cluster + "\nmax_auto_executions_per_hour: 3\n")
	b.WriteString("approvers:\n  - {principal: \"" + Approver + "\", namespaces: [\"*\"], max_tier: H}\n")
	b.WriteString("  - {principal: \"oidc:bob@example.org\", namespaces: [ledger], max_tier: L}\n")
	b.WriteString("actions:\n")
	for _, a := range actions {
		switch a {
		case "node_cordon", "node_uncordon", "gitops_pr":
			b.WriteString("  - id: " + a + "\n")
		case "pod_restart", "workload_scale":
			b.WriteString("  - id: " + a + "\n    namespaces: [" + AppNS + ", ledger]\n    auto_execution: {rules: [stuck-pod], namespaces: [" + AppNS + "]}\n")
		default:
			b.WriteString("  - id: " + a + "\n    namespaces: [" + AppNS + ", ledger]\n")
		}
	}
	return b.String()
}

// DefaultActions 是测试默认启用的动作。
var DefaultActions = []string{"node_cordon", "node_uncordon", "workload_scale", "pod_restart", "workload_rolling_restart", "rollout_pause"}

// New 启动 kube-apiserver、中心、MinIO 与 Prometheus，安装生成的准入策略与 RBAC，写入策略与公钥文件。
func New(t testing.TB, actions []string) *Env {
	t.Helper()
	kenv := testenv.Start(t, testenv.Options{Audit: true, Namespaces: []string{AppNS, "ledger"}})
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	out, err := admission.Generate(cat, admission.Options{Username: testenv.GatewayUser, Prefix: Prefix})
	if err != nil {
		t.Fatal(err)
	}
	docs, err := admission.Manifests(out, admission.Options{Username: testenv.GatewayUser, Prefix: Prefix}, testenv.Namespace, "srenautix-gateway", actions, "false")
	if err != nil {
		t.Fatal(err)
	}
	for _, d := range docs {
		b, err := yaml.Marshal(d)
		if err != nil {
			t.Fatal(err)
		}
		kenv.Apply(t, b)
	}
	m := testenv.StartMinIO(t)
	m.LockedBucket(t, Bucket)
	e := &Env{T: t, Kube: kenv, F: kenv.Fixtures(t), Hub: testenv.StartHub(t, Cluster, Token), MinIO: m,
		Prometheus: testenv.StartPrometheus(t), Approver: testenv.NewApprover("service-test"), Catalog: cat, Admission: out,
		Dir: testenv.Scratch(t, "gateway"), Actions: actions, Clock: clocktesting.NewFakeClock(time.Now().UTC())}
	seed := sha256.Sum256([]byte("gwtest audit key"))
	e.SigningKey = ed25519.NewKeyFromSeed(seed[:])
	e.PolicyFile = e.write("policy.yaml", []byte(DefaultPolicy(actions)))
	e.KeysFile = e.write("approver-keys.json", e.Approver.KeysFile())
	e.TokenFile = e.write("hub-token", []byte(Token))
	e.WaitPoliciesLoaded()
	return e
}

func (e *Env) write(name string, b []byte) string {
	p := filepath.Join(e.Dir, name)
	if err := os.WriteFile(p, b, 0o600); err != nil {
		e.T.Fatal(err)
	}
	return p
}

// WritePolicy 替换策略文件（gateway 每轮重新读取）。
func (e *Env) WritePolicy(doc string) { e.write("policy.yaml", []byte(doc)) }

// WaitPoliciesLoaded 等 apiserver 加载全部准入策略与 Binding。
func (e *Env) WaitPoliciesLoaded() {
	gw, err := kube.New(e.Kube.Gateway(), 15*time.Second)
	if err != nil {
		e.T.Fatal(err)
	}
	store := execution.NewStore(gw.Dyn, testenv.Namespace)
	for _, s := range e.Admission.ProbeNames(e.Actions) {
		name := Prefix + "-gateway-" + s
		testenv.Eventually(e.T, 30*time.Second, "policy "+name+" enforced", func() (bool, string) {
			err := store.DryRunCreate(context.Background(), admission.ProbeObject(testenv.Namespace, s))
			return err != nil && strings.Contains(err.Error(), "ValidatingAdmissionPolicy '"+name+"'"), errString(err)
		})
	}
}

func errString(err error) string {
	if err == nil {
		return "allowed"
	}
	return err.Error()
}

// Options 调整引擎的设置。
type Options struct {
	// Identity 是 Lease 身份（Pod 名），默认 gateway-0。
	Identity string
	// RealClock 为 true 时引擎使用真实时钟（子进程中运行时）。
	RealClock bool
	// StagingDir 是审计暂存目录，默认在 Dir 下。
	StagingDir string
	Fault      func(point, executionID string)
}

// Gateway 是一个运行中的引擎。
type Gateway struct {
	Engine  *engine.Engine
	Audit   *audit.Chain
	Metrics *metrics.Metrics
	cancel  context.CancelFunc
	done    chan error
	once    sync.Once
}

// Build 用环境中的依赖构造引擎（不启动）。
func (e *Env) Build(o Options) (*engine.Engine, *audit.Chain, *metrics.Metrics) {
	return Build(e.T, e.Kube.Gateway(), Config{HubURL: e.Hub.Server.URL, TokenFile: e.TokenFile, MinIOEndpoint: e.MinIO.Endpoint(),
		MinIOAccess: e.MinIO.AccessKey, MinIOSecret: e.MinIO.SecretKey, PrometheusURL: e.Prometheus.URL, PolicyFile: e.PolicyFile,
		KeysFile: e.KeysFile, StagingDir: firstNonEmpty(o.StagingDir, filepath.Join(e.Dir, "staging")), SigningKey: e.SigningKey,
		Identity: firstNonEmpty(o.Identity, "gateway-0")}, clockFor(e, o), o.Fault)
}

func clockFor(e *Env, o Options) clock.Clock {
	if o.RealClock {
		return clock.RealClock{}
	}
	return e.Clock
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// Config 是引擎在测试中的连接设置（子进程从 JSON 读取同一结构）。
type Config struct {
	HubURL        string `json:"hubURL"`
	TokenFile     string `json:"tokenFile"`
	MinIOEndpoint string `json:"minioEndpoint"`
	MinIOAccess   string `json:"minioAccess"`
	MinIOSecret   string `json:"minioSecret"`
	PrometheusURL string `json:"prometheusURL"`
	PolicyFile    string `json:"policyFile"`
	KeysFile      string `json:"keysFile"`
	StagingDir    string `json:"stagingDir"`
	SigningKey    []byte `json:"signingKey"`
	Identity      string `json:"identity"`
	Kubeconfig    string `json:"kubeconfig"`
}

// Build 构造引擎及其依赖。
func Build(t testing.TB, rc *rest.Config, c Config, clk clock.Clock, fault func(point, executionID string)) (*engine.Engine, *audit.Chain, *metrics.Metrics) {
	t.Helper()
	ctx := context.Background()
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	kc, err := kube.New(rc, 15*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	hub, err := tunnel.New(tunnel.Config{BaseURL: c.HubURL, Cluster: Cluster, TokenFile: c.TokenFile, Timeout: 10 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	s3, err := minio.New(c.MinIOEndpoint, &minio.Options{Creds: credentialsFor(c.MinIOAccess, c.MinIOSecret)})
	if err != nil {
		t.Fatal(err)
	}
	chain, err := audit.Open(ctx, audit.Options{Cluster: Cluster, Dir: c.StagingDir, CheckpointEvery: 10,
		Signer: audit.Signer{KeyID: "gateway-test", Key: ed25519.PrivateKey(c.SigningKey)},
		Sink:   audit.SinkConfig{Client: s3, Bucket: Bucket, ObjectLock: true, Mode: minio.Governance, RetentionDays: 1}})
	if err != nil {
		t.Fatal(err)
	}
	vc, err := verify.New(c.PrometheusURL, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	m := metrics.New("test")
	var eng *engine.Engine
	execs, err := executor.Registry(&executor.Deps{Kube: kc, Catalog: cat, Policy: func() *policy.Policy { return eng.Policy() },
		Now: func() time.Time { return clk.Now().UTC() }, Poll: 100 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	eng, err = engine.New(engine.Config{
		Cluster: Cluster, Namespace: testenv.Namespace, Identity: c.Identity, NodeName: "gateway-node", LeaseName: LeaseName, Version: "test",
		PolicyFile: c.PolicyFile, KeysFile: c.KeysFile, AdmissionPolicyPrefix: Prefix, MaxConcurrent: 4,
		SafetyInterval: time.Second, PullWait: time.Second, PushInterval: 300 * time.Millisecond, FlushInterval: 500 * time.Millisecond,
		MaxClockSkew: 5 * time.Second, ThrottleHold: time.Minute,
		LeaseDuration: 4 * time.Second, RenewDeadline: 3 * time.Second, RetryPeriod: 500 * time.Millisecond, Fault: fault,
	}, engine.Deps{Kube: kc, Hub: hub, Catalog: cat, Executors: execs, Audit: chain, Verify: vc, Metrics: m, Clock: clk})
	if err != nil {
		t.Fatal(err)
	}
	return eng, chain, m
}

// Start 启动引擎；测试结束时发送停机并等待返回。
func (e *Env) Start(o Options) *Gateway {
	e.T.Helper()
	eng, chain, m := e.Build(o)
	ctx, cancel := context.WithCancel(context.Background())
	g := &Gateway{Engine: eng, Audit: chain, Metrics: m, cancel: cancel, done: make(chan error, 1)}
	go func() { g.done <- eng.Run(ctx) }()
	e.T.Cleanup(func() { g.Stop(e.T) })
	testenv.Eventually(e.T, 30*time.Second, "gateway leads and is not proposal-only", func() (bool, string) {
		return !eng.ProposeOnly(), conditionsText(eng)
	})
	return g
}

func conditionsText(eng *engine.Engine) string {
	b, _ := json.Marshal(eng.Conditions())
	return string(b)
}

// Stop 发送停机，等待进行中的执行完成。
func (g *Gateway) Stop(t testing.TB) {
	g.once.Do(func() {
		g.cancel()
		select {
		case err := <-g.done:
			if err != nil {
				t.Errorf("gateway run: %v", err)
			}
		case <-time.After(60 * time.Second):
			t.Errorf("gateway did not stop within 60s")
		}
		_ = g.Audit.Close()
	})
}

// Offer 把工单交给中心，返回执行 ID。
func (e *Env) Offer(tk tunnel.Ticket) string {
	e.Hub.Offer(tk)
	return testenv.ExecutionID(e.T, tk)
}

// Request 返回一个基本的审批请求（服务签名，Approver 审批）。
func (e *Env) Request(action string, params map[string]any, target tunnel.TargetRef, level, tier string) testenv.Request {
	return testenv.Request{Cluster: Cluster, Action: action, Params: params, Target: target, Level: level, Tier: tier,
		Principal: Approver, Channel: "console"}
}

// Ticket 签发工单。
func (e *Env) Ticket(r testenv.Request) tunnel.Ticket {
	return e.Approver.Ticket(e.T, e.Clock.Now(), r)
}

// WaitPhase 等到中心收到该提议某个阶段的事件。
func (e *Env) WaitPhase(proposalID, phase string, timeout time.Duration) {
	e.T.Helper()
	testenv.Eventually(e.T, timeout, proposalID+" reaches "+phase, func() (bool, string) {
		return e.Hub.HasPhase(proposalID, phase), e.Hub.Describe(proposalID)
	})
}

// Execution 读取 ActionExecution。
func (e *Env) Execution(id string) *execution.ActionExecution {
	e.T.Helper()
	x, err := execution.NewStore(e.Kube.Dyn, testenv.Namespace).Get(context.Background(), id)
	if err != nil {
		e.T.Fatal(err)
	}
	return x
}

// WaitWaiters 等引擎在时钟上等待（进入校验时间窗），然后推进时钟 d。
func (e *Env) Advance(d time.Duration) {
	e.T.Helper()
	testenv.Eventually(e.T, 30*time.Second, "gateway waits on the clock", func() (bool, string) { return e.Clock.HasWaiters(), "" })
	e.Clock.Step(d)
}

// Kubeconfig 把以 gateway 身份访问 apiserver 的配置写成 kubeconfig 文件（子进程使用）。
func (e *Env) Kubeconfig() string {
	c := e.Kube.Gateway()
	cfg := clientcmdapi.NewConfig()
	cfg.Clusters["envtest"] = &clientcmdapi.Cluster{Server: c.Host, CertificateAuthorityData: c.CAData}
	cfg.AuthInfos["admin"] = &clientcmdapi.AuthInfo{ClientCertificateData: c.CertData, ClientKeyData: c.KeyData, Token: c.BearerToken,
		Impersonate: c.Impersonate.UserName, ImpersonateGroups: c.Impersonate.Groups}
	cfg.Contexts["envtest"] = &clientcmdapi.Context{Cluster: "envtest", AuthInfo: "admin"}
	cfg.CurrentContext = "envtest"
	path := filepath.Join(e.Dir, "kubeconfig")
	if err := clientcmd.WriteToFile(*cfg, path); err != nil {
		e.T.Fatal(err)
	}
	return path
}

func credentialsFor(access, secret string) *credentials.Credentials {
	return credentials.NewStaticV4(access, secret, "")
}

// ReadSinkRecords 读取审计汇中的全部记录。
func (e *Env) ReadSinkRecords(chain *audit.Chain) []audit.Record {
	e.T.Helper()
	recs, err := chain.ReadSink(context.Background())
	if err != nil {
		e.T.Fatal(err)
	}
	return recs
}

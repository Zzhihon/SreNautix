// Package gateway 是分支的写角色（DESIGN §9.4）：拉取已批准的工单，校验断言、策略、绑定与预检，
// 先写 ActionExecution 再执行，按声明的条件校验，必要时撤销，并维护执行审计链。
package gateway

import (
	"context"
	"crypto/ed25519"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"k8s.io/client-go/rest"
	"k8s.io/utils/clock"
	"sigs.k8s.io/yaml"

	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/audit"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/catalog"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/engine"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/executor"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/github"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/kube"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/metrics"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/policy"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/verify"
	"github.com/Zzhihon/SreNautix/internal/spoke/tunnel"
)

// FileConfig 是 gateway 的 /etc/srenautix/config.yaml（chart 渲染，格式见 docs/gateway/README.md）。
// 未知字段使加载失败。
type FileConfig struct {
	ClusterID string `json:"cluster_id"`
	Profile   string `json:"profile"`
	Namespace string `json:"namespace"`
	Listen    struct {
		Metrics string `json:"metrics"`
		Probes  string `json:"probes"`
	} `json:"listen"`
	Hub struct {
		URL       string `json:"url"`
		TokenFile string `json:"token_file"`
		CAFile    string `json:"ca_file"`
	} `json:"hub"`
	Audit struct {
		CheckpointKeyFile string `json:"checkpoint_key_file"`
		CheckpointKeyID   string `json:"checkpoint_key_id"`
		StagingDir        string `json:"staging_dir"`
		S3                struct {
			Endpoint       string `json:"endpoint"`
			Region         string `json:"region"`
			Bucket         string `json:"bucket"`
			AccessKeyFile  string `json:"access_key_file"`
			SecretKeyFile  string `json:"secret_key_file"`
			ForcePathStyle bool   `json:"force_path_style"`
		} `json:"s3"`
		ObjectLock struct {
			Enabled       bool   `json:"enabled"`
			Mode          string `json:"mode"`
			RetentionDays int    `json:"retention_days"`
		} `json:"object_lock"`
	} `json:"audit"`
	Gateway struct {
		LeaseName             string `json:"lease_name"`
		PolicyFile            string `json:"policy_file"`
		ApproverKeysFile      string `json:"approver_keys_file"`
		AdmissionPolicyPrefix string `json:"admission_policy_prefix"`
		MetricsURL            string `json:"metrics_url"`
		GitHubAppDir          string `json:"github_app_dir"`
		GitHubAPI             string `json:"github_api"`
		MaxConcurrent         int    `json:"max_concurrent"`
		// AdmissionSelfCheckInterval 是周期性准入自检的间隔（Go duration，1s 到 1h，默认 1m，ADR 0024）
		AdmissionSelfCheckInterval string `json:"admission_self_check_interval"`
		// SelfCheckEvery 是解析后的 AdmissionSelfCheckInterval
		SelfCheckEvery time.Duration `json:"-"`
	} `json:"gateway"`
}

// LoadConfig 读取并校验配置文件；缺少任何必填项时失败。
func LoadConfig(path string) (*FileConfig, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var fc FileConfig
	if err := yaml.UnmarshalStrict(raw, &fc); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	if fc.Audit.CheckpointKeyID == "" {
		fc.Audit.CheckpointKeyID = "gateway"
	}
	if fc.Gateway.MaxConcurrent == 0 {
		fc.Gateway.MaxConcurrent = 4
	}
	if fc.Gateway.GitHubAPI == "" {
		fc.Gateway.GitHubAPI = "https://api.github.com"
	}
	var missing []string
	for k, v := range map[string]string{
		"cluster_id": fc.ClusterID, "namespace": fc.Namespace, "listen.metrics": fc.Listen.Metrics, "listen.probes": fc.Listen.Probes,
		"hub.url": fc.Hub.URL, "hub.token_file": fc.Hub.TokenFile, "audit.checkpoint_key_file": fc.Audit.CheckpointKeyFile,
		"audit.staging_dir": fc.Audit.StagingDir, "audit.s3.endpoint": fc.Audit.S3.Endpoint, "audit.s3.bucket": fc.Audit.S3.Bucket,
		"audit.s3.access_key_file": fc.Audit.S3.AccessKeyFile, "audit.s3.secret_key_file": fc.Audit.S3.SecretKeyFile,
		"gateway.lease_name": fc.Gateway.LeaseName, "gateway.policy_file": fc.Gateway.PolicyFile,
		"gateway.approver_keys_file": fc.Gateway.ApproverKeysFile, "gateway.admission_policy_prefix": fc.Gateway.AdmissionPolicyPrefix,
		"gateway.metrics_url": fc.Gateway.MetricsURL,
	} {
		if v == "" {
			missing = append(missing, k)
		}
	}
	if len(missing) > 0 {
		sort.Strings(missing)
		return nil, fmt.Errorf("%s is missing %s", path, strings.Join(missing, ", "))
	}
	if m := fc.Audit.ObjectLock.Mode; fc.Audit.ObjectLock.Enabled && m != "GOVERNANCE" && m != "COMPLIANCE" {
		return nil, fmt.Errorf("%s: audit.object_lock.mode must be GOVERNANCE or COMPLIANCE, got %q", path, m)
	}
	every := fc.Gateway.AdmissionSelfCheckInterval
	if every == "" {
		every = "1m"
	}
	d, err := time.ParseDuration(every)
	if err != nil || d < time.Second || d > time.Hour {
		return nil, fmt.Errorf("%s: gateway.admission_self_check_interval must be a duration between 1s and 1h, got %q", path, every)
	}
	fc.Gateway.SelfCheckEvery = d
	return &fc, nil
}

// LoadSigningKey 读取 PKCS#8 PEM 格式的 Ed25519 私钥（openssl genpkey -algorithm ed25519）。
func LoadSigningKey(path string) (ed25519.PrivateKey, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	block, _ := pem.Decode(raw)
	if block == nil {
		return nil, fmt.Errorf("%s is not PEM", path)
	}
	k, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	ek, ok := k.(ed25519.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("%s is not an Ed25519 key", path)
	}
	return ek, nil
}

func readSecret(path string) (string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(b)), nil
}

// Run 运行 gateway 角色。
func Run(ctx context.Context, version string, args []string) error {
	fs := flag.NewFlagSet("gateway", flag.ContinueOnError)
	configPath := fs.String("config", "/etc/srenautix/config.yaml", "configuration file")
	if err := fs.Parse(args); err != nil {
		return err
	}
	fc, err := LoadConfig(*configPath)
	if err != nil {
		return err
	}
	g := fc.Gateway
	podName, nodeName := os.Getenv("POD_NAME"), os.Getenv("NODE_NAME")
	if podName == "" || nodeName == "" {
		return errors.New("POD_NAME and NODE_NAME must be set from the downward API")
	}
	m := metrics.New(version)
	cat, err := catalog.Load()
	if err != nil {
		return err
	}
	rc, err := rest.InClusterConfig()
	if err != nil {
		return err
	}
	kc, err := kube.New(rc, 15*time.Second)
	if err != nil {
		return err
	}
	hub, err := tunnel.New(tunnel.Config{BaseURL: fc.Hub.URL, Cluster: fc.ClusterID, TokenFile: fc.Hub.TokenFile, CAFile: fc.Hub.CAFile, Timeout: 15 * time.Second})
	if err != nil {
		return err
	}
	access, err := readSecret(fc.Audit.S3.AccessKeyFile)
	if err != nil {
		return err
	}
	secret, err := readSecret(fc.Audit.S3.SecretKeyFile)
	if err != nil {
		return err
	}
	endpoint := strings.TrimPrefix(strings.TrimPrefix(fc.Audit.S3.Endpoint, "https://"), "http://")
	lookup := minio.BucketLookupDNS
	if fc.Audit.S3.ForcePathStyle {
		lookup = minio.BucketLookupPath
	}
	s3, err := minio.New(endpoint, &minio.Options{Creds: credentials.NewStaticV4(access, secret, ""),
		Secure: strings.HasPrefix(fc.Audit.S3.Endpoint, "https://"), Region: fc.Audit.S3.Region, BucketLookup: lookup})
	if err != nil {
		return err
	}
	key, err := LoadSigningKey(fc.Audit.CheckpointKeyFile)
	if err != nil {
		return err
	}
	mode := minio.Governance
	if fc.Audit.ObjectLock.Mode == "COMPLIANCE" {
		mode = minio.Compliance
	}
	chain, err := audit.Open(ctx, audit.Options{Cluster: fc.ClusterID, Dir: fc.Audit.StagingDir, CheckpointEvery: 100,
		Signer: audit.Signer{KeyID: fc.Audit.CheckpointKeyID, Key: key},
		Sink:   audit.SinkConfig{Client: s3, Bucket: fc.Audit.S3.Bucket, ObjectLock: fc.Audit.ObjectLock.Enabled, Mode: mode, RetentionDays: fc.Audit.ObjectLock.RetentionDays}})
	if err != nil {
		return err
	}
	defer chain.Close()
	vc, err := verify.New(g.MetricsURL, 10*time.Second)
	if err != nil {
		return err
	}
	var app *github.App
	if g.GitHubAppDir != "" {
		if app, err = github.Load(g.GitHubAppDir, g.GitHubAPI, 15*time.Second); err != nil {
			return err
		}
	}
	var eng *engine.Engine
	deps := &executor.Deps{Kube: kc, Catalog: cat, Policy: func() *policy.Policy { return eng.Policy() }, GitHub: app,
		MainWatchdog: func(r string) (bool, string) { return eng.MainWatchdog(r) }, Metrics: m,
		Now: func() time.Time { return time.Now().UTC() }, Poll: 5 * time.Second}
	execs, err := executor.Registry(deps)
	if err != nil {
		return err
	}
	eng, err = engine.New(engine.Config{
		Cluster: fc.ClusterID, Namespace: fc.Namespace, Identity: podName, NodeName: nodeName, LeaseName: g.LeaseName, Version: version,
		PolicyFile: g.PolicyFile, KeysFile: g.ApproverKeysFile, AdmissionPolicyPrefix: g.AdmissionPolicyPrefix,
		RequireWebAuthnForH: fc.Profile == "compliance", MaxConcurrent: g.MaxConcurrent,
		SafetyInterval: 15 * time.Second, SelfCheckInterval: g.SelfCheckEvery, PullWait: 30 * time.Second, PushInterval: 2 * time.Second, FlushInterval: 5 * time.Second,
		MaxClockSkew: 5 * time.Second, ThrottleHold: time.Minute,
		LeaseDuration: 15 * time.Second, RenewDeadline: 10 * time.Second, RetryPeriod: 2 * time.Second,
	}, engine.Deps{Kube: kc, Hub: hub, Catalog: cat, Executors: execs, Audit: chain, Verify: vc, Metrics: m, Clock: clock.RealClock{}, GitHub: app})
	if err != nil {
		return err
	}
	serve := func(addr string, h http.Handler) *http.Server {
		s := &http.Server{Addr: addr, Handler: h, ReadHeaderTimeout: 5 * time.Second}
		go func() {
			if err := s.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
				slog.Error("listen", "addr", addr, "err", err)
				os.Exit(1)
			}
		}()
		return s
	}
	ms := serve(fc.Listen.Metrics, promhttp.HandlerFor(m.Registry, promhttp.HandlerOpts{}))
	probes := http.NewServeMux()
	ok := func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) }
	probes.HandleFunc("/healthz", ok)
	probes.HandleFunc("/readyz", ok)
	ps := serve(fc.Listen.Probes, probes)
	defer ms.Close()
	defer ps.Close()
	return eng.Run(ctx)
}

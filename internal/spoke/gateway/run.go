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
	"path/filepath"
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

// FileConfig 是 /etc/srenautix/config.yaml 中 gateway 使用的部分（chart 渲染）。
type FileConfig struct {
	Role      string `json:"role"`
	Profile   string `json:"profile"`
	ClusterID string `json:"clusterId"`
	Release   struct {
		Name      string `json:"name"`
		Namespace string `json:"namespace"`
	} `json:"release"`
	Listen struct {
		Metrics string `json:"metrics"`
		Probes  string `json:"probes"`
	} `json:"listen"`
	SecretsDir string `json:"secretsDir"`
	Hub        struct {
		URL       string `json:"url"`
		TokenFile string `json:"tokenFile"`
		CAFile    string `json:"caFile"`
	} `json:"hub"`
	Audit struct {
		Sink       string `json:"sink"`
		Bucket     string `json:"bucket"`
		ObjectLock struct {
			Enabled       bool   `json:"enabled"`
			Mode          string `json:"mode"`
			RetentionDays int    `json:"retentionDays"`
		} `json:"objectLock"`
		Endpoint       string `json:"endpoint"`
		Region         string `json:"region"`
		CredentialsDir string `json:"credentialsDir"`
	} `json:"audit"`
	Gateway struct {
		LeaseName             string `json:"leaseName"`
		AuditStagingDir       string `json:"auditStagingDir"`
		PolicyFile            string `json:"policyFile"`
		ApproverKeysFile      string `json:"approverKeysFile"`
		AdmissionPolicyPrefix string `json:"admissionPolicyPrefix"`
		AuditSigningKeyFile   string `json:"auditSigningKeyFile"`
		AuditSigningKeyID     string `json:"auditSigningKeyId"`
		MetricsURL            string `json:"metricsURL"`
		GitHubAppDir          string `json:"githubAppDir"`
		GitHubAPI             string `json:"githubAPI"`
		MaxConcurrent         int    `json:"maxConcurrent"`
	} `json:"gateway"`
}

func required(fields map[string]string) error {
	var missing []string
	for k, v := range fields {
		if v == "" {
			missing = append(missing, k)
		}
	}
	if len(missing) > 0 {
		return fmt.Errorf("gateway config is missing %s", strings.Join(missing, ", "))
	}
	return nil
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

func readSecret(dir, name string) (string, error) {
	b, err := os.ReadFile(filepath.Join(dir, name))
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
	raw, err := os.ReadFile(*configPath)
	if err != nil {
		return err
	}
	var fc FileConfig
	if err := yaml.Unmarshal(raw, &fc); err != nil {
		return fmt.Errorf("%s: %w", *configPath, err)
	}
	g := fc.Gateway
	if g.AuditSigningKeyID == "" {
		g.AuditSigningKeyID = "gateway"
	}
	if g.MaxConcurrent == 0 {
		g.MaxConcurrent = 4
	}
	podName, nodeName := os.Getenv("POD_NAME"), os.Getenv("NODE_NAME")
	if fc.Role != "gateway" {
		return fmt.Errorf("%s is for role %q", *configPath, fc.Role)
	}
	if err := required(map[string]string{
		"clusterId": fc.ClusterID, "release.namespace": fc.Release.Namespace,
		"listen.metrics": fc.Listen.Metrics, "listen.probes": fc.Listen.Probes, "hub.url": fc.Hub.URL, "hub.tokenFile": fc.Hub.TokenFile,
		"audit.bucket": fc.Audit.Bucket, "audit.endpoint": fc.Audit.Endpoint, "audit.credentialsDir": fc.Audit.CredentialsDir,
		"gateway.leaseName": g.LeaseName, "gateway.auditStagingDir": g.AuditStagingDir, "gateway.policyFile": g.PolicyFile,
		"gateway.approverKeysFile": g.ApproverKeysFile, "gateway.admissionPolicyPrefix": g.AdmissionPolicyPrefix,
		"gateway.auditSigningKeyFile": g.AuditSigningKeyFile, "gateway.metricsURL": g.MetricsURL, "POD_NAME": podName, "NODE_NAME": nodeName,
	}); err != nil {
		return err
	}
	if fc.Audit.Sink != "minio" && fc.Audit.Sink != "s3" {
		return fmt.Errorf("gateway requires audit.sink minio or s3, got %q", fc.Audit.Sink)
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
	access, err := readSecret(fc.Audit.CredentialsDir, "accessKey")
	if err != nil {
		return err
	}
	secret, err := readSecret(fc.Audit.CredentialsDir, "secretKey")
	if err != nil {
		return err
	}
	endpoint := strings.TrimPrefix(strings.TrimPrefix(fc.Audit.Endpoint, "https://"), "http://")
	s3, err := minio.New(endpoint, &minio.Options{Creds: credentials.NewStaticV4(access, secret, ""),
		Secure: strings.HasPrefix(fc.Audit.Endpoint, "https://"), Region: fc.Audit.Region})
	if err != nil {
		return err
	}
	key, err := LoadSigningKey(g.AuditSigningKeyFile)
	if err != nil {
		return err
	}
	mode := minio.Governance
	if fc.Audit.ObjectLock.Mode == "COMPLIANCE" {
		mode = minio.Compliance
	}
	chain, err := audit.Open(ctx, audit.Options{Cluster: fc.ClusterID, Dir: g.AuditStagingDir, CheckpointEvery: 100,
		Signer: audit.Signer{KeyID: g.AuditSigningKeyID, Key: key},
		Sink:   audit.SinkConfig{Client: s3, Bucket: fc.Audit.Bucket, ObjectLock: fc.Audit.ObjectLock.Enabled, Mode: mode, RetentionDays: fc.Audit.ObjectLock.RetentionDays}})
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
		api := g.GitHubAPI
		if api == "" {
			api = "https://api.github.com"
		}
		if app, err = github.Load(g.GitHubAppDir, api, 15*time.Second); err != nil {
			return err
		}
	}
	var eng *engine.Engine
	deps := &executor.Deps{Kube: kc, Catalog: cat, Policy: func() *policy.Policy { return eng.Policy() }, GitHub: app,
		Now: func() time.Time { return time.Now().UTC() }, Poll: 5 * time.Second}
	execs, err := executor.Registry(deps)
	if err != nil {
		return err
	}
	eng, err = engine.New(engine.Config{
		Cluster: fc.ClusterID, Namespace: fc.Release.Namespace, Identity: podName, NodeName: nodeName, LeaseName: g.LeaseName, Version: version,
		PolicyFile: g.PolicyFile, KeysFile: g.ApproverKeysFile, AdmissionPolicyPrefix: g.AdmissionPolicyPrefix,
		RequireWebAuthnForH: fc.Profile == "compliance", MaxConcurrent: g.MaxConcurrent,
		SafetyInterval: 15 * time.Second, PullWait: 30 * time.Second, PushInterval: 2 * time.Second, FlushInterval: 5 * time.Second,
		MaxClockSkew: 5 * time.Second, ThrottleHold: time.Minute,
		LeaseDuration: 15 * time.Second, RenewDeadline: 10 * time.Second, RetryPeriod: 2 * time.Second,
	}, engine.Deps{Kube: kc, Hub: hub, Catalog: cat, Executors: execs, Audit: chain, Verify: vc, Metrics: m, Clock: clock.RealClock{}})
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

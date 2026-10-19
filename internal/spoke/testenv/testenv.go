// Package testenv 为集成测试启动真实的依赖：envtest 的 kube-apiserver 与 etcd（固定版本的 CRD 来自 test/crds/，
// ActionExecution 来自 contract/gateway/v1/crd/）。二进制位置由 KUBEBUILDER_ASSETS 给出（make envtest-assets），
// 缺少时测试直接失败。临时目录都在仓库根目录的 .scratch/ 下。
package testenv

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	apiextensionsv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	utilyaml "k8s.io/apimachinery/pkg/util/yaml"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"sigs.k8s.io/controller-runtime/pkg/envtest"
	"sigs.k8s.io/yaml"
)

// Root 返回仓库根目录。
func Root() string {
	_, file, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(file), "..", "..", "..")
}

// Scratch 返回本次测试的工作目录（仓库根目录 .scratch/test/<name>-<随机>），测试结束时删除。
func Scratch(t testing.TB, name string) string {
	t.Helper()
	root := filepath.Join(Root(), ".scratch", "test")
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

// RequireEnv 返回环境变量，缺少时测试失败。
func RequireEnv(t testing.TB, name string) string {
	t.Helper()
	v := os.Getenv(name)
	if v == "" {
		t.Fatalf("%s is required for this integration test (see internal/spoke/testenv)", name)
	}
	return v
}

// Namespace 是 SreNautix 自身的命名空间；gateway 的 ServiceAccount、ActionExecution、Lease 与 srenautix-freeze 都在这里。
const Namespace = "srenautix"

// GatewayUser 是 gateway ServiceAccount 的用户名。
const GatewayUser = "system:serviceaccount:" + Namespace + ":srenautix-gateway"

// Env 是一个运行中的 envtest 控制面。
type Env struct {
	Cfg      *rest.Config
	Core     kubernetes.Interface
	Dyn      dynamic.Interface
	AuditLog string
}

// Options 控制 apiserver 的启动参数。
type Options struct {
	// Audit 为 true 时开启 apiserver 审计日志（Metadata 级别，记录全部写请求）。
	Audit bool
	// Namespaces 是额外创建的命名空间。
	Namespaces []string
}

const auditPolicy = `apiVersion: audit.k8s.io/v1
kind: Policy
omitStages: [RequestReceived]
rules:
  - level: Metadata
    verbs: [create, update, patch, delete, deletecollection]
  - level: None
`

// CRDs 读取 test/crds/ 中固定版本的 CRD 与 ActionExecution CRD。
func CRDs(t testing.TB) []*apiextensionsv1.CustomResourceDefinition {
	t.Helper()
	files, err := filepath.Glob(filepath.Join(Root(), "test", "crds", "*.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	files = append(files, filepath.Join(Root(), "contract", "gateway", "v1", "crd", "srenautix.io_actionexecutions.yaml"))
	var out []*apiextensionsv1.CustomResourceDefinition
	for _, f := range files {
		for _, doc := range Docs(t, f) {
			crd := &apiextensionsv1.CustomResourceDefinition{}
			if err := yaml.Unmarshal(doc, crd); err != nil {
				t.Fatalf("%s: %v", f, err)
			}
			if crd.Kind == "CustomResourceDefinition" {
				out = append(out, crd)
			}
		}
	}
	return out
}

// Docs 把多文档 YAML 文件拆成单个文档。
func Docs(t testing.TB, path string) [][]byte {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return SplitDocs(t, raw)
}

// SplitDocs 把多文档 YAML 拆成单个文档（JSON 形式）。
func SplitDocs(t testing.TB, raw []byte) [][]byte {
	t.Helper()
	dec := utilyaml.NewYAMLOrJSONDecoder(bytes.NewReader(raw), 4096)
	var out [][]byte
	for {
		var obj map[string]any
		err := dec.Decode(&obj)
		if errors.Is(err, io.EOF) {
			return out
		}
		if err != nil {
			t.Fatal(err)
		}
		if obj == nil {
			continue
		}
		b, err := yaml.Marshal(obj)
		if err != nil {
			t.Fatal(err)
		}
		out = append(out, b)
	}
}

// existingCluster 表示在已有集群（Kind，见 test/invariants/kind）上运行：envtest 读取同一个环境变量 USE_EXISTING_CLUSTER，
// 使用 KUBECONFIG 指向的集群，只安装 CRD。apiserver 的审计日志由 Kind 配置开启，路径由 SRENAUTIX_APISERVER_AUDIT_LOG 给出。
func existingCluster() bool { return os.Getenv("USE_EXISTING_CLUSTER") == "true" }

// Start 启动 kube-apiserver 与 etcd（或连接已有集群），安装 CRD 并创建命名空间。
func Start(t testing.TB, opts Options) *Env {
	t.Helper()
	env := &envtest.Environment{CRDs: CRDs(t), ErrorIfCRDPathMissing: true}
	e := &Env{}
	if existingCluster() {
		if opts.Audit {
			e.AuditLog = RequireEnv(t, "SRENAUTIX_APISERVER_AUDIT_LOG")
		}
	} else {
		RequireEnv(t, "KUBEBUILDER_ASSETS")
		// envtest 的 etcd 数据目录与证书放在 TMPDIR 下，指向仓库内被忽略的目录
		tmp := filepath.Join(Root(), ".scratch", "tmp")
		if err := os.MkdirAll(tmp, 0o755); err != nil {
			t.Fatal(err)
		}
		t.Setenv("TMPDIR", tmp)
	}
	if opts.Audit && !existingCluster() {
		dir := Scratch(t, "audit")
		policy := filepath.Join(dir, "policy.yaml")
		if err := os.WriteFile(policy, []byte(auditPolicy), 0o644); err != nil {
			t.Fatal(err)
		}
		e.AuditLog = filepath.Join(dir, "audit.log")
		args := env.ControlPlane.GetAPIServer().Configure()
		args.Set("audit-policy-file", policy)
		args.Set("audit-log-path", e.AuditLog)
		args.Set("audit-log-mode", "blocking")
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
	e.Cfg = cfg
	if e.Core, err = kubernetes.NewForConfig(cfg); err != nil {
		t.Fatal(err)
	}
	if e.Dyn, err = dynamic.NewForConfig(cfg); err != nil {
		t.Fatal(err)
	}
	for _, ns := range append([]string{Namespace}, opts.Namespaces...) {
		if _, err := e.Core.CoreV1().Namespaces().Create(context.Background(), &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: ns}}, metav1.CreateOptions{}); err != nil {
			t.Fatal(err)
		}
	}
	return e
}

// As 返回以 user 身份（模拟）发请求的配置。
func (e *Env) As(user string, groups ...string) *rest.Config {
	c := rest.CopyConfig(e.Cfg)
	c.Impersonate = rest.ImpersonationConfig{UserName: user, Groups: append(groups, "system:authenticated")}
	return c
}

// Gateway 返回以 gateway ServiceAccount 身份发请求的配置。
func (e *Env) Gateway() *rest.Config {
	return e.As(GatewayUser, "system:serviceaccounts", "system:serviceaccounts:"+Namespace)
}

var kindGVR = map[string]schema.GroupVersionResource{
	"ServiceAccount":                   {Version: "v1", Resource: "serviceaccounts"},
	"ConfigMap":                        {Version: "v1", Resource: "configmaps"},
	"Role":                             {Group: "rbac.authorization.k8s.io", Version: "v1", Resource: "roles"},
	"RoleBinding":                      {Group: "rbac.authorization.k8s.io", Version: "v1", Resource: "rolebindings"},
	"ClusterRole":                      {Group: "rbac.authorization.k8s.io", Version: "v1", Resource: "clusterroles"},
	"ClusterRoleBinding":               {Group: "rbac.authorization.k8s.io", Version: "v1", Resource: "clusterrolebindings"},
	"ValidatingAdmissionPolicy":        {Group: "admissionregistration.k8s.io", Version: "v1", Resource: "validatingadmissionpolicies"},
	"ValidatingAdmissionPolicyBinding": {Group: "admissionregistration.k8s.io", Version: "v1", Resource: "validatingadmissionpolicybindings"},
}

// Apply 以管理员身份创建一个 YAML 文档。
func (e *Env) Apply(t testing.TB, doc []byte) *unstructured.Unstructured {
	t.Helper()
	var obj map[string]any
	if err := yaml.Unmarshal(doc, &obj); err != nil {
		t.Fatal(err)
	}
	u := &unstructured.Unstructured{Object: obj}
	gvr, ok := kindGVR[u.GetKind()]
	if !ok {
		t.Fatalf("testenv: unsupported kind %s", u.GetKind())
	}
	var ri dynamic.ResourceInterface = e.Dyn.Resource(gvr)
	if u.GetNamespace() != "" {
		ri = e.Dyn.Resource(gvr).Namespace(u.GetNamespace())
	}
	out, err := ri.Create(context.Background(), u, metav1.CreateOptions{})
	if err != nil {
		t.Fatalf("create %s %s/%s: %v", u.GetKind(), u.GetNamespace(), u.GetName(), err)
	}
	return out
}

// Eventually 每 200 毫秒重试 cond，直到成立或超时。
func Eventually(t testing.TB, timeout time.Duration, what string, cond func() (bool, string)) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		ok, detail := cond()
		if ok {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("%s did not happen within %s; last: %s", what, timeout, detail)
		}
		time.Sleep(200 * time.Millisecond)
	}
}

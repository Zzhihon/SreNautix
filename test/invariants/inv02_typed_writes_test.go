package invariants

import (
	"encoding/json"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"

	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/catalog"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/executor"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/gwtest"
	"github.com/Zzhihon/SreNautix/internal/spoke/testenv"
)

// 不变量 2：写操作只能是类型化动作。
// 执行器注册表等于动作目录；gateway 代码不调用 os/exec；"失控 gateway"以自己的身份尝试目录之外的写入，被 RBAC 或准入拒绝（403）。
func TestInvariant02TypedWritesOnly(t *testing.T) {
	t.Run("executor registry equals the catalog", func(t *testing.T) {
		cat, err := catalog.Load()
		if err != nil {
			t.Fatal(err)
		}
		reg, err := executor.Registry(&executor.Deps{Catalog: cat})
		if err != nil {
			t.Fatal(err)
		}
		if len(reg) != len(cat.Actions) {
			t.Fatalf("%d executors for %d catalog actions", len(reg), len(cat.Actions))
		}
	})

	t.Run("no os/exec in gateway code", func(t *testing.T) {
		root := filepath.Join(testenv.Root(), "internal", "spoke")
		fset := token.NewFileSet()
		err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
				return err
			}
			// 测试环境（testenv、gwtest）启动真实的依赖进程，不属于 gateway 的运行代码
			if strings.Contains(path, string(filepath.Separator)+"testenv"+string(filepath.Separator)) ||
				strings.Contains(path, string(filepath.Separator)+"gwtest"+string(filepath.Separator)) {
				return nil
			}
			f, err := parser.ParseFile(fset, path, nil, parser.ImportsOnly)
			if err != nil {
				return err
			}
			for _, imp := range f.Imports {
				p, _ := strconv.Unquote(imp.Path.Value)
				if p == "os/exec" {
					t.Errorf("%s imports %s", path, p)
				}
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	})

	t.Run("rogue writes are denied", func(t *testing.T) {
		e := gwtest.New(t, gwtest.DefaultActions)
		gw := gatewayCore(t, e)
		e.F.Deployment(gwtest.AppNS, "rogue", 2)
		image, _ := json.Marshal([]map[string]any{{"op": "replace", "path": "/spec/template/spec/containers/0/image", "value": "registry.example/evil:latest"}})
		_, err := gw.AppsV1().Deployments(gwtest.AppNS).Patch(bg, "rogue", types.JSONPatchType, image, metav1.PatchOptions{})
		if !apierrors.IsForbidden(err) || !strings.Contains(err.Error(), "ValidatingAdmissionPolicy") {
			t.Fatalf("image change: want 403 from admission, got %v", err)
		}
		for what, write := range map[string]func() error{
			"create a ConfigMap": func() error {
				_, err := gw.CoreV1().ConfigMaps(gwtest.AppNS).Create(bg, &corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Name: "x"}}, metav1.CreateOptions{})
				return err
			},
			"delete a Pod": func() error {
				return gw.CoreV1().Pods(gwtest.AppNS).Delete(bg, "x", metav1.DeleteOptions{})
			},
			"delete a Deployment": func() error {
				return gw.AppsV1().Deployments(gwtest.AppNS).Delete(bg, "rogue", metav1.DeleteOptions{})
			},
			"create a Secret": func() error {
				_, err := gw.CoreV1().Secrets(gwtest.AppNS).Create(bg, &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: "x"}}, metav1.CreateOptions{})
				return err
			},
		} {
			if err := write(); !apierrors.IsForbidden(err) {
				t.Errorf("%s: want 403, got %v", what, err)
			}
		}
	})
}

package invariants

import (
	"strings"
	"syscall"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/gwtest"
	"github.com/Zzhihon/SreNautix/internal/spoke/testenv"
)

// 不变量 11：熔断开关不依赖 gateway。
// gateway 进程被 SIGSTOP 冻结后切换 srenautix-freeze：下一次以 gateway 身份的写入被准入拒绝；删除该 ConfigMap，写入同样被拒绝。
func TestInvariant11FreezeWithoutGateway(t *testing.T) {
	e := gwtest.New(t, gwtest.DefaultActions)
	e.F.Node("worker-1", false, true)
	child := e.StartChild(gwtest.Options{Identity: "frozen-gateway"}, "")
	testenv.Eventually(t, 60*time.Second, "child gateway leads", func() (bool, string) {
		hb, ok := e.Hub.LastHeartbeat()
		return ok && hb.GatewayID == "frozen-gateway" && !hb.ProposeOnly, ""
	})
	if err := child.Signal(syscall.SIGSTOP); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = child.Signal(syscall.SIGCONT) }()

	gw := gatewayCore(t, e)
	cordon := func() error {
		return mergePatchNode(gw, "worker-1", map[string]any{"spec": map[string]any{"unschedulable": true}})
	}
	denied := func(err error) bool {
		return err != nil && strings.Contains(err.Error(), "srenautix-freeze is frozen or missing")
	}
	cms := e.Kube.Core.CoreV1().ConfigMaps(testenv.Namespace)
	cm, err := cms.Get(bg, "srenautix-freeze", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	cm.Data["frozen"] = "true"
	if _, err := cms.Update(bg, cm, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	testenv.Eventually(t, 30*time.Second, "frozen write denied", func() (bool, string) {
		err := cordon()
		return denied(err), errText(err)
	})
	if err := cms.Delete(bg, "srenautix-freeze", metav1.DeleteOptions{}); err != nil {
		t.Fatal(err)
	}
	testenv.Eventually(t, 30*time.Second, "write denied without srenautix-freeze", func() (bool, string) {
		err := cordon()
		return err != nil && strings.Contains(err.Error(), "ValidatingAdmissionPolicy"), errText(err)
	})
	if unschedulable(t, e, "worker-1") {
		t.Fatal("node was cordoned while frozen")
	}
	// 恢复 frozen=false 后同样的写入放行，说明拒绝来自熔断开关
	if _, err := cms.Create(bg, &corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Name: "srenautix-freeze"}, Data: map[string]string{"frozen": "false"}}, metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}
	testenv.Eventually(t, 30*time.Second, "unfrozen write allowed", func() (bool, string) {
		err := mergePatchNode(gw, "worker-1", map[string]any{"metadata": map[string]any{"annotations": map[string]any{"srenautix.io/execution-id": "0123456789abcdef0123456789abcdef"}}})
		return err == nil, errText(err)
	})
}

func errText(err error) string {
	if err == nil {
		return "allowed"
	}
	return err.Error()
}

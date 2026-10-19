// Package invariants 测试 DESIGN §16.1 中由 spoke（gateway）承担的不变量 2、3、4、5、7、8、10、11、12。
// 每个测试在 envtest 的 kube-apiserver（带审计日志）上安装生成的准入策略与 RBAC，以 gateway 的 ServiceAccount 身份运行引擎，
// 并使用真实的 MinIO（审计汇）、Prometheus（执行后校验）与工单协议的中心实现。需要 Kind 的部分见 README.md。
package invariants

import (
	"os"
	"testing"

	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/gwtest"
)

func TestMain(m *testing.M) {
	// 不变量 8 的故障注入以子进程运行 gateway：子进程重新执行本测试二进制
	if gwtest.RunChildIfRequested() {
		return
	}
	os.Exit(m.Run())
}

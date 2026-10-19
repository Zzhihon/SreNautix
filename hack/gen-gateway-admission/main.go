// gen-gateway-admission 从动作目录生成 deploy/helm/srenautix/files/admission/（index.yaml 与每个准入策略）。
// 用法：go run ./hack/gen-gateway-admission
package main

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"

	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/admission"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/catalog"
)

func main() {
	cat, err := catalog.Load()
	if err != nil {
		panic(err)
	}
	out, err := admission.Generate(cat, admission.HelmOptions())
	if err != nil {
		panic(err)
	}
	_, file, _, _ := runtime.Caller(0)
	dir := filepath.Join(filepath.Dir(file), "..", "..", "deploy", "helm", "srenautix", "files", "admission")
	if err := out.WriteDir(dir); err != nil {
		panic(err)
	}
	fmt.Fprintf(os.Stdout, "wrote %s: %d policies, %d actions\n", dir, len(out.Policies), len(out.Index.Actions))
}

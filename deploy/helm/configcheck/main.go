// configcheck 用 reader 与 gateway 自己的配置加载代码校验 chart 渲染出的配置（由 deploy/helm/check-role-configs.sh 调用）。
//
//	go run ./deploy/helm/configcheck <目录>
//
// 目录下有 reader.yaml、gateway.yaml；任何一个不能通过加载都以非零状态退出。
package main

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/Zzhihon/SreNautix/internal/spoke/gateway"
	"github.com/Zzhihon/SreNautix/internal/spoke/reader"
)

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: configcheck <rendered config dir>")
		os.Exit(2)
	}
	dir := os.Args[1]
	if _, err := reader.LoadConfig(filepath.Join(dir, "reader.yaml")); err != nil {
		fmt.Fprintln(os.Stderr, "reader:", err)
		os.Exit(1)
	}
	fmt.Println("reader：通过")
	if _, err := gateway.LoadConfig(filepath.Join(dir, "gateway.yaml")); err != nil {
		fmt.Fprintln(os.Stderr, "gateway:", err)
		os.Exit(1)
	}
	fmt.Println("gateway：通过")
}

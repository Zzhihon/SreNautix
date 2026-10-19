// srenautix-spoke 是分支镜像的入口，按 --role 运行 reader 或 gateway（DESIGN §1.1）。
//
//	srenautix-spoke --role=reader  [reader 的参数]
//	srenautix-spoke --role=gateway [gateway 的参数]
//
// 其余参数原样交给对应角色解析。
package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/Zzhihon/SreNautix/internal/spoke/gateway"
	"github.com/Zzhihon/SreNautix/internal/spoke/reader"
)

// version 由构建时的 -ldflags "-X main.version=..." 写入。
var version = "dev"

const usage = "usage: srenautix-spoke --role=reader|gateway [role flags]"

func splitRole(args []string) (string, []string, error) {
	var role string
	var rest []string
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case strings.HasPrefix(a, "--role="):
			role = strings.TrimPrefix(a, "--role=")
		case a == "--role":
			if i+1 >= len(args) {
				return "", nil, fmt.Errorf("--role needs a value")
			}
			role = args[i+1]
			i++
		default:
			rest = append(rest, a)
		}
	}
	if role != "reader" && role != "gateway" {
		return "", nil, fmt.Errorf("%s (got role %q)", usage, role)
	}
	return role, rest, nil
}

func main() {
	role, args, err := splitRole(os.Args[1:])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	switch role {
	case "reader":
		err = reader.Run(ctx, version, args)
	case "gateway":
		err = gateway.Run(ctx, version, args)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "srenautix-spoke:", err)
		os.Exit(1)
	}
}

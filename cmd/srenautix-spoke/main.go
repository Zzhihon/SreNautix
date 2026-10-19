// srenautix-spoke 是分支镜像的入口，按 --role 运行 reader 或 gateway（DESIGN §1.1）。
//
//	srenautix-spoke --role=reader  [reader 的参数]
//	srenautix-spoke --role=gateway [gateway 的参数]
//	srenautix-spoke admission workflow-allowlist --policy=<gateway 策略> [--username=<用户名>] [--prefix=<名称前缀>]
//
// 其余参数原样交给对应角色解析。admission workflow-allowlist 按 gateway 策略中的 workflow_templates
// 输出工作流模板白名单的 ValidatingAdmissionPolicy（不带 --username/--prefix 时输出供 Helm tpl 渲染的形式）。
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/Zzhihon/SreNautix/internal/spoke/gateway"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/admission"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/catalog"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/policy"
	"github.com/Zzhihon/SreNautix/internal/spoke/reader"
)

// version 由构建时的 -ldflags "-X main.version=..." 写入。
var version = "dev"

const usage = "usage: srenautix-spoke --role=reader|gateway [role flags] | srenautix-spoke admission workflow-allowlist --policy=<file>"

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

func workflowAllowlist(args []string) error {
	fs := flag.NewFlagSet("admission workflow-allowlist", flag.ContinueOnError)
	policyFile := fs.String("policy", "", "gateway policy file (gateway-policy.schema.json)")
	username := fs.String("username", "", "gateway ServiceAccount user name; empty renders the Helm include")
	prefix := fs.String("prefix", "", "policy name prefix; empty renders the Helm include")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *policyFile == "" {
		return fmt.Errorf("--policy is required")
	}
	cat, err := catalog.Load()
	if err != nil {
		return err
	}
	pol, err := policy.Load(*policyFile, cat)
	if err != nil {
		return err
	}
	opts := admission.HelmOptions()
	if *username != "" {
		opts.Username = *username
	}
	if *prefix != "" {
		opts.Prefix = *prefix
	}
	p, err := admission.WorkflowAllowlist(pol, opts)
	if err != nil {
		return err
	}
	b, err := p.Marshal()
	if err != nil {
		return err
	}
	_, err = os.Stdout.Write(b)
	return err
}

func main() {
	args := os.Args[1:]
	if len(args) >= 2 && args[0] == "admission" && args[1] == "workflow-allowlist" {
		if err := workflowAllowlist(args[2:]); err != nil {
			fmt.Fprintln(os.Stderr, "srenautix-spoke:", err)
			os.Exit(1)
		}
		return
	}
	role, rest, err := splitRole(args)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	switch role {
	case "reader":
		err = reader.Run(ctx, version, rest)
	case "gateway":
		err = gateway.Run(ctx, version, rest)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "srenautix-spoke:", err)
		os.Exit(1)
	}
}

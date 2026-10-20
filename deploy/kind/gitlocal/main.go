// gitlocal 是 Kind 端到端用的本地 Git 服务：后端是真实的 bare 仓库，对外提供
//
//   - git smart HTTP（clone、fetch 不需要认证，Argo CD 从这里同步；push 需要管理员令牌）；
//   - GitHub REST 的子集：GitHub App 的 JWT 与安装令牌、Git Data（refs、trees、commits）、contents、commits、
//     pulls（创建、列出、关闭、请求审阅；合并接口拒绝并记入审计）、issues 与评论。
//     接口范围是 server（issue、评论、变更源、PR 关联）与 gateway 的 gitops_pr 实际调用的那些，字段按 GitHub 文档；
//   - /_test 控制接口（-test-api，见 testapi.go）：重建仓库、模拟人工推送与网页合并、读取审计与请求日志。
//
// Gitea 等现成服务没有 GitHub App 的安装令牌与 Git Data 写接口，SreNautix 的两个 GitHub 客户端无法直接对接，所以单独实现。
// 审计记录每一次引用变更的身份（App 机器人或人工），Kind 场景据此断言"只推 srenautix/* 分支、main 没有被机器人改动、从不合并"。
//
// 用法：
//
//	gitlocal -listen :3000 -data /var/lib/gitlocal -public-url http://gitlocal.gitlocal.svc:3000 \
//	  -app-id 1 -installation-id 1 -app-slug srenautix-kind -app-public-key /etc/gitlocal/app.pub.pem \
//	  -admin-token-file /etc/gitlocal/admin-token -seed kind/gitops=/seed/gitops -test-api
package main

import (
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"time"
)

type seedFlags []string

func (s *seedFlags) String() string     { return strings.Join(*s, ",") }
func (s *seedFlags) Set(v string) error { *s = append(*s, v); return nil }

func loadPublicKey(path string) (*rsa.PublicKey, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	block, _ := pem.Decode(b)
	if block == nil {
		return nil, fmt.Errorf("%s is not PEM", path)
	}
	k, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	pk, ok := k.(*rsa.PublicKey)
	if !ok {
		return nil, errors.New(path + " is not an RSA public key")
	}
	return pk, nil
}

func main() {
	var cfg config
	var seeds seedFlags
	var listen, keyFile, adminTokenFile string
	flag.StringVar(&listen, "listen", ":3000", "listen address")
	flag.StringVar(&cfg.DataDir, "data", "/var/lib/gitlocal", "directory for bare repositories and state")
	flag.StringVar(&cfg.PublicURL, "public-url", "http://localhost:3000", "base URL used in html_url")
	flag.StringVar(&cfg.AppID, "app-id", "1", "GitHub App id (JWT iss)")
	flag.StringVar(&cfg.InstallationID, "installation-id", "1", "GitHub App installation id")
	flag.StringVar(&cfg.AppSlug, "app-slug", "srenautix-kind", "GitHub App slug (bot login is <slug>[bot])")
	flag.StringVar(&keyFile, "app-public-key", "", "PEM file with the App public key; empty skips JWT signature checks")
	flag.StringVar(&adminTokenFile, "admin-token-file", "", "file holding the admin token (human identity, git push)")
	flag.StringVar(&cfg.AdminLogin, "admin-login", "kind-operator", "login of the human identity")
	flag.BoolVar(&cfg.TestAPI, "test-api", false, "enable the /_test control API")
	flag.Var(&seeds, "seed", "owner/name=dir: create the repository from dir when it does not exist (repeatable)")
	flag.Parse()

	if keyFile != "" {
		k, err := loadPublicKey(keyFile)
		if err != nil {
			log.Fatal(err)
		}
		cfg.AppPublicKey = k
	}
	if adminTokenFile != "" {
		b, err := os.ReadFile(adminTokenFile)
		if err != nil {
			log.Fatal(err)
		}
		cfg.AdminToken = strings.TrimSpace(string(b))
	}
	if err := os.MkdirAll(cfg.DataDir, 0o755); err != nil {
		log.Fatal(err)
	}
	s, err := newServer(cfg)
	if err != nil {
		log.Fatal(err)
	}
	for _, sd := range seeds {
		full, dir, ok := strings.Cut(sd, "=")
		if !ok {
			log.Fatalf("-seed %q is not owner/name=dir", sd)
		}
		if err := s.seed(full, dir); err != nil {
			log.Fatalf("seed %s: %v", full, err)
		}
	}
	srv := &http.Server{Addr: listen, Handler: s, ReadHeaderTimeout: 10 * time.Second}
	log.Printf("gitlocal listening on %s (test API %v)", listen, cfg.TestAPI)
	log.Fatal(srv.ListenAndServe())
}

package main

import (
	"compress/gzip"
	"fmt"
	"io"
	"net/http"
	"os/exec"
	"strings"
)

// smartHTTP 实现 git 的 smart HTTP（协议 v0）：/<owner>/<name>.git/info/refs、git-upload-pack 与 git-receive-pack。
// 读取（clone、fetch，Argo CD 同步）不需要认证；推送只接受管理员令牌（HTTP Basic 的口令），并把引用变更写入审计。
func (s *server) smartHTTP(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/")
	var full, op string
	for _, suffix := range []string{"/info/refs", "/git-upload-pack", "/git-receive-pack"} {
		if strings.HasSuffix(path, suffix) {
			full = strings.TrimSuffix(strings.TrimSuffix(path, suffix), ".git")
			op = strings.TrimPrefix(suffix, "/")
		}
	}
	repo, ok := s.repo(full)
	if !ok {
		http.NotFound(w, r)
		return
	}
	service := op
	if op == "info/refs" {
		service = r.URL.Query().Get("service")
	}
	if service != "git-upload-pack" && service != "git-receive-pack" {
		http.Error(w, "dumb HTTP is not supported", http.StatusForbidden)
		return
	}
	var who identity
	if service == "git-receive-pack" {
		var ok bool
		who, ok = s.caller(r)
		if !ok || who.Bot {
			w.Header().Set("WWW-Authenticate", `Basic realm="gitlocal"`)
			http.Error(w, "push requires the admin token", http.StatusUnauthorized)
			return
		}
	}
	sub := strings.TrimPrefix(service, "git-")
	if op == "info/refs" {
		w.Header().Set("Content-Type", "application/x-"+service+"-advertisement")
		w.Header().Set("Cache-Control", "no-cache")
		_, _ = io.WriteString(w, pktLine("# service="+service+"\n")+"0000")
		cmd := exec.Command("git", sub, "--stateless-rpc", "--advertise-refs", repo.dir)
		cmd.Stdout = w
		if err := cmd.Run(); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
		}
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "POST required", http.StatusMethodNotAllowed)
		return
	}
	body := io.Reader(r.Body)
	if r.Header.Get("Content-Encoding") == "gzip" {
		gz, err := gzip.NewReader(r.Body)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		defer gz.Close()
		body = gz
	}
	var before map[string]string
	if service == "git-receive-pack" {
		s.mu.Lock()
		defer s.mu.Unlock()
		var err error
		if before, err = repo.branches(); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	}
	w.Header().Set("Content-Type", "application/x-"+service+"-result")
	w.Header().Set("Cache-Control", "no-cache")
	cmd := exec.Command("git", sub, "--stateless-rpc", repo.dir)
	cmd.Stdin = body
	cmd.Stdout = w
	if err := cmd.Run(); err != nil {
		return // 响应已经开始写出，错误由 git 客户端从协议中看到
	}
	if service == "git-receive-pack" {
		after, err := repo.branches()
		if err != nil {
			return
		}
		for name, sha := range after {
			if before[name] != sha {
				old := before[name]
				if old == "" {
					old = zeroSHA
				}
				s.audit(auditEntry{Repo: full, Kind: "ref_update", Ref: "refs/heads/" + name, Old: old, New: sha, Actor: who.Login, Bot: who.Bot})
			}
		}
		for name, sha := range before {
			if _, ok := after[name]; !ok {
				s.audit(auditEntry{Repo: full, Kind: "ref_update", Ref: "refs/heads/" + name, Old: sha, New: zeroSHA, Actor: who.Login, Bot: who.Bot})
			}
		}
		_ = s.save()
	}
}

func pktLine(s string) string { return fmt.Sprintf("%04x%s", len(s)+4, s) }

// Package github 以 GitHub App 的身份在 srenautix/ 前缀分支上提交补丁并开 PR，从不合并（不变量 12）。
// 发出的每个请求先经 checkRequest 的白名单：读 base 分支与文件、读分支保护状态、在 srenautix/ 分支上建树、提交与分支引用、
// 开指向 base 的 PR、读 PR、只把 PR 关闭。白名单中没有任何合并、删除或改写已有分支的接口。
package github

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

// BranchPrefix 是 gateway 唯一会推送的分支前缀。
const BranchPrefix = "srenautix/"

// App 是一个 GitHub App 安装。
type App struct {
	AppID          string
	InstallationID string
	Slug           string
	key            *rsa.PrivateKey
	api            string
	http           *http.Client

	mu         sync.Mutex
	identified bool
	token      string
	tokenExp   time.Time
}

// Load 读取目录中的 app-id、installation-id、slug 与 private-key.pem（挂载的 Secret）。
func Load(dir, apiBase string, timeout time.Duration) (*App, error) {
	read := func(name string) (string, error) {
		b, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			return "", err
		}
		return strings.TrimSpace(string(b)), nil
	}
	appID, err := read("app-id")
	if err != nil {
		return nil, err
	}
	inst, err := read("installation-id")
	if err != nil {
		return nil, err
	}
	slug, err := read("slug")
	if err != nil {
		return nil, err
	}
	pemText, err := os.ReadFile(filepath.Join(dir, "private-key.pem"))
	if err != nil {
		return nil, err
	}
	key, err := ParsePrivateKey(pemText)
	if err != nil {
		return nil, err
	}
	return New(appID, inst, slug, key, apiBase, timeout)
}

// New 创建 App 客户端。
func New(appID, installationID, slug string, key *rsa.PrivateKey, apiBase string, timeout time.Duration) (*App, error) {
	if !numeric(appID) || !numeric(installationID) || slug == "" {
		return nil, fmt.Errorf("github: app-id and installation-id must be numeric and slug non-empty")
	}
	return &App{AppID: appID, InstallationID: installationID, Slug: slug, key: key, api: strings.TrimRight(apiBase, "/"),
		http: &http.Client{Timeout: timeout,
			// 不跟随重定向，避免把 Authorization 带到别的主机
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}

// ParsePrivateKey 解析 PKCS#1 或 PKCS#8 的 RSA 私钥。
func ParsePrivateKey(pemText []byte) (*rsa.PrivateKey, error) {
	block, _ := pem.Decode(pemText)
	if block == nil {
		return nil, fmt.Errorf("github: private key is not PEM")
	}
	if k, err := x509.ParsePKCS1PrivateKey(block.Bytes); err == nil {
		return k, nil
	}
	k, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("github: private key: %w", err)
	}
	rk, ok := k.(*rsa.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("github: private key is not RSA")
	}
	return rk, nil
}

func b64(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

// SignJWT 生成 App JWT（RS256，iat 提前 60 秒，9 分钟有效）。
func SignJWT(key *rsa.PrivateKey, appID string, now time.Time) (string, error) {
	header := b64([]byte(`{"alg":"RS256","typ":"JWT"}`))
	claims, err := json.Marshal(map[string]any{"iat": now.Add(-60 * time.Second).Unix(), "exp": now.Add(9 * time.Minute).Unix(), "iss": appID})
	if err != nil {
		return "", err
	}
	signing := header + "." + b64(claims)
	sum := sha256.Sum256([]byte(signing))
	sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, sum[:])
	if err != nil {
		return "", err
	}
	return signing + "." + b64(sig), nil
}

// APIError 是 GitHub REST 的非 2xx 响应。
type APIError struct {
	Status  int
	Message string
	Path    string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("github %s: HTTP %d %s", e.Path, e.Status, e.Message)
}

func numeric(s string) bool {
	if s == "" {
		return false
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

var (
	reInstallationToken = regexp.MustCompile(`^/app/installations/[0-9]+/access_tokens$`)
	reRepo              = regexp.MustCompile(`^/repos/([A-Za-z0-9-]+)/([A-Za-z0-9._-]+)(/.*)$`)
	reCommit            = regexp.MustCompile(`^/git/commits/[0-9a-f]{40}$`)
	reRef               = regexp.MustCompile(`^/git/ref/heads/[A-Za-z0-9._/-]+$`)
	reBranch            = regexp.MustCompile(`^/branches/[A-Za-z0-9._/%-]+$`)
	reContents          = regexp.MustCompile(`^/contents/[^?#]+$`)
	rePull              = regexp.MustCompile(`^/pulls/[0-9]+$`)
)

// ErrNotAllowed 表示请求不在白名单中，没有发出。
var ErrNotAllowed = errors.New("github request is not allowed")

// CheckRequest 是发往 GitHub 的请求白名单；不在白名单中的请求不发出。
func CheckRequest(method, p string, in any) error {
	path, _, _ := strings.Cut(p, "?")
	deny := fmt.Errorf("%w: %s %s", ErrNotAllowed, method, path)
	switch {
	case method == http.MethodGet && path == "/app":
		return nil
	case method == http.MethodPost && reInstallationToken.MatchString(path):
		return nil
	}
	m := reRepo.FindStringSubmatch(path)
	if m == nil {
		return deny
	}
	rest := m[3]
	body, _ := in.(map[string]any)
	field := func(k string) string { s, _ := body[k].(string); return s }
	switch method {
	case http.MethodGet:
		if reRef.MatchString(rest) || reBranch.MatchString(rest) || reCommit.MatchString(rest) || reContents.MatchString(rest) || rest == "/pulls" || rePull.MatchString(rest) {
			return nil
		}
	case http.MethodPost:
		switch rest {
		case "/git/trees", "/git/commits":
			return nil
		case "/git/refs":
			if strings.HasPrefix(field("ref"), "refs/heads/"+BranchPrefix) {
				return nil
			}
		case "/pulls":
			if strings.HasPrefix(field("head"), BranchPrefix) && field("base") != "" && !strings.HasPrefix(field("base"), BranchPrefix) {
				return nil
			}
		}
	case http.MethodPatch:
		// 唯一的修改：关闭 PR
		if rePull.MatchString(rest) && len(body) == 1 && field("state") == "closed" {
			return nil
		}
	}
	return deny
}

func (a *App) call(ctx context.Context, method, p, auth string, in, out any) error {
	if err := CheckRequest(method, p, in); err != nil {
		return err
	}
	var body io.Reader
	if in != nil {
		b, err := json.Marshal(in)
		if err != nil {
			return err
		}
		body = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, a.api+p, body)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	req.Header.Set("Authorization", auth)
	if in != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := a.http.Do(req)
	if err != nil {
		return fmt.Errorf("github %s %s: %w", method, p, err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		var m struct {
			Message string `json:"message"`
		}
		_ = json.Unmarshal(raw, &m) // 错误体不是 JSON 时只保留状态码
		return &APIError{Status: resp.StatusCode, Message: m.Message, Path: p}
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("github %s: decode: %w", p, err)
	}
	return nil
}

// installationToken 取安装令牌；首次使用前经 GET /app 核对 slug，不符时拒绝使用。
func (a *App) installationToken(ctx context.Context) (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.token != "" && time.Until(a.tokenExp) > 5*time.Minute {
		return a.token, nil
	}
	jwt, err := SignJWT(a.key, a.AppID, time.Now())
	if err != nil {
		return "", err
	}
	if !a.identified {
		var app struct {
			Slug string `json:"slug"`
		}
		if err := a.call(ctx, http.MethodGet, "/app", "Bearer "+jwt, nil, &app); err != nil {
			return "", err
		}
		if app.Slug != a.Slug {
			return "", fmt.Errorf("github: the configured App is %q, expected %q", app.Slug, a.Slug)
		}
		a.identified = true
	}
	var out struct {
		Token     string    `json:"token"`
		ExpiresAt time.Time `json:"expires_at"`
	}
	if err := a.call(ctx, http.MethodPost, "/app/installations/"+url.PathEscape(a.InstallationID)+"/access_tokens", "Bearer "+jwt, nil, &out); err != nil {
		return "", err
	}
	if out.Token == "" {
		return "", fmt.Errorf("github: empty installation token")
	}
	a.token, a.tokenExp = out.Token, out.ExpiresAt
	return a.token, nil
}

// Repo 是一个仓库的客户端。
type Repo struct {
	app         *App
	Owner, Name string
}

// Repo 返回 owner/name 的客户端。
func (a *App) Repo(full string) (*Repo, error) {
	owner, name, ok := strings.Cut(full, "/")
	if !ok {
		return nil, fmt.Errorf("github: repository %q is not owner/name", full)
	}
	return &Repo{app: a, Owner: owner, Name: name}, nil
}

func (r *Repo) call(ctx context.Context, method, p string, in, out any) error {
	tok, err := r.app.installationToken(ctx)
	if err != nil {
		return err
	}
	return r.app.call(ctx, method, "/repos/"+url.PathEscape(r.Owner)+"/"+url.PathEscape(r.Name)+p, "Bearer "+tok, in, out)
}

func escapePath(p string) string {
	parts := strings.Split(p, "/")
	for i, s := range parts {
		parts[i] = url.PathEscape(s)
	}
	return strings.Join(parts, "/")
}

// Head 返回分支的提交 SHA。
func (r *Repo) Head(ctx context.Context, branch string) (string, error) {
	var ref struct {
		Object struct {
			SHA string `json:"sha"`
		} `json:"object"`
	}
	if err := r.call(ctx, http.MethodGet, "/git/ref/heads/"+escapePath(branch), nil, &ref); err != nil {
		return "", err
	}
	return ref.Object.SHA, nil
}

// Protected 返回分支是否受分支保护（GET /branches/{branch} 的 protected 字段，需要 Contents 读权限）。
func (r *Repo) Protected(ctx context.Context, branch string) (bool, error) {
	var b struct {
		Protected bool `json:"protected"`
	}
	if err := r.call(ctx, http.MethodGet, "/branches/"+url.PathEscape(branch), nil, &b); err != nil {
		return false, err
	}
	return b.Protected, nil
}

// FileAt 读取 ref 上的文件；不存在时 ok=false。
func (r *Repo) FileAt(ctx context.Context, ref, p string) (content []byte, ok bool, err error) {
	var out struct {
		Type     string `json:"type"`
		Encoding string `json:"encoding"`
		Content  string `json:"content"`
	}
	err = r.call(ctx, http.MethodGet, "/contents/"+escapePath(p)+"?ref="+url.QueryEscape(ref), nil, &out)
	var apiErr *APIError
	if errors.As(err, &apiErr) && apiErr.Status == http.StatusNotFound {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	if out.Type != "file" || out.Encoding != "base64" {
		return nil, false, fmt.Errorf("github: %s is a %s with encoding %q", p, out.Type, out.Encoding)
	}
	b, err := base64.StdEncoding.DecodeString(strings.ReplaceAll(out.Content, "\n", ""))
	if err != nil {
		return nil, false, fmt.Errorf("github: %s: %w", p, err)
	}
	return b, true, nil
}

// PullRequest 是创建或查到的 PR。
type PullRequest struct {
	Number  int    `json:"number"`
	HTMLURL string `json:"html_url"`
	State   string `json:"state"`
	Head    struct {
		Ref string `json:"ref"`
		SHA string `json:"sha"`
	} `json:"head"`
}

// OpenPR 在 baseSHA 之上提交 changes 到新分支 branch 并开指向 base 的 PR；分支已存在时返回错误。
func (r *Repo) OpenPR(ctx context.Context, base, baseSHA, branch, title, body string, changes []FileChange) (PullRequest, string, error) {
	if !strings.HasPrefix(branch, BranchPrefix) {
		return PullRequest{}, "", fmt.Errorf("github: branch %s is outside %s", branch, BranchPrefix)
	}
	var commit struct {
		Tree struct {
			SHA string `json:"sha"`
		} `json:"tree"`
	}
	if err := r.call(ctx, http.MethodGet, "/git/commits/"+url.PathEscape(baseSHA), nil, &commit); err != nil {
		return PullRequest{}, "", err
	}
	entries := make([]map[string]any, 0, len(changes))
	for _, c := range changes {
		e := map[string]any{"path": c.Path, "mode": "100644", "type": "blob"}
		if c.Delete {
			e["sha"] = nil
		} else {
			e["content"] = string(c.Content)
		}
		entries = append(entries, e)
	}
	var tree struct {
		SHA string `json:"sha"`
	}
	if err := r.call(ctx, http.MethodPost, "/git/trees", map[string]any{"base_tree": commit.Tree.SHA, "tree": entries}, &tree); err != nil {
		return PullRequest{}, "", err
	}
	var newCommit struct {
		SHA string `json:"sha"`
	}
	if err := r.call(ctx, http.MethodPost, "/git/commits", map[string]any{"message": title, "tree": tree.SHA, "parents": []string{baseSHA}}, &newCommit); err != nil {
		return PullRequest{}, "", err
	}
	if err := r.call(ctx, http.MethodPost, "/git/refs", map[string]any{"ref": "refs/heads/" + branch, "sha": newCommit.SHA}, nil); err != nil {
		return PullRequest{}, newCommit.SHA, err
	}
	var pr PullRequest
	if err := r.call(ctx, http.MethodPost, "/pulls", map[string]any{"title": title, "head": branch, "base": base, "body": body}, &pr); err != nil {
		return PullRequest{}, newCommit.SHA, err
	}
	return pr, newCommit.SHA, nil
}

// FindPR 返回 branch 上最近的 PR（任意状态），没有时 ok=false。
func (r *Repo) FindPR(ctx context.Context, branch string) (PullRequest, bool, error) {
	var prs []PullRequest
	if err := r.call(ctx, http.MethodGet, "/pulls?state=all&head="+url.QueryEscape(r.Owner+":"+branch), nil, &prs); err != nil {
		return PullRequest{}, false, err
	}
	if len(prs) == 0 {
		return PullRequest{}, false, nil
	}
	return prs[0], true, nil
}

// ClosePR 关闭 PR。
func (r *Repo) ClosePR(ctx context.Context, number int) (PullRequest, error) {
	var pr PullRequest
	err := r.call(ctx, http.MethodPatch, fmt.Sprintf("/pulls/%d", number), map[string]any{"state": "closed"}, &pr)
	return pr, err
}

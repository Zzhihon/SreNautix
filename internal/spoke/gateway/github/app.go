// Package github 以 GitHub App 的身份在 srenautix/ 前缀分支上提交补丁并开 PR，从不合并（不变量 12，ADR 0025）。
// 这是 SreNautix 唯一向 Git 写入的代码，补偿控制全部在这里：
//   - 发出的每个请求先经 CheckRequest 的白名单：读 base 分支、文件、提交与 PR，读分支保护状态，在 srenautix/ 分支上建树、
//     提交与新建分支引用，开指向 base 的 PR，请求审阅，只把 PR 关闭。白名单中没有任何合并、删除或改写已有引用的接口，
//     客户端也不提供合并方法；
//   - OpenPR 推送前后各读一次 base，base 在推送期间变化时不开 PR；
//   - 每次推送、核对、开 PR、请求审阅与被拦下的请求都交给 Recorder 写入执行审计链；
//   - UnexpectedCommits 是 main watchdog 的判定。
//
// 按小时限速由 gateway 引擎按 ActionExecution 计数（同一份执行记录也是 at-most-once 的依据）。
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
	// OnDenied 在请求被白名单拦下时调用（计数），请求不会发出。
	OnDenied func(*DeniedError)

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
	rePullReviewers     = regexp.MustCompile(`^/pulls/[0-9]+/requested_reviewers$`)
	reCommitPulls       = regexp.MustCompile(`^/commits/[0-9a-f]{40}/pulls$`)
	reBranchName        = regexp.MustCompile(`^srenautix/[a-z0-9][a-z0-9._/-]{0,120}$`)
)

// ValidBranch 表示 branch 是 gateway 可以推送的分支：srenautix/ 前缀，之后只有小写字母、数字与 . _ / -，不含 ..。
func ValidBranch(branch string) bool {
	return reBranchName.MatchString(branch) && !strings.Contains(branch, "..") && !strings.HasSuffix(branch, "/") &&
		!strings.HasSuffix(branch, ".lock") && !strings.Contains(branch, "//")
}

// ErrNotAllowed 表示请求不在白名单中，没有发出。
var ErrNotAllowed = errors.New("github request is not allowed")

// 白名单拒绝的原因（指标 srenautix_gitops_denied_requests_total 的 reason 标签）。
const (
	DeniedRefOutsidePrefix = "ref_outside_prefix"
	DeniedMerge            = "merge"
	DeniedOther            = "other"
)

// DeniedError 是被白名单拦下、没有发出的请求。
type DeniedError struct {
	Method, Path, Reason string
}

func (e *DeniedError) Error() string {
	return fmt.Sprintf("%v: %s %s (%s)", ErrNotAllowed, e.Method, e.Path, e.Reason)
}

func (e *DeniedError) Unwrap() error { return ErrNotAllowed }

// CheckRequest 是发往 GitHub 的请求白名单；不在白名单中的请求不发出，返回 *DeniedError。
// 允许的写入只有：在 srenautix/ 分支上建树、提交与新建分支引用，开 head 为 srenautix/ 分支的 PR，请求审阅，关闭 PR。
// 没有任何合并、删除、改写已有引用、写文件内容的接口。
func CheckRequest(method, p string, in any) error {
	path, _, _ := strings.Cut(p, "?")
	deny := func(reason string) error { return &DeniedError{Method: method, Path: path, Reason: reason} }
	if strings.Contains(path, "/merge") {
		return deny(DeniedMerge)
	}
	switch {
	case method == http.MethodGet && path == "/app":
		return nil
	case method == http.MethodPost && reInstallationToken.MatchString(path):
		return nil
	}
	m := reRepo.FindStringSubmatch(path)
	if m == nil {
		return deny(DeniedOther)
	}
	rest := m[3]
	body, _ := in.(map[string]any)
	field := func(k string) string { s, _ := body[k].(string); return s }
	switch method {
	case http.MethodGet:
		if reRef.MatchString(rest) || reBranch.MatchString(rest) || reCommit.MatchString(rest) || reContents.MatchString(rest) ||
			rest == "/pulls" || rePull.MatchString(rest) || rest == "/commits" || reCommitPulls.MatchString(rest) {
			return nil
		}
	case http.MethodPost:
		switch {
		case rest == "/git/trees", rest == "/git/commits":
			return nil
		case rest == "/git/refs":
			if ref, ok := strings.CutPrefix(field("ref"), "refs/heads/"); ok && ValidBranch(ref) {
				return nil
			}
			return deny(DeniedRefOutsidePrefix)
		case rest == "/pulls":
			if ValidBranch(field("head")) && field("base") != "" && !strings.HasPrefix(field("base"), BranchPrefix) {
				return nil
			}
			return deny(DeniedRefOutsidePrefix)
		case rePullReviewers.MatchString(rest):
			if _, ok := body["reviewers"]; ok && len(body) == 1 {
				return nil
			}
		}
	case http.MethodPatch:
		// 唯一的修改：关闭 PR
		if rePull.MatchString(rest) && len(body) == 1 && field("state") == "closed" {
			return nil
		}
		if strings.HasPrefix(rest, "/git/refs") {
			return deny(DeniedRefOutsidePrefix)
		}
	case http.MethodDelete, http.MethodPut:
		if strings.HasPrefix(rest, "/git/refs") {
			return deny(DeniedRefOutsidePrefix)
		}
	}
	return deny(DeniedOther)
}

func (a *App) call(ctx context.Context, method, p, auth string, in, out any) error {
	if err := CheckRequest(method, p, in); err != nil {
		if a.OnDenied != nil {
			var d *DeniedError
			if errors.As(err, &d) {
				a.OnDenied(d)
			}
		}
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

// BotLogin 返回 App 在 GitHub 上的机器人账号（<slug>[bot]），它是 App 写入的提交的 author 与 committer。
func (a *App) BotLogin() string { return a.Slug + "[bot]" }

// Event 是补偿控制写入执行审计链的一条记录。
type Event struct {
	// Resource 是 refs、pulls、requested_reviewers 或 request（被拦下的请求）
	Resource string
	// Name 是 owner/name:分支、owner/name#PR 编号，或被拦下的请求的方法与路径
	Name string
	// UID 是相关的提交 SHA
	UID string
	// Verb：push（新建分支引用）、check_base（推送前后核对 base）、create（开 PR）、request_reviewers、denied
	Verb   string
	Detail string
	Err    error
}

// Recorder 接收补偿控制的事件；返回错误时操作中止（审计写不进去就不继续写 Git）。
type Recorder func(ctx context.Context, ev Event) error

// Repo 是一个仓库的客户端。
type Repo struct {
	app         *App
	Owner, Name string
	rec         Recorder
}

// Repo 返回 owner/name 的客户端。
func (a *App) Repo(full string) (*Repo, error) {
	owner, name, ok := strings.Cut(full, "/")
	if !ok {
		return nil, fmt.Errorf("github: repository %q is not owner/name", full)
	}
	return &Repo{app: a, Owner: owner, Name: name}, nil
}

// WithRecorder 返回把事件交给 rec 的客户端副本。
func (r *Repo) WithRecorder(rec Recorder) *Repo {
	c := *r
	c.rec = rec
	return &c
}

// FullName 返回 owner/name。
func (r *Repo) FullName() string { return r.Owner + "/" + r.Name }

func (r *Repo) record(ctx context.Context, ev Event) error {
	if r.rec == nil {
		return nil
	}
	return r.rec(ctx, ev)
}

func (r *Repo) call(ctx context.Context, method, p string, in, out any) error {
	tok, err := r.app.installationToken(ctx)
	if err != nil {
		return err
	}
	err = r.app.call(ctx, method, "/repos/"+url.PathEscape(r.Owner)+"/"+url.PathEscape(r.Name)+p, "Bearer "+tok, in, out)
	var d *DeniedError
	if errors.As(err, &d) {
		if rerr := r.record(ctx, Event{Resource: "request", Name: d.Method + " " + d.Path, Verb: "denied", Detail: d.Reason, Err: err}); rerr != nil {
			return errors.Join(err, rerr)
		}
	}
	return err
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

// Account 是 GitHub 账号。
type Account struct {
	Login string `json:"login"`
	Type  string `json:"type"`
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
	Merged   bool     `json:"merged"`
	MergedAt *string  `json:"merged_at"`
	MergedBy *Account `json:"merged_by"`
}

// HeadIfExists 返回分支的提交 SHA；分支不存在时 ok=false。
func (r *Repo) HeadIfExists(ctx context.Context, branch string) (sha string, ok bool, err error) {
	sha, err = r.Head(ctx, branch)
	var apiErr *APIError
	if errors.As(err, &apiErr) && apiErr.Status == http.StatusNotFound {
		return "", false, nil
	}
	return sha, err == nil, err
}

// ErrBaseMoved 表示 base 分支在推送前后的两次读取之间变化了（或推送前已不是批准时的提交），没有开 PR。
var ErrBaseMoved = errors.New("github: base branch moved")

// PRRequest 是一次开 PR 的请求。
type PRRequest struct {
	Base string
	// BaseSHA 是批准时 base 的提交，补丁在它之上提交
	BaseSHA   string
	Branch    string
	Title     string
	Body      string
	Reviewers []string
	Changes   []FileChange
}

// PRResult 是开出的 PR 与推送的提交。
type PRResult struct {
	PR     PullRequest
	Commit string
}

// OpenPR 在补偿控制下推送并开 PR（ADR 0025）：
//  1. 分支必须是 srenautix/ 下的新分支；
//  2. 推送前读取 base，必须等于批准时的 BaseSHA；
//  3. 在 BaseSHA 之上建树与提交，新建分支引用（只能新建，不能移动已有引用）；
//  4. 推送后再次读取 base 与新分支：base 必须没有变化，新分支必须指向本次提交，否则不开 PR，返回 ErrBaseMoved；
//  5. 开 PR，请求审阅。
//
// 每一步写 Git 或核对的结果都先交给 Recorder；Recorder 失败时中止。
func (r *Repo) OpenPR(ctx context.Context, req PRRequest) (PRResult, error) {
	var res PRResult
	if !ValidBranch(req.Branch) {
		return res, &DeniedError{Method: http.MethodPost, Path: "/git/refs", Reason: DeniedRefOutsidePrefix}
	}
	refName := r.FullName() + ":" + req.Branch
	check := func(stage, before, after string) error {
		var err error
		if before != after {
			err = fmt.Errorf("%w: %s %s was %s, now %s", ErrBaseMoved, stage, req.Base, before, after)
		}
		if rerr := r.record(ctx, Event{Resource: "refs", Name: r.FullName() + ":" + req.Base, UID: after, Verb: "check_base",
			Detail: stage + " " + before + " -> " + after, Err: err}); rerr != nil {
			return errors.Join(err, rerr)
		}
		return err
	}
	before, err := r.Head(ctx, req.Base)
	if err != nil {
		return res, err
	}
	if err := check("before push: approved", req.BaseSHA, before); err != nil {
		return res, err
	}
	var commit struct {
		Tree struct {
			SHA string `json:"sha"`
		} `json:"tree"`
	}
	if err := r.call(ctx, http.MethodGet, "/git/commits/"+url.PathEscape(req.BaseSHA), nil, &commit); err != nil {
		return res, err
	}
	entries := make([]map[string]any, 0, len(req.Changes))
	for _, c := range req.Changes {
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
		return res, err
	}
	var newCommit struct {
		SHA string `json:"sha"`
	}
	if err := r.call(ctx, http.MethodPost, "/git/commits", map[string]any{"message": req.Title, "tree": tree.SHA, "parents": []string{req.BaseSHA}}, &newCommit); err != nil {
		return res, err
	}
	res.Commit = newCommit.SHA
	perr := r.call(ctx, http.MethodPost, "/git/refs", map[string]any{"ref": "refs/heads/" + req.Branch, "sha": newCommit.SHA}, nil)
	if rerr := r.record(ctx, Event{Resource: "refs", Name: refName, UID: newCommit.SHA, Verb: "push", Err: perr}); rerr != nil {
		return res, errors.Join(perr, rerr)
	}
	if perr != nil {
		return res, perr
	}
	after, err := r.Head(ctx, req.Base)
	if err != nil {
		return res, err
	}
	if err := check("after push", before, after); err != nil {
		return res, err
	}
	pushed, err := r.Head(ctx, req.Branch)
	if err != nil {
		return res, err
	}
	if pushed != newCommit.SHA {
		err := fmt.Errorf("github: %s points to %s, pushed %s", req.Branch, pushed, newCommit.SHA)
		if rerr := r.record(ctx, Event{Resource: "refs", Name: refName, UID: pushed, Verb: "check_branch", Err: err}); rerr != nil {
			return res, errors.Join(err, rerr)
		}
		return res, err
	}
	var pr PullRequest
	err = r.call(ctx, http.MethodPost, "/pulls", map[string]any{"title": req.Title, "head": req.Branch, "base": req.Base, "body": req.Body}, &pr)
	if rerr := r.record(ctx, Event{Resource: "pulls", Name: fmt.Sprintf("%s#%d", r.FullName(), pr.Number), UID: newCommit.SHA, Verb: "create",
		Detail: pr.HTMLURL, Err: err}); rerr != nil {
		return res, errors.Join(err, rerr)
	}
	if err != nil {
		return res, err
	}
	res.PR = pr
	if len(req.Reviewers) > 0 {
		err = r.call(ctx, http.MethodPost, fmt.Sprintf("/pulls/%d/requested_reviewers", pr.Number), map[string]any{"reviewers": req.Reviewers}, nil)
		if rerr := r.record(ctx, Event{Resource: "requested_reviewers", Name: fmt.Sprintf("%s#%d", r.FullName(), pr.Number), UID: newCommit.SHA,
			Verb: "request_reviewers", Detail: strings.Join(req.Reviewers, ","), Err: err}); rerr != nil {
			return res, errors.Join(err, rerr)
		}
		if err != nil {
			return res, err
		}
	}
	return res, nil
}

// GetPR 读取一个 PR（含 merged_by）。
func (r *Repo) GetPR(ctx context.Context, number int) (PullRequest, error) {
	var pr PullRequest
	err := r.call(ctx, http.MethodGet, fmt.Sprintf("/pulls/%d", number), nil, &pr)
	return pr, err
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

// ClosePR 关闭 PR（gitops_pr 的撤销）。
func (r *Repo) ClosePR(ctx context.Context, number int) (PullRequest, error) {
	var pr PullRequest
	err := r.call(ctx, http.MethodPatch, fmt.Sprintf("/pulls/%d", number), map[string]any{"state": "closed"}, &pr)
	if rerr := r.record(ctx, Event{Resource: "pulls", Name: fmt.Sprintf("%s#%d", r.FullName(), number), UID: pr.Head.SHA, Verb: "close", Err: err}); rerr != nil {
		return pr, errors.Join(err, rerr)
	}
	return pr, err
}

package testenv

import (
	"bytes"
	"crypto/sha1"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// GitHubRequest 是 GitHub 服务收到的一个 REST 请求（不含 /_test 控制接口）。
type GitHubRequest struct {
	Method string         `json:"method"`
	Path   string         `json:"path"`
	Body   map[string]any `json:"body"`
}

// GitHubAccount 是提交的 author、committer 或 PR 的 merged_by。
type GitHubAccount struct {
	Login string `json:"login"`
	Type  string `json:"type"`
}

// 测试中的身份。
var (
	// Human 是人工推送与人工合并的账号
	Human = GitHubAccount{Login: "octo-human", Type: "User"}
	// WebFlow 是 GitHub 网页合并时的 committer
	WebFlow = GitHubAccount{Login: "web-flow", Type: "User"}
)

// GitHub 是不变量 12 使用的 Git 服务客户端：REST 接口给 gateway 使用，/_test 控制接口给测试驱动场景。
// 设置了 SRENAUTIX_TEST_GITHUB_API 时连接外部服务（Kind 中 platform-ops 的本地 Git 服务，后端是真实的 bare 仓库），
// 否则在进程内启动 FakeGitHub。两者实现同一套 REST 子集与控制接口，测试代码相同。
type GitHub struct {
	URL   string
	Owner string
	Repo  string
	Slug  string
	t     testing.TB
}

// StartGitHub 准备仓库 owner/repo：base 分支只有一个由 Human 写入、内容为 files 的提交，没有分支保护。
func StartGitHub(t testing.TB, owner, repo, slug, base string, files map[string]string) *GitHub {
	t.Helper()
	u := os.Getenv("SRENAUTIX_TEST_GITHUB_API")
	if u == "" {
		srv := httptest.NewServer(NewFakeGitHub())
		t.Cleanup(srv.Close)
		u = srv.URL
	}
	g := &GitHub{URL: strings.TrimRight(u, "/"), Owner: owner, Repo: repo, Slug: slug, t: t}
	g.control(http.MethodPost, "/_test/repos", map[string]any{"owner": owner, "name": repo, "base": base, "files": files, "app_slug": slug}, nil)
	return g
}

// AppBot 返回 App 的机器人账号。
func (g *GitHub) AppBot() GitHubAccount { return GitHubAccount{Login: g.Slug + "[bot]", Type: "Bot"} }

func (g *GitHub) repoPath() string { return "/_test/repos/" + g.Owner + "/" + g.Repo }

func (g *GitHub) control(method, path string, in, out any) {
	g.t.Helper()
	var body io.Reader
	if in != nil {
		b, err := json.Marshal(in)
		if err != nil {
			g.t.Fatal(err)
		}
		body = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, g.URL+path, body)
	if err != nil {
		g.t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		g.t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode/100 != 2 {
		g.t.Fatalf("git service %s %s: HTTP %d %s", method, path, resp.StatusCode, raw)
	}
	if out != nil {
		if err := json.Unmarshal(raw, out); err != nil {
			g.t.Fatalf("git service %s %s: %v", method, path, err)
		}
	}
}

// SetProtected 设置分支是否受分支保护。
func (g *GitHub) SetProtected(branch string, on bool) {
	g.control(http.MethodPut, g.repoPath()+"/branches/"+url.PathEscape(branch)+"/protection", map[string]any{"protected": on}, nil)
}

// Push 以 author、committer 的身份向 branch 直接写一个提交，返回提交 SHA。
func (g *GitHub) Push(branch string, files map[string]string, author, committer GitHubAccount, message string) string {
	var out struct {
		SHA string `json:"sha"`
	}
	g.control(http.MethodPost, g.repoPath()+"/push", map[string]any{"branch": branch, "files": files, "author": author, "committer": committer, "message": message}, &out)
	return out.SHA
}

// Race 让下一次新建 srenautix/ 分支引用成功之后，立即以 Human 的身份向 branch 写一个提交（推送期间 base 前进）。
func (g *GitHub) Race(branch string) {
	g.control(http.MethodPost, g.repoPath()+"/race", map[string]any{"branch": branch}, nil)
}

// Merge 以 mergedBy 合并 PR（method 为 merge 或 squash），返回合并提交。
func (g *GitHub) Merge(number int, mergedBy GitHubAccount, method string) string {
	var out struct {
		SHA string `json:"sha"`
	}
	g.control(http.MethodPost, fmt.Sprintf("%s/pulls/%d/merge", g.repoPath(), number), map[string]any{"merged_by": mergedBy, "method": method}, &out)
	return out.SHA
}

// Requests 返回服务收到的 REST 请求。
func (g *GitHub) Requests() []GitHubRequest {
	var out []GitHubRequest
	g.control(http.MethodGet, "/_test/requests", nil, &out)
	return out
}

// Refs 返回全部分支。
func (g *GitHub) Refs() map[string]string {
	out := map[string]string{}
	g.control(http.MethodGet, g.repoPath()+"/refs", nil, &out)
	return out
}

// Head 返回分支的提交。
func (g *GitHub) Head(branch string) string { return g.Refs()[branch] }

// File 返回某个提交中的文件。
func (g *GitHub) File(commit, path string) (string, bool) {
	g.t.Helper()
	resp, err := http.Get(g.URL + g.repoPath() + "/file?sha=" + url.QueryEscape(commit) + "&path=" + url.QueryEscape(path))
	if err != nil {
		g.t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode == http.StatusNotFound {
		return "", false
	}
	if resp.StatusCode != http.StatusOK {
		g.t.Fatalf("git service file: HTTP %d %s", resp.StatusCode, raw)
	}
	return string(raw), true
}

// ── 进程内实现 ────────────────────────────────────────────────

type fakeCommit struct {
	files     map[string]string
	parents   []string
	author    GitHubAccount
	committer GitHubAccount
	message   string
	at        time.Time
}

type fakePull struct {
	number    int
	head      string
	base      string
	state     string
	headSHA   string
	baseSHA   string
	author    GitHubAccount
	reviewers []string
	merged    bool
	mergedBy  *GitHubAccount
	mergedAt  time.Time
	mergeSHA  string
}

// FakeGitHub 是 GitHub REST API 子集与 /_test 控制接口的进程内实现：一个仓库，内存中的提交、树、分支与 PR。
// 只实现 gateway 白名单中的接口；其余请求（包括合并）返回 404 并记录。
type FakeGitHub struct {
	mu        sync.Mutex
	owner     string
	name      string
	slug      string
	protected map[string]bool
	requests  []GitHubRequest
	commits   map[string]*fakeCommit
	trees     map[string]map[string]string
	refs      map[string]string
	pulls     []*fakePull
	race      string
	seq       int
}

// NewFakeGitHub 创建空的服务；用 POST /_test/repos 建仓库。
func NewFakeGitHub() *FakeGitHub { return &FakeGitHub{} }

func sha(s string) string {
	h := sha1.Sum([]byte(s))
	return hex.EncodeToString(h[:])
}

func (g *FakeGitHub) write(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func (g *FakeGitHub) bot() GitHubAccount { return GitHubAccount{Login: g.slug + "[bot]", Type: "Bot"} }

func (g *FakeGitHub) newCommit(files map[string]string, parents []string, author, committer GitHubAccount, message string) string {
	g.seq++
	id := sha(fmt.Sprint("commit", g.seq, message, time.Now().UnixNano()))
	g.commits[id] = &fakeCommit{files: files, parents: parents, author: author, committer: committer, message: message, at: time.Now().UTC()}
	return id
}

func copyFiles(in map[string]string) map[string]string {
	out := map[string]string{}
	for k, v := range in {
		out[k] = v
	}
	return out
}

// ServeHTTP 处理 REST 与 /_test 请求。
func (g *FakeGitHub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	if r.Body != nil && r.ContentLength != 0 {
		_ = json.NewDecoder(r.Body).Decode(&body)
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if strings.HasPrefix(r.URL.Path, "/_test/") {
		g.control(w, r, body)
		return
	}
	g.requests = append(g.requests, GitHubRequest{Method: r.Method, Path: r.URL.Path, Body: body})
	g.rest(w, r, body)
}

func account(v any) GitHubAccount {
	m, _ := v.(map[string]any)
	login, _ := m["login"].(string)
	typ, _ := m["type"].(string)
	return GitHubAccount{Login: login, Type: typ}
}

func stringFiles(v any) map[string]string {
	out := map[string]string{}
	m, _ := v.(map[string]any)
	for k, val := range m {
		s, _ := val.(string)
		out[k] = s
	}
	return out
}

func (g *FakeGitHub) control(w http.ResponseWriter, r *http.Request, body map[string]any) {
	p := r.URL.Path
	if r.Method == http.MethodPost && p == "/_test/repos" {
		g.owner, _ = body["owner"].(string)
		g.name, _ = body["name"].(string)
		g.slug, _ = body["app_slug"].(string)
		base, _ := body["base"].(string)
		g.protected, g.commits, g.trees, g.refs, g.pulls, g.requests, g.race = map[string]bool{}, map[string]*fakeCommit{},
			map[string]map[string]string{}, map[string]string{}, nil, nil, ""
		g.refs[base] = g.newCommit(stringFiles(body["files"]), nil, Human, Human, "initial")
		g.write(w, 201, map[string]any{})
		return
	}
	if r.Method == http.MethodGet && p == "/_test/requests" {
		out := g.requests
		if out == nil {
			out = []GitHubRequest{}
		}
		g.write(w, 200, out)
		return
	}
	rest, ok := strings.CutPrefix(p, "/_test/repos/"+g.owner+"/"+g.name)
	if !ok {
		g.write(w, 404, map[string]any{"message": "no such repository"})
		return
	}
	switch {
	case r.Method == http.MethodPut && strings.HasPrefix(rest, "/branches/") && strings.HasSuffix(rest, "/protection"):
		b, _ := url.PathUnescape(strings.TrimSuffix(strings.TrimPrefix(rest, "/branches/"), "/protection"))
		on, _ := body["protected"].(bool)
		g.protected[b] = on
		g.write(w, 200, map[string]any{})
	case r.Method == http.MethodPost && rest == "/push":
		b, _ := body["branch"].(string)
		msg, _ := body["message"].(string)
		head := g.refs[b]
		files := map[string]string{}
		if c, ok := g.commits[head]; ok {
			files = copyFiles(c.files)
		}
		for k, v := range stringFiles(body["files"]) {
			files[k] = v
		}
		var parents []string
		if head != "" {
			parents = []string{head}
		}
		id := g.newCommit(files, parents, account(body["author"]), account(body["committer"]), msg)
		g.refs[b] = id
		g.write(w, 201, map[string]any{"sha": id})
	case r.Method == http.MethodPost && rest == "/race":
		g.race, _ = body["branch"].(string)
		g.write(w, 200, map[string]any{})
	case r.Method == http.MethodPost && strings.HasPrefix(rest, "/pulls/") && strings.HasSuffix(rest, "/merge"):
		n, _ := strconv.Atoi(strings.TrimSuffix(strings.TrimPrefix(rest, "/pulls/"), "/merge"))
		if n < 1 || n > len(g.pulls) || g.pulls[n-1].state != "open" {
			g.write(w, 422, map[string]any{"message": "pull request is not open"})
			return
		}
		pr := g.pulls[n-1]
		by := account(body["merged_by"])
		files := copyFiles(g.commits[pr.headSHA].files)
		baseHead := g.refs[pr.base]
		var id string
		if m, _ := body["method"].(string); m == "squash" {
			id = g.newCommit(files, []string{baseHead}, pr.author, WebFlow, fmt.Sprintf("squash #%d", n))
		} else {
			id = g.newCommit(files, []string{baseHead, pr.headSHA}, by, WebFlow, fmt.Sprintf("Merge pull request #%d", n))
		}
		g.refs[pr.base] = id
		pr.state, pr.merged, pr.mergedBy, pr.mergedAt, pr.mergeSHA = "closed", true, &by, time.Now().UTC(), id
		g.write(w, 200, map[string]any{"sha": id})
	case r.Method == http.MethodGet && rest == "/refs":
		g.write(w, 200, g.refs)
	case r.Method == http.MethodGet && rest == "/file":
		c, ok := g.commits[r.URL.Query().Get("sha")]
		if !ok {
			http.NotFound(w, r)
			return
		}
		v, ok := c.files[r.URL.Query().Get("path")]
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.WriteHeader(200)
		_, _ = io.WriteString(w, v)
	default:
		g.write(w, 404, map[string]any{"message": "unknown control request"})
	}
}

func (g *FakeGitHub) pullJSON(pr *fakePull) map[string]any {
	out := map[string]any{"number": pr.number, "state": pr.state, "merged": pr.merged, "merged_at": nil, "merged_by": nil,
		"html_url": fmt.Sprintf("https://github.example/%s/%s/pull/%d", g.owner, g.name, pr.number),
		"head":     map[string]any{"ref": pr.head, "sha": pr.headSHA}, "base": map[string]any{"ref": pr.base},
		"user": pr.author, "requested_reviewers": pr.reviewers}
	if pr.merged {
		out["merged_at"] = pr.mergedAt.Format(time.RFC3339)
		out["merged_by"] = pr.mergedBy
	}
	return out
}

// prCommits 返回 PR 的提交：从 head 沿第一个父提交走到 base 被开 PR 时的提交（不含）。
func (g *FakeGitHub) prCommits(pr *fakePull) map[string]bool {
	out := map[string]bool{}
	for s := pr.headSHA; s != "" && s != pr.baseSHA; {
		out[s] = true
		c := g.commits[s]
		if c == nil || len(c.parents) == 0 {
			break
		}
		s = c.parents[0]
	}
	if pr.mergeSHA != "" {
		out[pr.mergeSHA] = true
	}
	return out
}

func (g *FakeGitHub) rest(w http.ResponseWriter, r *http.Request, body map[string]any) {
	p := r.URL.Path
	auth := r.Header.Get("Authorization")
	switch {
	case r.Method == http.MethodGet && p == "/app" && strings.HasPrefix(auth, "Bearer "):
		g.write(w, 200, map[string]any{"slug": g.slug})
		return
	case r.Method == http.MethodPost && strings.HasPrefix(p, "/app/installations/") && strings.HasSuffix(p, "/access_tokens") && strings.HasPrefix(auth, "Bearer "):
		g.write(w, 201, map[string]any{"token": "installation-token", "expires_at": time.Now().Add(time.Hour).UTC().Format(time.RFC3339)})
		return
	}
	rest, ok := strings.CutPrefix(p, "/repos/"+g.owner+"/"+g.name)
	if !ok || auth != "Bearer installation-token" {
		g.write(w, 404, map[string]any{"message": "Not Found"})
		return
	}
	q := r.URL.Query()
	switch {
	case r.Method == http.MethodGet && strings.HasPrefix(rest, "/git/ref/heads/"):
		b, _ := url.PathUnescape(strings.TrimPrefix(rest, "/git/ref/heads/"))
		if s, ok := g.refs[b]; ok {
			g.write(w, 200, map[string]any{"object": map[string]any{"sha": s}})
			return
		}
	case r.Method == http.MethodGet && strings.HasPrefix(rest, "/branches/"):
		b, _ := url.PathUnescape(strings.TrimPrefix(rest, "/branches/"))
		if _, ok := g.refs[b]; ok {
			g.write(w, 200, map[string]any{"name": b, "protected": g.protected[b]})
			return
		}
	case r.Method == http.MethodGet && strings.HasPrefix(rest, "/contents/"):
		path := strings.TrimPrefix(rest, "/contents/")
		if c, ok := g.commits[q.Get("ref")]; ok {
			if v, ok := c.files[path]; ok {
				g.write(w, 200, map[string]any{"type": "file", "encoding": "base64", "content": base64.StdEncoding.EncodeToString([]byte(v)), "sha": sha(v)})
				return
			}
		}
	case r.Method == http.MethodGet && strings.HasPrefix(rest, "/git/commits/"):
		s := strings.TrimPrefix(rest, "/git/commits/")
		if _, ok := g.commits[s]; ok {
			g.trees["tree-"+s] = g.commits[s].files
			g.write(w, 200, map[string]any{"sha": s, "tree": map[string]any{"sha": "tree-" + s}})
			return
		}
	case r.Method == http.MethodPost && rest == "/git/trees":
		baseTree, _ := body["base_tree"].(string)
		files := copyFiles(g.trees[baseTree])
		entries, _ := body["tree"].([]any)
		for _, e := range entries {
			m, _ := e.(map[string]any)
			path, _ := m["path"].(string)
			if content, ok := m["content"].(string); ok {
				files[path] = content
			} else {
				delete(files, path)
			}
		}
		id := sha(fmt.Sprint("tree", files))
		g.trees[id] = files
		g.write(w, 201, map[string]any{"sha": id})
		return
	case r.Method == http.MethodPost && rest == "/git/commits":
		tree, _ := body["tree"].(string)
		files, ok := g.trees[tree]
		if ok {
			var parents []string
			for _, v := range body["parents"].([]any) {
				s, _ := v.(string)
				parents = append(parents, s)
			}
			msg, _ := body["message"].(string)
			id := g.newCommit(copyFiles(files), parents, g.bot(), g.bot(), msg)
			g.write(w, 201, map[string]any{"sha": id})
			return
		}
	case r.Method == http.MethodPost && rest == "/git/refs":
		ref, _ := body["ref"].(string)
		s, _ := body["sha"].(string)
		b := strings.TrimPrefix(ref, "refs/heads/")
		if _, exists := g.refs[b]; exists {
			g.write(w, 422, map[string]any{"message": "Reference already exists"})
			return
		}
		g.refs[b] = s
		if g.race != "" && strings.HasPrefix(b, "srenautix/") {
			// 推送期间有人向 base 推送
			base := g.race
			g.race = ""
			files := copyFiles(g.commits[g.refs[base]].files)
			files["RACE"] = "pushed during the gateway push\n"
			g.refs[base] = g.newCommit(files, []string{g.refs[base]}, Human, Human, "concurrent push")
		}
		g.write(w, 201, map[string]any{"ref": ref, "object": map[string]any{"sha": s}})
		return
	case r.Method == http.MethodPost && rest == "/pulls":
		head, _ := body["head"].(string)
		base, _ := body["base"].(string)
		if _, ok := g.refs[head]; !ok {
			g.write(w, 422, map[string]any{"message": "head does not exist"})
			return
		}
		pr := &fakePull{number: len(g.pulls) + 1, head: head, base: base, state: "open", headSHA: g.refs[head], baseSHA: g.refs[base], author: g.bot(),
			reviewers: []string{}}
		g.pulls = append(g.pulls, pr)
		g.write(w, 201, g.pullJSON(pr))
		return
	case r.Method == http.MethodGet && rest == "/pulls":
		out := []any{}
		for i := len(g.pulls) - 1; i >= 0; i-- {
			if g.owner+":"+g.pulls[i].head == q.Get("head") {
				out = append(out, g.pullJSON(g.pulls[i]))
			}
		}
		g.write(w, 200, out)
		return
	case strings.HasPrefix(rest, "/pulls/"):
		tail := strings.TrimPrefix(rest, "/pulls/")
		num, sub, _ := strings.Cut(tail, "/")
		n, err := strconv.Atoi(num)
		if err != nil || n < 1 || n > len(g.pulls) {
			break
		}
		pr := g.pulls[n-1]
		switch {
		case r.Method == http.MethodGet && sub == "":
			g.write(w, 200, g.pullJSON(pr))
			return
		case r.Method == http.MethodPatch && sub == "":
			if st, _ := body["state"].(string); st == "closed" && !pr.merged {
				pr.state = "closed"
			}
			g.write(w, 200, g.pullJSON(pr))
			return
		case r.Method == http.MethodPost && sub == "requested_reviewers":
			for _, v := range body["reviewers"].([]any) {
				s, _ := v.(string)
				pr.reviewers = append(pr.reviewers, s)
			}
			g.write(w, 201, g.pullJSON(pr))
			return
		}
	case r.Method == http.MethodGet && rest == "/commits":
		since, _ := time.Parse(time.RFC3339, q.Get("since"))
		out := []any{}
		for s := g.refs[q.Get("sha")]; s != "" && len(out) < 100; {
			c := g.commits[s]
			if c == nil || c.at.Before(since) {
				break
			}
			out = append(out, map[string]any{"sha": s, "author": c.author, "committer": c.committer,
				"commit": map[string]any{"message": c.message, "committer": map[string]any{"date": c.at.Format(time.RFC3339)}}})
			if len(c.parents) == 0 {
				break
			}
			s = c.parents[0]
		}
		g.write(w, 200, out)
		return
	case r.Method == http.MethodGet && strings.HasPrefix(rest, "/commits/") && strings.HasSuffix(rest, "/pulls"):
		s := strings.TrimSuffix(strings.TrimPrefix(rest, "/commits/"), "/pulls")
		out := []any{}
		for _, pr := range g.pulls {
			if g.prCommits(pr)[s] {
				out = append(out, g.pullJSON(pr))
			}
		}
		g.write(w, 200, out)
		return
	}
	g.write(w, 404, map[string]any{"message": "Not Found"})
}

// SortedBranches 返回分支名，按字母排序。
func SortedBranches(refs map[string]string) []string {
	out := make([]string, 0, len(refs))
	for k := range refs {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

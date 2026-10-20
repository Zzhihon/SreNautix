package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	ghapp "github.com/Zzhihon/SreNautix/internal/spoke/gateway/github"
)

// 用 gateway 真实的 GitHub 客户端（internal/spoke/gateway/github）对 gitlocal 走一遍 gitops_pr 的全部调用，
// 再覆盖 server 侧的 issue、评论、提交列表，以及 git smart HTTP 与 /_test 接口。
type env struct {
	t     *testing.T
	srv   *httptest.Server
	key   *rsa.PrivateKey
	admin string
	s     *server
}

func newEnv(t *testing.T) *env {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Fatalf("git is required: %v", err)
	}
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	seed := filepath.Join(dir, "seed")
	for p, c := range map[string]string{
		"apps/shop/release.json":                 `{"data":{"image":"registry.local/shop@sha256:` + strings.Repeat("a", 64) + `","release_id":"r1"}}` + "\n",
		"platform/observability/rules/shop.yaml": "groups: []\n",
	} {
		if err := os.MkdirAll(filepath.Dir(filepath.Join(seed, p)), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(seed, p), []byte(c), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	s, err := newServer(config{DataDir: filepath.Join(dir, "data"), PublicURL: "http://gitlocal.test", AppID: "42", InstallationID: "7",
		AppSlug: "srenautix-kind", AppPublicKey: &key.PublicKey, AdminToken: "admin-secret", TestAPI: true})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.seed("kind/gitops", seed); err != nil {
		t.Fatal(err)
	}
	e := &env{t: t, srv: httptest.NewServer(s), key: key, admin: "admin-secret", s: s}
	t.Cleanup(e.srv.Close)
	return e
}

func (e *env) do(method, path, token string, in, out any) int {
	e.t.Helper()
	var body io.Reader
	if in != nil {
		b, _ := json.Marshal(in)
		body = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, e.srv.URL+path, body)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if out != nil && len(raw) > 0 {
		if err := json.Unmarshal(raw, out); err != nil {
			e.t.Fatalf("%s %s: %v: %s", method, path, err, raw)
		}
	}
	return resp.StatusCode
}

func (e *env) app() *ghapp.App {
	a, err := ghapp.New("42", "7", "srenautix-kind", e.key, e.srv.URL, 10*time.Second)
	if err != nil {
		e.t.Fatal(err)
	}
	return a
}

func TestGatewayGitopsFlow(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	repo, err := e.app().Repo("kind/gitops")
	if err != nil {
		t.Fatal(err)
	}
	base, err := repo.Head(ctx, "main")
	if err != nil {
		t.Fatal(err)
	}
	if prot, err := repo.Protected(ctx, "main"); err != nil || prot {
		t.Fatalf("protected = %v, %v", prot, err)
	}
	content, ok, err := repo.FileAt(ctx, base, "apps/shop/release.json")
	if err != nil || !ok || !strings.Contains(string(content), "release_id") {
		t.Fatalf("FileAt: %v %v %s", ok, err, content)
	}
	if _, ok, err := repo.FileAt(ctx, base, "missing.yaml"); err != nil || ok {
		t.Fatalf("missing file: %v %v", ok, err)
	}
	res, err := repo.OpenPR(ctx, ghapp.PRRequest{Base: "main", BaseSHA: base, Branch: "srenautix/rollback-shop",
		Title: "Roll back shop", Body: "body", Reviewers: []string{"kind-operator"},
		Changes: []ghapp.FileChange{{Path: "apps/shop/release.json", Content: []byte(`{"data":{"release_id":"r0"}}` + "\n")},
			{Path: "platform/observability/rules/shop.yaml", Delete: true}}})
	if err != nil {
		t.Fatal(err)
	}
	pr, sha := res.PR, res.Commit
	if pr.Number != 1 || pr.State != "open" || pr.Head.Ref != "srenautix/rollback-shop" || pr.Head.SHA != sha {
		t.Fatalf("pr = %+v", pr)
	}
	var got struct {
		RequestedReviewers []person `json:"requested_reviewers"`
	}
	e.do("GET", "/repos/kind/gitops/pulls/1", e.installationToken(), nil, &got)
	if len(got.RequestedReviewers) != 1 || got.RequestedReviewers[0].Login != "kind-operator" {
		t.Fatalf("requested reviewers = %+v", got.RequestedReviewers)
	}
	found, ok, err := repo.FindPR(ctx, "srenautix/rollback-shop")
	if err != nil || !ok || found.Number != pr.Number {
		t.Fatalf("FindPR: %+v %v %v", found, ok, err)
	}
	// 分支上的文件已改，main 不变
	if got, _, _ := repo.FileAt(ctx, sha, "apps/shop/release.json"); !strings.Contains(string(got), "r0") {
		t.Fatalf("branch content = %s", got)
	}
	if _, ok, _ := repo.FileAt(ctx, sha, "platform/observability/rules/shop.yaml"); ok {
		t.Fatal("deleted file still present on the branch")
	}
	if now, _ := repo.Head(ctx, "main"); now != base {
		t.Fatal("main moved")
	}
	var diff []string
	e.do("GET", "/_test/repos/kind/gitops/diff?base=main&head=srenautix/rollback-shop", "", nil, &diff)
	if strings.Join(diff, ",") != "apps/shop/release.json,platform/observability/rules/shop.yaml" {
		t.Fatalf("diff = %v", diff)
	}
	// 同名分支再次创建：422
	if _, err := repo.OpenPR(ctx, ghapp.PRRequest{Base: "main", BaseSHA: base, Branch: "srenautix/rollback-shop", Title: "again",
		Changes: []ghapp.FileChange{{Path: "x", Content: []byte("x")}}}); err == nil {
		t.Fatal("creating an existing branch must fail")
	}
	closed, err := repo.ClosePR(ctx, pr.Number)
	if err != nil || closed.State != "closed" {
		t.Fatalf("ClosePR: %+v %v", closed, err)
	}
	// 提交的作者与提交者都是 App 机器人
	var commits []struct {
		SHA       string `json:"sha"`
		Author    person `json:"author"`
		Committer person `json:"committer"`
	}
	tok := e.installationToken()
	if code := e.do("GET", "/repos/kind/gitops/commits?sha=srenautix/rollback-shop&per_page=100", tok, nil, &commits); code != 200 {
		t.Fatalf("commits: %d", code)
	}
	if len(commits) != 2 || commits[0].Author != (person{Login: "srenautix-kind[bot]", Type: "Bot"}) ||
		commits[0].Committer != commits[0].Author || commits[1].Author.Type != "User" {
		t.Fatalf("commits = %+v", commits)
	}
	// 审计：机器人只创建了 srenautix/* 分支，没有改 main
	for _, a := range e.state().Audit {
		if a.Bot && (a.Ref == "refs/heads/main" || (a.Kind == "ref_update" && !strings.HasPrefix(a.Ref, "refs/heads/srenautix/"))) {
			t.Fatalf("bot changed %s", a.Ref)
		}
	}
}

func (e *env) installationToken() string {
	e.t.Helper()
	jwt, err := ghapp.SignJWT(e.key, "42", time.Now())
	if err != nil {
		e.t.Fatal(err)
	}
	var out struct {
		Token string `json:"token"`
	}
	if code := e.do("POST", "/app/installations/7/access_tokens", jwt, nil, &out); code != 201 || out.Token == "" {
		e.t.Fatalf("access token: %d", code)
	}
	return out.Token
}

func (e *env) state() persisted {
	e.t.Helper()
	var st persisted
	if code := e.do("GET", "/_test/state", "", nil, &st); code != 200 {
		e.t.Fatalf("state: %d", code)
	}
	return st
}

func TestJWTChecks(t *testing.T) {
	e := newEnv(t)
	other, _ := rsa.GenerateKey(rand.Reader, 2048)
	bad, _ := ghapp.SignJWT(other, "42", time.Now())
	if code := e.do("GET", "/app", bad, nil, nil); code != 401 {
		t.Fatalf("JWT signed by another key: %d", code)
	}
	wrongIss, _ := ghapp.SignJWT(e.key, "43", time.Now())
	if code := e.do("GET", "/app", wrongIss, nil, nil); code != 401 {
		t.Fatalf("JWT for another App: %d", code)
	}
	if code := e.do("GET", "/repos/kind/gitops/branches/main", "not-a-token", nil, nil); code != 401 {
		t.Fatalf("unknown token: %d", code)
	}
	var app struct {
		Slug string `json:"slug"`
	}
	good, _ := ghapp.SignJWT(e.key, "42", time.Now())
	if code := e.do("GET", "/app", good, nil, &app); code != 200 || app.Slug != "srenautix-kind" {
		t.Fatalf("GET /app: %d %+v", code, app)
	}
}

func TestIssuesCommentsAndPullLinks(t *testing.T) {
	e := newEnv(t)
	tok := e.installationToken()
	var issue struct {
		Number  int    `json:"number"`
		HTMLURL string `json:"html_url"`
	}
	if code := e.do("POST", "/repos/kind/gitops/issues", tok, map[string]any{"title": "[影子] shop", "body": "x", "labels": []string{"srenautix"}}, &issue); code != 201 {
		t.Fatalf("create issue: %d", code)
	}
	if issue.HTMLURL != "http://gitlocal.test/kind/gitops/issues/1" {
		t.Fatalf("html_url = %s", issue.HTMLURL)
	}
	if code := e.do("POST", "/repos/kind/gitops/issues/1/comments", tok, map[string]any{"body": "<!-- srenautix:pr-link=u -->"}, nil); code != 201 {
		t.Fatalf("comment: %d", code)
	}
	var comments []struct {
		Body string `json:"body"`
		User person `json:"user"`
	}
	e.do("GET", "/repos/kind/gitops/issues/1/comments?per_page=100", tok, nil, &comments)
	if len(comments) != 1 || comments[0].User.Type != "Bot" {
		t.Fatalf("comments = %+v", comments)
	}
	var list []struct {
		Number int `json:"number"`
	}
	e.do("GET", "/repos/kind/gitops/issues?labels=srenautix&state=all&sort=created&direction=desc&per_page=50", tok, nil, &list)
	if len(list) != 1 {
		t.Fatalf("issues = %+v", list)
	}
	e.do("GET", "/repos/kind/gitops/issues?labels=other&state=all", tok, nil, &list)
	if len(list) != 0 {
		t.Fatalf("label filter: %+v", list)
	}
	// PR 描述补 Refs（server 侧）
	ref := e.mustHead(tok, "main")
	e.do("POST", "/repos/kind/gitops/git/refs", tok, map[string]any{"ref": "refs/heads/srenautix/x", "sha": ref}, nil)
	var pr struct {
		Number int `json:"number"`
	}
	e.do("POST", "/repos/kind/gitops/pulls", tok, map[string]any{"title": "t", "head": "srenautix/x", "base": "main", "body": "b"}, &pr)
	if code := e.do("PATCH", "/repos/kind/gitops/pulls/2", tok, map[string]any{"body": "b\n\nRefs #1"}, nil); code != 200 {
		t.Fatalf("patch body: %d", code)
	}
	var got struct {
		Body   string `json:"body"`
		Merged bool   `json:"merged"`
	}
	e.do("GET", "/repos/kind/gitops/pulls/2", tok, nil, &got)
	if got.Body != "b\n\nRefs #1" || got.Merged {
		t.Fatalf("pull = %+v", got)
	}
	if code := e.do("POST", "/repos/kind/gitops/pulls/2/requested_reviewers", tok, map[string]any{"reviewers": []string{"Zzhihon"}}, nil); code != 201 {
		t.Fatalf("requested_reviewers: %d", code)
	}
	// REST 合并被拒绝并记入审计
	if code := e.do("PUT", "/repos/kind/gitops/pulls/2/merge", tok, map[string]any{}, nil); code != 405 {
		t.Fatalf("merge: %d", code)
	}
	attempts := 0
	for _, a := range e.state().Audit {
		if a.Kind == "merge_attempt" {
			attempts++
		}
	}
	if attempts != 1 {
		t.Fatalf("merge attempts = %d", attempts)
	}
}

func (e *env) mustHead(tok, branch string) string {
	var ref struct {
		Object struct {
			SHA string `json:"sha"`
		} `json:"object"`
	}
	if code := e.do("GET", "/repos/kind/gitops/git/ref/heads/"+branch, tok, nil, &ref); code != 200 {
		e.t.Fatalf("ref %s: %d", branch, code)
	}
	return ref.Object.SHA
}

func TestContentsPutAndCommitFiles(t *testing.T) {
	e := newEnv(t)
	var file struct {
		SHA string `json:"sha"`
	}
	e.do("GET", "/repos/kind/gitops/contents/apps/shop/release.json", e.admin, nil, &file)
	put := map[string]any{"message": "Release r2", "content": base64.StdEncoding.EncodeToString([]byte("r2\n")), "branch": "main"}
	if code := e.do("PUT", "/repos/kind/gitops/contents/apps/shop/release.json", e.admin, put, nil); code != 422 {
		t.Fatalf("missing sha: %d", code)
	}
	put["sha"] = "0000000000000000000000000000000000000000"
	if code := e.do("PUT", "/repos/kind/gitops/contents/apps/shop/release.json", e.admin, put, nil); code != 409 {
		t.Fatalf("stale sha: %d", code)
	}
	put["sha"] = file.SHA
	var out struct {
		Commit struct {
			SHA string `json:"sha"`
		} `json:"commit"`
	}
	if code := e.do("PUT", "/repos/kind/gitops/contents/apps/shop/release.json", e.admin, put, &out); code != 200 {
		t.Fatalf("update: %d", code)
	}
	var c struct {
		Author person `json:"author"`
		Files  []struct {
			Filename string `json:"filename"`
			Status   string `json:"status"`
		} `json:"files"`
	}
	e.do("GET", "/repos/kind/gitops/commits/"+out.Commit.SHA, e.admin, nil, &c)
	if c.Author != (person{Login: "kind-operator", Type: "User"}) || len(c.Files) != 1 || c.Files[0].Filename != "apps/shop/release.json" || c.Files[0].Status != "modified" {
		t.Fatalf("commit = %+v", c)
	}
	var since []struct {
		SHA string `json:"sha"`
	}
	e.do("GET", "/repos/kind/gitops/commits?sha=main&since="+time.Now().Add(-time.Minute).UTC().Format(time.RFC3339)+"&per_page=100", e.admin, nil, &since)
	if len(since) != 2 {
		t.Fatalf("commits since = %+v", since)
	}
}

func TestTestAPIMergeRaceAndProtection(t *testing.T) {
	e := newEnv(t)
	tok := e.installationToken()
	if code := e.do("PUT", "/_test/repos/kind/gitops/branches/main/protection", "", map[string]any{"protected": true}, nil); code != 204 {
		t.Fatalf("protection: %d", code)
	}
	var b struct {
		Protected bool `json:"protected"`
	}
	e.do("GET", "/repos/kind/gitops/branches/main", tok, nil, &b)
	if !b.Protected {
		t.Fatal("branch not protected")
	}
	base := e.mustHead(tok, "main")
	e.do("POST", "/_test/repos/kind/gitops/race", "", map[string]any{"branch": "main"}, nil)
	e.do("POST", "/repos/kind/gitops/git/refs", tok, map[string]any{"ref": "refs/heads/srenautix/race", "sha": base}, nil)
	if after := e.mustHead(tok, "main"); after == base {
		t.Fatal("race hook did not advance main")
	}
	e.do("POST", "/repos/kind/gitops/pulls", tok, map[string]any{"title": "t", "head": "srenautix/race", "base": "main"}, nil)
	var merged struct {
		SHA string `json:"sha"`
	}
	if code := e.do("POST", "/_test/repos/kind/gitops/pulls/1/merge", "", map[string]any{"merged_by": person{Login: "Zzhihon", Type: "User"}, "method": "merge"}, &merged); code != 200 {
		t.Fatalf("merge: %d", code)
	}
	var c struct {
		Author    person `json:"author"`
		Committer person `json:"committer"`
	}
	e.do("GET", "/repos/kind/gitops/commits/"+merged.SHA, tok, nil, &c)
	if c.Author.Login != "Zzhihon" || c.Committer.Login != "web-flow" {
		t.Fatalf("merge commit = %+v", c)
	}
	var pulls []struct {
		Number int `json:"number"`
	}
	e.do("GET", "/repos/kind/gitops/commits/"+merged.SHA+"/pulls", tok, nil, &pulls)
	if len(pulls) != 1 || pulls[0].Number != 1 {
		t.Fatalf("commit pulls = %+v", pulls)
	}
	var pr struct {
		Merged   bool   `json:"merged"`
		MergedBy person `json:"merged_by"`
	}
	e.do("GET", "/repos/kind/gitops/pulls/1", tok, nil, &pr)
	if !pr.Merged || pr.MergedBy.Login != "Zzhihon" {
		t.Fatalf("pull = %+v", pr)
	}
	var reqs []requestRecord
	e.do("GET", "/_test/requests", "", nil, &reqs)
	if len(reqs) == 0 || strings.HasPrefix(reqs[0].Path, "/_test") {
		t.Fatalf("requests = %+v", reqs)
	}
}

func TestSmartHTTPCloneAndPush(t *testing.T) {
	e := newEnv(t)
	dir := t.TempDir()
	run := func(args ...string) string {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0", "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
		return string(out)
	}
	run("clone", "--quiet", e.srv.URL+"/kind/gitops.git", "repo")
	if _, err := os.Stat(filepath.Join(dir, "repo/apps/shop/release.json")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "repo/x.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("-C", "repo", "add", "x.txt")
	run("-C", "repo", "commit", "--quiet", "-m", "x")
	// 没有认证的推送被拒绝
	cmd := exec.Command("git", "-C", filepath.Join(dir, "repo"), "push", "--quiet", "origin", "main")
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	if out, err := cmd.CombinedOutput(); err == nil {
		t.Fatalf("anonymous push succeeded: %s", out)
	}
	pushURL := strings.Replace(e.srv.URL, "http://", "http://op:admin-secret@", 1) + "/kind/gitops.git"
	run("-C", "repo", "push", "--quiet", pushURL, "main")
	pushed := false
	for _, a := range e.state().Audit {
		if a.Ref == "refs/heads/main" && a.Actor == "kind-operator" && !a.Bot && a.Old != zeroSHA {
			pushed = true
		}
	}
	if !pushed {
		t.Fatal("push not audited")
	}
}

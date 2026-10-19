package testenv

import (
	"crypto/sha1"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// GitHubRequest 是 GitHub 服务收到的一个请求。
type GitHubRequest struct {
	Method string
	Path   string
	Body   map[string]any
}

// GitHub 是一个 GitHub REST API 子集的服务端实现（不变量 12 的 Git 服务器）：一个仓库、内存中的提交、树、分支与 PR，
// 记录收到的每个请求。只实现 gateway 白名单中的接口；其余请求（包括合并）返回 404 并记录。
type GitHub struct {
	Server    *httptest.Server
	Owner     string
	Repo      string
	Slug      string
	protected map[string]bool

	mu       sync.Mutex
	requests []GitHubRequest
	commits  map[string]ghCommit
	refs     map[string]string // 分支 → 提交 SHA
	pulls    []ghPull
}

type ghCommit struct {
	files map[string]string
}

type ghPull struct {
	Number int
	Head   string
	Base   string
	State  string
	SHA    string
}

func sha(s string) string {
	h := sha1.Sum([]byte(s))
	return hex.EncodeToString(h[:])
}

// StartGitHub 启动服务，base 分支的初始文件为 files。
func StartGitHub(t testing.TB, owner, repo, slug, base string, files map[string]string) *GitHub {
	t.Helper()
	g := &GitHub{Owner: owner, Repo: repo, Slug: slug, protected: map[string]bool{}, commits: map[string]ghCommit{}, refs: map[string]string{}}
	root := sha(fmt.Sprint(time.Now().UnixNano(), files))
	g.commits[root] = ghCommit{files: files}
	g.refs[base] = root
	g.Server = httptest.NewServer(http.HandlerFunc(g.serve))
	t.Cleanup(g.Server.Close)
	return g
}

// SetProtected 设置分支是否受分支保护。
func (g *GitHub) SetProtected(branch string, on bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.protected[branch] = on
}

// Requests 返回收到的请求。
func (g *GitHub) Requests() []GitHubRequest {
	g.mu.Lock()
	defer g.mu.Unlock()
	return append([]GitHubRequest(nil), g.requests...)
}

// Refs 返回全部分支。
func (g *GitHub) Refs() map[string]string {
	g.mu.Lock()
	defer g.mu.Unlock()
	out := map[string]string{}
	for k, v := range g.refs {
		out[k] = v
	}
	return out
}

// Head 返回分支的提交。
func (g *GitHub) Head(branch string) string {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.refs[branch]
}

// File 返回某个提交中的文件。
func (g *GitHub) File(commit, path string) (string, bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	c, ok := g.commits[commit]
	if !ok {
		return "", false
	}
	v, ok := c.files[path]
	return v, ok
}

func (g *GitHub) write(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func (g *GitHub) serve(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	if r.Body != nil && r.ContentLength != 0 {
		_ = json.NewDecoder(r.Body).Decode(&body)
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	g.requests = append(g.requests, GitHubRequest{Method: r.Method, Path: r.URL.Path, Body: body})
	p := r.URL.Path
	switch {
	case r.Method == http.MethodGet && p == "/app":
		g.write(w, 200, map[string]any{"slug": g.Slug})
		return
	case r.Method == http.MethodPost && strings.HasPrefix(p, "/app/installations/") && strings.HasSuffix(p, "/access_tokens"):
		g.write(w, 201, map[string]any{"token": "installation-token", "expires_at": time.Now().Add(time.Hour).UTC().Format(time.RFC3339)})
		return
	}
	prefix := "/repos/" + g.Owner + "/" + g.Repo
	rest, ok := strings.CutPrefix(p, prefix)
	if !ok || r.Header.Get("Authorization") != "Bearer installation-token" {
		g.write(w, 404, map[string]any{"message": "Not Found"})
		return
	}
	switch {
	case r.Method == http.MethodGet && strings.HasPrefix(rest, "/git/ref/heads/"):
		b := strings.TrimPrefix(rest, "/git/ref/heads/")
		if s, ok := g.refs[b]; ok {
			g.write(w, 200, map[string]any{"object": map[string]any{"sha": s}})
			return
		}
	case r.Method == http.MethodGet && strings.HasPrefix(rest, "/branches/"):
		b := strings.TrimPrefix(rest, "/branches/")
		if _, ok := g.refs[b]; ok {
			g.write(w, 200, map[string]any{"name": b, "protected": g.protected[b]})
			return
		}
	case r.Method == http.MethodGet && strings.HasPrefix(rest, "/contents/"):
		path := strings.TrimPrefix(rest, "/contents/")
		c, ok := g.commits[r.URL.Query().Get("ref")]
		if ok {
			if v, ok := c.files[path]; ok {
				g.write(w, 200, map[string]any{"type": "file", "encoding": "base64", "content": base64.StdEncoding.EncodeToString([]byte(v)), "sha": sha(v)})
				return
			}
		}
	case r.Method == http.MethodGet && strings.HasPrefix(rest, "/git/commits/"):
		s := strings.TrimPrefix(rest, "/git/commits/")
		if _, ok := g.commits[s]; ok {
			g.write(w, 200, map[string]any{"sha": s, "tree": map[string]any{"sha": "tree-" + s}})
			return
		}
	case r.Method == http.MethodPost && rest == "/git/trees":
		baseTree, _ := body["base_tree"].(string)
		base := g.commits[strings.TrimPrefix(baseTree, "tree-")]
		files := map[string]string{}
		for k, v := range base.files {
			files[k] = v
		}
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
		g.commits["pending-"+id] = ghCommit{files: files}
		g.write(w, 201, map[string]any{"sha": id})
		return
	case r.Method == http.MethodPost && rest == "/git/commits":
		tree, _ := body["tree"].(string)
		c, ok := g.commits["pending-"+tree]
		if ok {
			id := sha(fmt.Sprint("commit", tree, body["message"]))
			g.commits[id] = c
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
		g.write(w, 201, map[string]any{"ref": ref})
		return
	case r.Method == http.MethodPost && rest == "/pulls":
		head, _ := body["head"].(string)
		base, _ := body["base"].(string)
		pr := ghPull{Number: len(g.pulls) + 1, Head: head, Base: base, State: "open", SHA: g.refs[head]}
		g.pulls = append(g.pulls, pr)
		g.write(w, 201, g.pullJSON(pr))
		return
	case r.Method == http.MethodGet && rest == "/pulls":
		var out []any
		head := r.URL.Query().Get("head")
		for _, pr := range g.pulls {
			if g.Owner+":"+pr.Head == head {
				out = append(out, g.pullJSON(pr))
			}
		}
		if out == nil {
			out = []any{}
		}
		g.write(w, 200, out)
		return
	}
	g.write(w, 404, map[string]any{"message": "Not Found"})
}

func (g *GitHub) pullJSON(pr ghPull) map[string]any {
	return map[string]any{"number": pr.Number, "state": pr.State,
		"html_url": fmt.Sprintf("%s/%s/%s/pull/%d", g.Server.URL, g.Owner, g.Repo, pr.Number),
		"head":     map[string]any{"ref": pr.Head, "sha": pr.SHA}}
}

package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

var (
	reRepoPath = regexp.MustCompile(`^/repos/([A-Za-z0-9-]+)/([A-Za-z0-9._-]+)(/.*)?$`)
	reNumber   = regexp.MustCompile(`^[0-9]+$`)
	reSHA      = regexp.MustCompile(`^[0-9a-f]{40}$`)
)

// readBody 读取 JSON 请求体，同时记入请求日志。
func (s *server) readBody(r *http.Request, out any) ([]byte, error) {
	raw, err := io.ReadAll(io.LimitReader(r.Body, 32<<20))
	if err != nil {
		return nil, err
	}
	if len(raw) > 0 && out != nil {
		if err := json.Unmarshal(raw, out); err != nil {
			return raw, fmt.Errorf("Problems parsing JSON: %w", err)
		}
	}
	return raw, nil
}

func (s *server) logRequest(r *http.Request, body []byte) {
	rec := requestRecord{Method: r.Method, Path: r.URL.RequestURI()}
	if len(body) > 0 && json.Valid(body) {
		rec.Body = body
	}
	s.mu.Lock()
	s.requests = append(s.requests, rec)
	if len(s.requests) > 5000 {
		s.requests = s.requests[len(s.requests)-5000:]
	}
	s.mu.Unlock()
}

func (s *server) htmlURL(full, kind string, n int) string {
	return fmt.Sprintf("%s/%s/%s/%d", strings.TrimRight(s.cfg.PublicURL, "/"), full, kind, n)
}

func userJSON(login string) map[string]any {
	if login == "" {
		return nil
	}
	return map[string]any{"login": login, "type": identityOf(login).userType()}
}

// repoRoutes 实现 /repos/{owner}/{name}/… 的 GitHub REST 子集。
func (s *server) repoRoutes(w http.ResponseWriter, r *http.Request) {
	m := reRepoPath.FindStringSubmatch(r.URL.Path)
	if m == nil {
		fail(w, http.StatusNotFound, "Not Found")
		return
	}
	full, rest := m[1]+"/"+m[2], m[3]
	body, err := s.readBody(r, nil)
	s.logRequest(r, body)
	if err != nil {
		fail(w, http.StatusBadRequest, err.Error())
		return
	}
	who, ok := s.caller(r)
	if !ok {
		fail(w, http.StatusUnauthorized, "Bad credentials")
		return
	}
	repo, ok := s.repo(full)
	if !ok {
		fail(w, http.StatusNotFound, "Not Found")
		return
	}
	h := &repoHandler{s: s, w: w, r: r, full: full, repo: repo, who: who, body: body}
	s.mu.Lock()
	defer s.mu.Unlock()
	h.route(rest)
}

type repoHandler struct {
	s    *server
	w    http.ResponseWriter
	r    *http.Request
	full string
	repo gitRepo
	who  identity
	body []byte
}

func (h *repoHandler) decode(out any) bool {
	if len(h.body) == 0 {
		fail(h.w, http.StatusBadRequest, "Problems parsing JSON")
		return false
	}
	if err := json.Unmarshal(h.body, out); err != nil {
		fail(h.w, http.StatusBadRequest, "Problems parsing JSON")
		return false
	}
	return true
}

func (h *repoHandler) internal(err error) {
	fail(h.w, http.StatusInternalServerError, err.Error())
}

func (h *repoHandler) route(rest string) {
	method := h.r.Method
	seg := strings.Split(strings.Trim(rest, "/"), "/")
	if rest == "" || rest == "/" {
		if method == http.MethodGet {
			writeJSON(h.w, http.StatusOK, map[string]any{"full_name": h.full, "name": path.Base(h.full),
				"default_branch": "main", "private": false, "html_url": strings.TrimRight(h.s.cfg.PublicURL, "/") + "/" + h.full})
			return
		}
	}
	switch {
	case method == http.MethodGet && len(seg) >= 4 && seg[0] == "git" && seg[1] == "ref" && seg[2] == "heads":
		h.getRef(strings.Join(seg[3:], "/"))
	case method == http.MethodPost && rest == "/git/refs":
		h.createRef()
	case method == http.MethodPatch && len(seg) >= 4 && seg[0] == "git" && seg[1] == "refs" && seg[2] == "heads":
		h.updateRef(strings.Join(seg[3:], "/"))
	case method == http.MethodDelete && len(seg) >= 4 && seg[0] == "git" && seg[1] == "refs" && seg[2] == "heads":
		h.deleteRef(strings.Join(seg[3:], "/"))
	case method == http.MethodGet && len(seg) >= 2 && seg[0] == "branches":
		h.getBranch(strings.Join(seg[1:], "/"))
	case len(seg) >= 1 && seg[0] == "contents":
		p, err := url.PathUnescape(strings.Join(seg[1:], "/"))
		if err != nil {
			fail(h.w, http.StatusBadRequest, err.Error())
			return
		}
		switch method {
		case http.MethodGet:
			h.getContents(p)
		case http.MethodPut:
			h.putContents(p)
		default:
			fail(h.w, http.StatusMethodNotAllowed, "Method not allowed")
		}
	case method == http.MethodGet && len(seg) == 3 && seg[0] == "git" && seg[1] == "commits":
		h.getGitCommit(seg[2])
	case method == http.MethodPost && rest == "/git/commits":
		h.createGitCommit()
	case method == http.MethodPost && rest == "/git/trees":
		h.createTree()
	case method == http.MethodGet && rest == "/commits":
		h.listCommits()
	case method == http.MethodGet && len(seg) == 2 && seg[0] == "commits":
		h.getCommit(seg[1])
	case method == http.MethodGet && len(seg) == 3 && seg[0] == "commits" && seg[2] == "pulls":
		h.commitPulls(seg[1])
	case rest == "/pulls" && method == http.MethodPost:
		h.createPull()
	case rest == "/pulls" && method == http.MethodGet:
		h.listPulls()
	case len(seg) == 2 && seg[0] == "pulls" && reNumber.MatchString(seg[1]):
		n, _ := strconv.Atoi(seg[1])
		switch method {
		case http.MethodGet:
			h.getPull(n)
		case http.MethodPatch:
			h.patchItem(n, true)
		default:
			fail(h.w, http.StatusMethodNotAllowed, "Method not allowed")
		}
	case len(seg) == 3 && seg[0] == "pulls" && reNumber.MatchString(seg[1]) && seg[2] == "requested_reviewers" && method == http.MethodPost:
		n, _ := strconv.Atoi(seg[1])
		h.requestReviewers(n)
	case len(seg) == 3 && seg[0] == "pulls" && reNumber.MatchString(seg[1]) && seg[2] == "merge":
		n, _ := strconv.Atoi(seg[1])
		h.s.audit(auditEntry{Repo: h.full, Kind: "merge_attempt", Number: n, Actor: h.who.Login, Bot: h.who.Bot})
		_ = h.s.save()
		fail(h.w, http.StatusMethodNotAllowed, "Merging through the API is disabled on gitlocal")
	case rest == "/issues" && method == http.MethodPost:
		h.createIssue()
	case rest == "/issues" && method == http.MethodGet:
		h.listIssues()
	case len(seg) == 2 && seg[0] == "issues" && reNumber.MatchString(seg[1]):
		n, _ := strconv.Atoi(seg[1])
		switch method {
		case http.MethodGet:
			h.getIssue(n)
		case http.MethodPatch:
			h.patchItem(n, false)
		default:
			fail(h.w, http.StatusMethodNotAllowed, "Method not allowed")
		}
	case len(seg) == 3 && seg[0] == "issues" && reNumber.MatchString(seg[1]) && seg[2] == "comments":
		n, _ := strconv.Atoi(seg[1])
		switch method {
		case http.MethodGet:
			h.listComments(n)
		case http.MethodPost:
			h.createComment(n)
		default:
			fail(h.w, http.StatusMethodNotAllowed, "Method not allowed")
		}
	default:
		fail(h.w, http.StatusNotFound, "Not Found")
	}
}

// ---- 引用与分支 ----

func refJSON(ref, sha string) map[string]any {
	return map[string]any{"ref": ref, "object": map[string]any{"sha": sha, "type": "commit"}}
}

func (h *repoHandler) getRef(branch string) {
	sha, ok, err := h.repo.resolve(branchRef(branch))
	if err != nil {
		h.internal(err)
		return
	}
	if !ok {
		fail(h.w, http.StatusNotFound, "Not Found")
		return
	}
	writeJSON(h.w, http.StatusOK, refJSON(branchRef(branch), sha))
}

// setRef 原子地修改引用并写入审计；/_test/race 在这里推进 base。
func (h *repoHandler) setRef(ref, newSHA, oldSHA string) error {
	if err := h.repo.updateRef(ref, newSHA, oldSHA); err != nil {
		return err
	}
	h.s.audit(auditEntry{Repo: h.full, Kind: "ref_update", Ref: ref, Old: oldSHA, New: newSHA, Actor: h.who.Login, Bot: h.who.Bot})
	st := h.s.repoState(h.full)
	if st.RaceBranch != "" && oldSHA == zeroSHA && strings.HasPrefix(ref, "refs/heads/srenautix/") {
		branch := st.RaceBranch
		st.RaceBranch = ""
		if _, err := h.s.pushFiles(h.full, h.repo, branch, map[string]*string{".race": ptr(h.s.cfg.Now().UTC().Format(time.RFC3339Nano))},
			identity{Login: h.s.cfg.AdminLogin}, identity{Login: h.s.cfg.AdminLogin}, "Advance "+branch+" during a push"); err != nil {
			return err
		}
	}
	return h.s.save()
}

func ptr[T any](v T) *T { return &v }

func (h *repoHandler) createRef() {
	var in struct {
		Ref string `json:"ref"`
		SHA string `json:"sha"`
	}
	if !h.decode(&in) {
		return
	}
	if !strings.HasPrefix(in.Ref, "refs/heads/") || !reSHA.MatchString(in.SHA) || h.repo.objectType(in.SHA) != "commit" {
		fail(h.w, http.StatusUnprocessableEntity, "Reference update failed")
		return
	}
	if _, exists, _ := h.repo.resolve(in.Ref); exists {
		fail(h.w, http.StatusUnprocessableEntity, "Reference already exists")
		return
	}
	if err := h.setRef(in.Ref, in.SHA, zeroSHA); err != nil {
		fail(h.w, http.StatusUnprocessableEntity, "Reference update failed: "+err.Error())
		return
	}
	writeJSON(h.w, http.StatusCreated, refJSON(in.Ref, in.SHA))
}

func (h *repoHandler) updateRef(branch string) {
	var in struct {
		SHA   string `json:"sha"`
		Force bool   `json:"force"`
	}
	if !h.decode(&in) {
		return
	}
	ref := branchRef(branch)
	old, ok, err := h.repo.resolve(ref)
	if err != nil {
		h.internal(err)
		return
	}
	if !ok {
		fail(h.w, http.StatusUnprocessableEntity, "Reference does not exist")
		return
	}
	if h.repo.objectType(in.SHA) != "commit" || (!in.Force && !h.repo.isAncestor(old, in.SHA)) {
		fail(h.w, http.StatusUnprocessableEntity, "Update is not a fast forward")
		return
	}
	if err := h.setRef(ref, in.SHA, old); err != nil {
		h.internal(err)
		return
	}
	writeJSON(h.w, http.StatusOK, refJSON(ref, in.SHA))
}

func (h *repoHandler) deleteRef(branch string) {
	ref := branchRef(branch)
	old, ok, err := h.repo.resolve(ref)
	if err != nil {
		h.internal(err)
		return
	}
	if !ok {
		fail(h.w, http.StatusUnprocessableEntity, "Reference does not exist")
		return
	}
	if err := h.setRef(ref, zeroSHA, old); err != nil {
		h.internal(err)
		return
	}
	h.w.WriteHeader(http.StatusNoContent)
}

func (h *repoHandler) getBranch(branch string) {
	branch, _ = url.PathUnescape(branch)
	sha, ok, err := h.repo.resolve(branchRef(branch))
	if err != nil {
		h.internal(err)
		return
	}
	if !ok {
		fail(h.w, http.StatusNotFound, "Branch not found")
		return
	}
	protected := h.s.repoState(h.full).Protected[branch]
	writeJSON(h.w, http.StatusOK, map[string]any{"name": branch, "commit": map[string]any{"sha": sha}, "protected": protected})
}

// ---- 文件内容 ----

// commitFor 解析 ?ref=（分支、提交 SHA，默认 main）。
func (h *repoHandler) commitFor(ref string) (string, bool) {
	if ref == "" {
		ref = "main"
	}
	if reSHA.MatchString(ref) {
		if h.repo.objectType(ref) == "commit" {
			return ref, true
		}
		return "", false
	}
	sha, ok, err := h.repo.resolve(branchRef(ref))
	if err != nil || !ok {
		return "", false
	}
	return sha, true
}

func (h *repoHandler) getContents(p string) {
	commit, ok := h.commitFor(h.r.URL.Query().Get("ref"))
	if !ok {
		fail(h.w, http.StatusNotFound, "No commit found for the ref")
		return
	}
	content, sha, ok, err := h.repo.blob(commit, p)
	if err != nil {
		h.internal(err)
		return
	}
	if ok {
		writeJSON(h.w, http.StatusOK, map[string]any{"type": "file", "encoding": "base64", "name": path.Base(p), "path": p,
			"sha": sha, "size": len(content), "content": base64.StdEncoding.EncodeToString(content)})
		return
	}
	entries, ok, err := h.repo.listTree(commit, p)
	if err != nil {
		h.internal(err)
		return
	}
	if !ok {
		fail(h.w, http.StatusNotFound, "Not Found")
		return
	}
	list := make([]map[string]any, 0, len(entries))
	for _, e := range entries {
		t := "file"
		if e.Type == "tree" {
			t = "dir"
		}
		list = append(list, map[string]any{"type": t, "name": e.Name, "path": strings.TrimPrefix(path.Join(p, e.Name), "/"), "sha": e.SHA})
	}
	writeJSON(h.w, http.StatusOK, list)
}

func (h *repoHandler) putContents(p string) {
	var in struct {
		Message string `json:"message"`
		Content string `json:"content"`
		SHA     string `json:"sha"`
		Branch  string `json:"branch"`
	}
	if !h.decode(&in) {
		return
	}
	content, err := base64.StdEncoding.DecodeString(in.Content)
	if err != nil {
		fail(h.w, http.StatusUnprocessableEntity, "content is not valid Base64")
		return
	}
	branch := in.Branch
	if branch == "" {
		branch = "main"
	}
	head, ok, err := h.repo.resolve(branchRef(branch))
	if err != nil {
		h.internal(err)
		return
	}
	if !ok {
		fail(h.w, http.StatusNotFound, "Branch "+branch+" not found")
		return
	}
	_, existing, exists, err := h.repo.blob(head, p)
	if err != nil {
		h.internal(err)
		return
	}
	switch {
	case exists && in.SHA == "":
		fail(h.w, http.StatusUnprocessableEntity, `Invalid request. "sha" wasn't supplied.`)
		return
	case exists && in.SHA != existing:
		fail(h.w, http.StatusConflict, p+" does not match "+in.SHA)
		return
	}
	sha, err := h.s.pushFiles(h.full, h.repo, branch, map[string]*string{p: ptr(string(content))}, h.who, h.who, in.Message)
	if err != nil {
		h.internal(err)
		return
	}
	_, blobSHA, _, _ := h.repo.blob(sha, p)
	status := http.StatusOK
	if !exists {
		status = http.StatusCreated
	}
	writeJSON(h.w, status, map[string]any{
		"content": map[string]any{"name": path.Base(p), "path": p, "sha": blobSHA},
		"commit":  map[string]any{"sha": sha, "message": in.Message},
	})
	_ = h.s.save()
}

// pushFiles 在 branch 上提交文件改动（值为 nil 时删除）并推进分支，写入审计；调用方持有锁。
func (s *server) pushFiles(full string, repo gitRepo, branch string, files map[string]*string, author, committer identity, message string) (string, error) {
	ref := branchRef(branch)
	head, exists, err := repo.resolve(ref)
	if err != nil {
		return "", err
	}
	var baseTree string
	var parents []string
	old := zeroSHA
	if exists {
		info, _, err := repo.commit(head)
		if err != nil {
			return "", err
		}
		baseTree, parents, old = info.Tree, []string{head}, head
	}
	paths := make([]string, 0, len(files))
	for p := range files {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	changes := make([]treeChange, 0, len(files))
	for _, p := range paths {
		if files[p] == nil {
			changes = append(changes, treeChange{Path: p, Delete: true})
		} else {
			changes = append(changes, treeChange{Path: p, Content: []byte(*files[p])})
		}
	}
	tree, err := repo.writeTree(baseTree, changes)
	if err != nil {
		return "", err
	}
	if message == "" {
		message = "Update " + strings.Join(paths, ", ")
	}
	sha, err := repo.commitTreeAs(tree, parents, message, author, committer, s.cfg.Now())
	if err != nil {
		return "", err
	}
	if err := repo.updateRef(ref, sha, old); err != nil {
		return "", err
	}
	s.audit(auditEntry{Repo: full, Kind: "ref_update", Ref: ref, Old: old, New: sha, Actor: committer.Login, Bot: committer.Bot})
	return sha, nil
}

// ---- Git Data ----

func (h *repoHandler) gitCommitJSON(c commitInfo) map[string]any {
	parents := make([]map[string]any, 0, len(c.Parents))
	for _, p := range c.Parents {
		parents = append(parents, map[string]any{"sha": p})
	}
	return map[string]any{
		"sha":       c.SHA,
		"tree":      map[string]any{"sha": c.Tree},
		"parents":   parents,
		"message":   c.Message,
		"author":    map[string]any{"name": c.AuthorName, "email": c.AuthorEmail, "date": c.AuthorDate.Format(time.RFC3339)},
		"committer": map[string]any{"name": c.CommitterName, "email": c.CommitterEmail, "date": c.CommitterDate.Format(time.RFC3339)},
	}
}

func (h *repoHandler) getGitCommit(sha string) {
	c, ok, err := h.repo.commit(sha)
	if err != nil {
		h.internal(err)
		return
	}
	if !ok {
		fail(h.w, http.StatusNotFound, "Not Found")
		return
	}
	writeJSON(h.w, http.StatusOK, h.gitCommitJSON(c))
}

func (h *repoHandler) createTree() {
	var in struct {
		BaseTree string `json:"base_tree"`
		Tree     []struct {
			Path    string          `json:"path"`
			Mode    string          `json:"mode"`
			Type    string          `json:"type"`
			Content *string         `json:"content"`
			SHA     json.RawMessage `json:"sha"`
		} `json:"tree"`
	}
	if !h.decode(&in) {
		return
	}
	if in.BaseTree != "" && h.repo.objectType(in.BaseTree) != "tree" {
		fail(h.w, http.StatusUnprocessableEntity, "base_tree is not a valid tree")
		return
	}
	changes := make([]treeChange, 0, len(in.Tree))
	for _, e := range in.Tree {
		if e.Path == "" || strings.HasPrefix(e.Path, "/") || strings.Contains(e.Path, "..") || (e.Type != "" && e.Type != "blob") {
			fail(h.w, http.StatusUnprocessableEntity, "tree entry is invalid: "+e.Path)
			return
		}
		sha := strings.TrimSpace(string(e.SHA))
		switch {
		case e.Content != nil:
			changes = append(changes, treeChange{Path: e.Path, Mode: e.Mode, Content: []byte(*e.Content)})
		case sha == "null":
			changes = append(changes, treeChange{Path: e.Path, Delete: true})
		case sha != "":
			var s string
			if err := json.Unmarshal(e.SHA, &s); err != nil || h.repo.objectType(s) != "blob" {
				fail(h.w, http.StatusUnprocessableEntity, "tree.sha is not a blob")
				return
			}
			changes = append(changes, treeChange{Path: e.Path, Mode: e.Mode, SHA: s})
		default:
			fail(h.w, http.StatusUnprocessableEntity, "tree entry needs content or sha: "+e.Path)
			return
		}
	}
	tree, err := h.repo.writeTree(in.BaseTree, changes)
	if err != nil {
		h.internal(err)
		return
	}
	writeJSON(h.w, http.StatusCreated, map[string]any{"sha": tree, "url": ""})
}

func (h *repoHandler) createGitCommit() {
	var in struct {
		Message string   `json:"message"`
		Tree    string   `json:"tree"`
		Parents []string `json:"parents"`
	}
	if !h.decode(&in) {
		return
	}
	if h.repo.objectType(in.Tree) != "tree" {
		fail(h.w, http.StatusUnprocessableEntity, "Tree SHA does not exist")
		return
	}
	for _, p := range in.Parents {
		if h.repo.objectType(p) != "commit" {
			fail(h.w, http.StatusUnprocessableEntity, "Parent SHA does not exist or is not a commit object")
			return
		}
	}
	// 与 GitHub 相同：不带 author、committer 时两者都是调用方（App 的安装令牌即 <slug>[bot]）
	sha, err := h.repo.commitTree(in.Tree, in.Parents, in.Message, h.who, h.s.cfg.Now())
	if err != nil {
		h.internal(err)
		return
	}
	c, _, err := h.repo.commit(sha)
	if err != nil {
		h.internal(err)
		return
	}
	writeJSON(h.w, http.StatusCreated, h.gitCommitJSON(c))
}

// ---- 提交列表（变更源与 main watchdog） ----

func (h *repoHandler) commitJSON(c commitInfo, withFiles bool) (map[string]any, error) {
	parents := make([]map[string]any, 0, len(c.Parents))
	for _, p := range c.Parents {
		parents = append(parents, map[string]any{"sha": p})
	}
	out := map[string]any{
		"sha":      c.SHA,
		"html_url": strings.TrimRight(h.s.cfg.PublicURL, "/") + "/" + h.full + "/commit/" + c.SHA,
		"commit": map[string]any{
			"message":   c.Message,
			"tree":      map[string]any{"sha": c.Tree},
			"author":    map[string]any{"name": c.AuthorName, "email": c.AuthorEmail, "date": c.AuthorDate.Format(time.RFC3339)},
			"committer": map[string]any{"name": c.CommitterName, "email": c.CommitterEmail, "date": c.CommitterDate.Format(time.RFC3339)},
		},
		"author":    userJSON(c.AuthorName),
		"committer": userJSON(c.CommitterName),
		"parents":   parents,
	}
	if withFiles {
		files, err := h.repo.files(c.SHA)
		if err != nil {
			return nil, err
		}
		list := make([]map[string]any, 0, len(files))
		for _, f := range files {
			e := map[string]any{"filename": f.Filename, "status": f.Status}
			if f.Previous != "" {
				e["previous_filename"] = f.Previous
			}
			list = append(list, e)
		}
		out["files"] = list
	}
	return out, nil
}

func queryInt(q url.Values, k string, def, max int) int {
	v, err := strconv.Atoi(q.Get(k))
	if err != nil || v < 1 {
		return def
	}
	if v > max {
		return max
	}
	return v
}

func parseTime(q url.Values, k string) (*time.Time, error) {
	v := q.Get(k)
	if v == "" {
		return nil, nil
	}
	t, err := time.Parse(time.RFC3339, v)
	if err != nil {
		return nil, err
	}
	return &t, nil
}

func (h *repoHandler) listCommits() {
	q := h.r.URL.Query()
	commit, ok := h.commitFor(q.Get("sha"))
	if !ok {
		fail(h.w, http.StatusNotFound, "No commit found for SHA: "+q.Get("sha"))
		return
	}
	since, err := parseTime(q, "since")
	if err != nil {
		fail(h.w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	until, err := parseTime(q, "until")
	if err != nil {
		fail(h.w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	per := queryInt(q, "per_page", 30, 100)
	page := queryInt(q, "page", 1, 1000)
	list, err := h.repo.logRange(commit, q.Get("path"), since, until, (page-1)*per, per)
	if err != nil {
		h.internal(err)
		return
	}
	out := make([]map[string]any, 0, len(list))
	for _, c := range list {
		j, err := h.commitJSON(c, false)
		if err != nil {
			h.internal(err)
			return
		}
		out = append(out, j)
	}
	writeJSON(h.w, http.StatusOK, out)
}

func (h *repoHandler) getCommit(ref string) {
	commit, ok := h.commitFor(ref)
	if !ok {
		fail(h.w, http.StatusNotFound, "No commit found for SHA: "+ref)
		return
	}
	c, _, err := h.repo.commit(commit)
	if err != nil {
		h.internal(err)
		return
	}
	j, err := h.commitJSON(c, true)
	if err != nil {
		h.internal(err)
		return
	}
	writeJSON(h.w, http.StatusOK, j)
}

// commitPulls 返回与提交关联的 PR：提交是 PR 的 head，或是合并 PR 产生的提交。
func (h *repoHandler) commitPulls(sha string) {
	out := []map[string]any{}
	for _, it := range h.s.repoState(h.full).Items {
		if it.IsPR && (it.HeadSHA == sha || it.MergeCommitSHA == sha) {
			out = append(out, h.pullJSON(it))
		}
	}
	writeJSON(h.w, http.StatusOK, out)
}

// ---- PR ----

func (h *repoHandler) find(n int, pr bool) *item {
	for _, it := range h.s.repoState(h.full).Items {
		if it.Number == n && (!pr || it.IsPR) {
			return it
		}
	}
	return nil
}

func (h *repoHandler) pullJSON(it *item) map[string]any {
	reviewers := make([]map[string]any, 0, len(it.Reviewers))
	for _, r := range it.Reviewers {
		reviewers = append(reviewers, userJSON(r))
	}
	out := map[string]any{
		"number":              it.Number,
		"html_url":            h.s.htmlURL(h.full, "pull", it.Number),
		"state":               it.State,
		"title":               it.Title,
		"body":                it.Body,
		"user":                userJSON(it.User),
		"head":                map[string]any{"ref": it.Head, "sha": it.HeadSHA, "label": strings.Split(h.full, "/")[0] + ":" + it.Head},
		"base":                map[string]any{"ref": it.Base},
		"requested_reviewers": reviewers,
		"created_at":          it.CreatedAt.Format(time.RFC3339),
		"updated_at":          it.UpdatedAt.Format(time.RFC3339),
		"merged":              it.Merged,
		"merged_at":           nil,
		"merged_by":           nil,
		"merge_commit_sha":    nil,
	}
	if it.Merged {
		out["merged_at"] = it.MergedAt.Format(time.RFC3339)
		out["merged_by"] = userJSON(it.MergedBy)
		out["merge_commit_sha"] = it.MergeCommitSHA
	}
	return out
}

func (h *repoHandler) createPull() {
	var in struct {
		Title string `json:"title"`
		Head  string `json:"head"`
		Base  string `json:"base"`
		Body  string `json:"body"`
	}
	if !h.decode(&in) {
		return
	}
	head := in.Head
	if owner, b, ok := strings.Cut(head, ":"); ok && owner == strings.Split(h.full, "/")[0] {
		head = b
	}
	headSHA, ok, _ := h.repo.resolve(branchRef(head))
	if !ok {
		fail(h.w, http.StatusUnprocessableEntity, "Validation Failed: head "+head+" does not exist")
		return
	}
	if _, ok, _ := h.repo.resolve(branchRef(in.Base)); !ok || in.Base == head {
		fail(h.w, http.StatusUnprocessableEntity, "Validation Failed: invalid base "+in.Base)
		return
	}
	st := h.s.repoState(h.full)
	for _, it := range st.Items {
		if it.IsPR && it.State == "open" && it.Head == head && it.Base == in.Base {
			fail(h.w, http.StatusUnprocessableEntity, "A pull request already exists for "+head)
			return
		}
	}
	now := h.s.cfg.Now().UTC()
	it := &item{Number: st.NextNumber, IsPR: true, Title: in.Title, Body: in.Body, State: "open", User: h.who.Login,
		Head: head, Base: in.Base, HeadSHA: headSHA, CreatedAt: now, UpdatedAt: now}
	st.NextNumber++
	st.Items = append(st.Items, it)
	h.s.audit(auditEntry{Repo: h.full, Kind: "pull_request", Number: it.Number, Ref: branchRef(head), New: headSHA, Actor: h.who.Login, Bot: h.who.Bot})
	if err := h.s.save(); err != nil {
		h.internal(err)
		return
	}
	writeJSON(h.w, http.StatusCreated, h.pullJSON(it))
}

func (h *repoHandler) listPulls() {
	q := h.r.URL.Query()
	state := q.Get("state")
	if state == "" {
		state = "open"
	}
	head := q.Get("head")
	if _, b, ok := strings.Cut(head, ":"); ok {
		head = b
	}
	items := h.s.repoState(h.full).Items
	out := []map[string]any{}
	for i := len(items) - 1; i >= 0; i-- {
		it := items[i]
		if !it.IsPR || (state != "all" && it.State != state) || (head != "" && it.Head != head) ||
			(q.Get("base") != "" && it.Base != q.Get("base")) {
			continue
		}
		out = append(out, h.pullJSON(it))
	}
	writeJSON(h.w, http.StatusOK, out)
}

func (h *repoHandler) getPull(n int) {
	it := h.find(n, true)
	if it == nil {
		fail(h.w, http.StatusNotFound, "Not Found")
		return
	}
	writeJSON(h.w, http.StatusOK, h.pullJSON(it))
}

func (h *repoHandler) requestReviewers(n int) {
	it := h.find(n, true)
	if it == nil {
		fail(h.w, http.StatusNotFound, "Not Found")
		return
	}
	var in struct {
		Reviewers []string `json:"reviewers"`
	}
	if !h.decode(&in) {
		return
	}
	for _, r := range in.Reviewers {
		if r == it.User {
			fail(h.w, http.StatusUnprocessableEntity, "Review cannot be requested from pull request author.")
			return
		}
	}
	it.Reviewers = append(it.Reviewers, in.Reviewers...)
	it.UpdatedAt = h.s.cfg.Now().UTC()
	if err := h.s.save(); err != nil {
		h.internal(err)
		return
	}
	writeJSON(h.w, http.StatusCreated, h.pullJSON(it))
}

// patchItem 修改 issue 或 PR 的标题、正文、状态（PR 的合并不经这里）。
func (h *repoHandler) patchItem(n int, pr bool) {
	it := h.find(n, pr)
	if it == nil {
		fail(h.w, http.StatusNotFound, "Not Found")
		return
	}
	var in struct {
		Title  *string   `json:"title"`
		Body   *string   `json:"body"`
		State  *string   `json:"state"`
		Labels *[]string `json:"labels"`
	}
	if !h.decode(&in) {
		return
	}
	if in.Title != nil {
		it.Title = *in.Title
	}
	if in.Body != nil {
		it.Body = *in.Body
	}
	if in.State != nil {
		if *in.State != "open" && *in.State != "closed" {
			fail(h.w, http.StatusUnprocessableEntity, "state must be open or closed")
			return
		}
		if it.Merged && *in.State == "open" {
			fail(h.w, http.StatusUnprocessableEntity, "Cannot reopen a merged pull request")
			return
		}
		it.State = *in.State
	}
	if in.Labels != nil {
		it.Labels = *in.Labels
	}
	it.UpdatedAt = h.s.cfg.Now().UTC()
	if err := h.s.save(); err != nil {
		h.internal(err)
		return
	}
	if it.IsPR && pr {
		writeJSON(h.w, http.StatusOK, h.pullJSON(it))
		return
	}
	writeJSON(h.w, http.StatusOK, h.issueJSON(it))
}

// ---- issue 与评论 ----

func (h *repoHandler) issueJSON(it *item) map[string]any {
	labels := make([]map[string]any, 0, len(it.Labels))
	for _, l := range it.Labels {
		labels = append(labels, map[string]any{"name": l})
	}
	kind := "issues"
	if it.IsPR {
		kind = "pull"
	}
	out := map[string]any{
		"number":     it.Number,
		"html_url":   h.s.htmlURL(h.full, kind, it.Number),
		"state":      it.State,
		"title":      it.Title,
		"body":       it.Body,
		"labels":     labels,
		"user":       userJSON(it.User),
		"comments":   len(h.s.repoState(h.full).Comments[it.Number]),
		"created_at": it.CreatedAt.Format(time.RFC3339),
		"updated_at": it.UpdatedAt.Format(time.RFC3339),
	}
	if it.IsPR {
		out["pull_request"] = map[string]any{"html_url": h.s.htmlURL(h.full, "pull", it.Number)}
	}
	return out
}

func (h *repoHandler) createIssue() {
	var in struct {
		Title  string   `json:"title"`
		Body   string   `json:"body"`
		Labels []string `json:"labels"`
	}
	if !h.decode(&in) {
		return
	}
	if in.Title == "" {
		fail(h.w, http.StatusUnprocessableEntity, "Validation Failed: title is missing")
		return
	}
	st := h.s.repoState(h.full)
	now := h.s.cfg.Now().UTC()
	it := &item{Number: st.NextNumber, Title: in.Title, Body: in.Body, State: "open", Labels: in.Labels, User: h.who.Login, CreatedAt: now, UpdatedAt: now}
	st.NextNumber++
	st.Items = append(st.Items, it)
	h.s.audit(auditEntry{Repo: h.full, Kind: "issue", Number: it.Number, Actor: h.who.Login, Bot: h.who.Bot})
	if err := h.s.save(); err != nil {
		h.internal(err)
		return
	}
	writeJSON(h.w, http.StatusCreated, h.issueJSON(it))
}

func (h *repoHandler) listIssues() {
	q := h.r.URL.Query()
	state := q.Get("state")
	if state == "" {
		state = "open"
	}
	var want []string
	if l := q.Get("labels"); l != "" {
		want = strings.Split(l, ",")
	}
	items := append([]*item(nil), h.s.repoState(h.full).Items...)
	asc := q.Get("direction") == "asc"
	sort.SliceStable(items, func(i, j int) bool {
		if asc {
			return items[i].Number < items[j].Number
		}
		return items[i].Number > items[j].Number
	})
	var filtered []*item
	for _, it := range items {
		if state != "all" && it.State != state {
			continue
		}
		match := true
		for _, l := range want {
			found := false
			for _, have := range it.Labels {
				if have == strings.TrimSpace(l) {
					found = true
				}
			}
			match = match && found
		}
		if match {
			filtered = append(filtered, it)
		}
	}
	per := queryInt(q, "per_page", 30, 100)
	page := queryInt(q, "page", 1, 1000)
	out := []map[string]any{}
	for i := (page - 1) * per; i < len(filtered) && i < page*per; i++ {
		out = append(out, h.issueJSON(filtered[i]))
	}
	writeJSON(h.w, http.StatusOK, out)
}

func (h *repoHandler) getIssue(n int) {
	it := h.find(n, false)
	if it == nil {
		fail(h.w, http.StatusNotFound, "Not Found")
		return
	}
	writeJSON(h.w, http.StatusOK, h.issueJSON(it))
}

func (h *repoHandler) commentJSON(n int, c comment) map[string]any {
	return map[string]any{"id": c.ID, "body": c.Body, "user": userJSON(c.User), "created_at": c.CreatedAt.Format(time.RFC3339),
		"html_url": fmt.Sprintf("%s#issuecomment-%d", h.s.htmlURL(h.full, "issues", n), c.ID)}
}

func (h *repoHandler) listComments(n int) {
	if h.find(n, false) == nil {
		fail(h.w, http.StatusNotFound, "Not Found")
		return
	}
	q := h.r.URL.Query()
	all := h.s.repoState(h.full).Comments[n]
	per := queryInt(q, "per_page", 30, 100)
	page := queryInt(q, "page", 1, 1000)
	out := []map[string]any{}
	for i := (page - 1) * per; i < len(all) && i < page*per; i++ {
		out = append(out, h.commentJSON(n, all[i]))
	}
	writeJSON(h.w, http.StatusOK, out)
}

func (h *repoHandler) createComment(n int) {
	it := h.find(n, false)
	if it == nil {
		fail(h.w, http.StatusNotFound, "Not Found")
		return
	}
	var in struct {
		Body string `json:"body"`
	}
	if !h.decode(&in) {
		return
	}
	st := h.s.repoState(h.full)
	c := comment{ID: st.NextID, Body: in.Body, User: h.who.Login, CreatedAt: h.s.cfg.Now().UTC()}
	st.NextID++
	st.Comments[n] = append(st.Comments[n], c)
	it.UpdatedAt = c.CreatedAt
	if err := h.s.save(); err != nil {
		h.internal(err)
		return
	}
	writeJSON(h.w, http.StatusCreated, h.commentJSON(n, c))
}

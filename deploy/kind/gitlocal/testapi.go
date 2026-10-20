package main

import (
	"encoding/json"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// 测试控制接口（只在 -test-api 时开启），与 internal/spoke/testenv 的进程内假 GitHub 是同一套：
//
//	POST /_test/repos                                   {owner, name, base, files, app_slug} 重建仓库
//	PUT  /_test/repos/{o}/{r}/branches/{b}/protection   {protected}
//	POST /_test/repos/{o}/{r}/push                      {branch, files, author, committer, message} → {sha}
//	POST /_test/repos/{o}/{r}/race                      {branch}：下一次创建 srenautix/* 分支之后以人工身份推进 branch
//	POST /_test/repos/{o}/{r}/pulls/{n}/merge           {merged_by, method: merge|squash} → {sha}（模拟网页合并）
//	GET  /_test/requests                                收到的全部 REST 请求（不含 /_test）
//	GET  /_test/repos/{o}/{r}/refs                      {branch: sha}
//	GET  /_test/repos/{o}/{r}/file?sha=&path=           文件原文，不存在时 404
//	GET  /_test/repos/{o}/{r}/diff?base=&head=          base...head 改动的文件列表
//	GET  /_test/state                                   issue、PR、评论、审计与各仓库的分支（Kind 端到端的断言用）
var reTestRepo = regexp.MustCompile(`^/_test/repos/([A-Za-z0-9-]+)/([A-Za-z0-9._-]+)(/.*)$`)

type person struct {
	Login string `json:"login"`
	Type  string `json:"type"`
}

func (p person) identity(def identity) identity {
	if p.Login == "" {
		return def
	}
	return identity{Login: p.Login, Bot: p.Type == "Bot" || strings.HasSuffix(p.Login, "[bot]")}
}

func (s *server) testRoutes(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p := r.URL.Path
	switch {
	case p == "/_test/requests" && r.Method == http.MethodGet:
		writeJSON(w, http.StatusOK, append([]requestRecord{}, s.requests...))
		return
	case p == "/_test/state" && r.Method == http.MethodGet:
		s.testState(w)
		return
	case p == "/_test/repos" && r.Method == http.MethodPost:
		s.testResetRepo(w, r)
		return
	}
	m := reTestRepo.FindStringSubmatch(p)
	if m == nil {
		fail(w, http.StatusNotFound, "Not Found")
		return
	}
	full, rest := m[1]+"/"+m[2], m[3]
	repo, ok := s.repo(full)
	if !ok {
		fail(w, http.StatusNotFound, "repository "+full+" does not exist")
		return
	}
	seg := strings.Split(strings.Trim(rest, "/"), "/")
	admin := identity{Login: s.cfg.AdminLogin}
	switch {
	case r.Method == http.MethodGet && rest == "/refs":
		refs, err := repo.branches()
		if err != nil {
			fail(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, refs)
	case r.Method == http.MethodGet && rest == "/diff":
		// base..head 之间改动的文件（Kind 场景核对修复 PR 改了哪些文件）
		q := r.URL.Query()
		out, err := repo.out("diff", "--name-only", q.Get("base")+"..."+q.Get("head"))
		if err != nil {
			fail(w, http.StatusUnprocessableEntity, err.Error())
			return
		}
		files := []string{}
		for _, f := range strings.Split(out, "\n") {
			if f != "" {
				files = append(files, f)
			}
		}
		writeJSON(w, http.StatusOK, files)
	case r.Method == http.MethodGet && rest == "/file":
		q := r.URL.Query()
		content, _, ok, err := repo.blob(q.Get("sha"), q.Get("path"))
		if err != nil || !ok {
			fail(w, http.StatusNotFound, "Not Found")
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		_, _ = w.Write(content)
	case r.Method == http.MethodPut && len(seg) >= 3 && seg[0] == "branches" && seg[len(seg)-1] == "protection":
		var in struct {
			Protected bool `json:"protected"`
		}
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
			fail(w, http.StatusBadRequest, err.Error())
			return
		}
		s.repoState(full).Protected[strings.Join(seg[1:len(seg)-1], "/")] = in.Protected
		_ = s.save()
		w.WriteHeader(http.StatusNoContent)
	case r.Method == http.MethodPost && rest == "/push":
		var in struct {
			Branch    string             `json:"branch"`
			Files     map[string]*string `json:"files"`
			Author    person             `json:"author"`
			Committer person             `json:"committer"`
			Message   string             `json:"message"`
		}
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil || in.Branch == "" || len(in.Files) == 0 {
			fail(w, http.StatusBadRequest, "branch and files are required")
			return
		}
		author := in.Author.identity(admin)
		sha, err := s.pushFiles(full, repo, in.Branch, in.Files, author, in.Committer.identity(author), in.Message)
		if err != nil {
			fail(w, http.StatusInternalServerError, err.Error())
			return
		}
		_ = s.save()
		writeJSON(w, http.StatusCreated, map[string]string{"sha": sha})
	case r.Method == http.MethodPost && rest == "/race":
		var in struct {
			Branch string `json:"branch"`
		}
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil || in.Branch == "" {
			fail(w, http.StatusBadRequest, "branch is required")
			return
		}
		s.repoState(full).RaceBranch = in.Branch
		_ = s.save()
		w.WriteHeader(http.StatusNoContent)
	case r.Method == http.MethodPost && len(seg) == 3 && seg[0] == "pulls" && seg[2] == "merge":
		n, err := strconv.Atoi(seg[1])
		if err != nil {
			fail(w, http.StatusNotFound, "Not Found")
			return
		}
		s.testMerge(w, r, full, repo, n)
	default:
		fail(w, http.StatusNotFound, "Not Found")
	}
}

func (s *server) testResetRepo(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Owner   string            `json:"owner"`
		Name    string            `json:"name"`
		Base    string            `json:"base"`
		Files   map[string]string `json:"files"`
		AppSlug string            `json:"app_slug"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		fail(w, http.StatusBadRequest, err.Error())
		return
	}
	full := in.Owner + "/" + in.Name
	if !repoName.MatchString(full) {
		fail(w, http.StatusBadRequest, "invalid repository "+full)
		return
	}
	if in.Base == "" {
		in.Base = "main"
	}
	if in.AppSlug != "" {
		s.cfg.AppSlug = in.AppSlug
	}
	if err := os.RemoveAll(s.repoDir(full)); err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	delete(s.state.Repos, full)
	repo, err := initBare(s.repoDir(full))
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	files := map[string]*string{}
	for p, c := range in.Files {
		files[p] = ptr(c)
	}
	if len(files) == 0 {
		files["README.md"] = ptr("# " + full + "\n")
	}
	admin := identity{Login: s.cfg.AdminLogin}
	sha, err := s.pushFiles(full, repo, in.Base, files, admin, admin, "Initial commit")
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	if in.Base != "main" {
		// 默认分支取 base
		if _, err := repo.run(nil, nil, "symbolic-ref", "HEAD", branchRef(in.Base)); err != nil {
			fail(w, http.StatusInternalServerError, err.Error())
			return
		}
	}
	_ = s.save()
	writeJSON(w, http.StatusCreated, map[string]string{"sha": sha})
}

// testMerge 模拟网页上的合并：merge 方式作者是 merged_by，squash 方式作者是 PR 作者；提交者都是 web-flow。
func (s *server) testMerge(w http.ResponseWriter, r *http.Request, full string, repo gitRepo, n int) {
	var in struct {
		MergedBy person `json:"merged_by"`
		Method   string `json:"method"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil || in.MergedBy.Login == "" {
		fail(w, http.StatusBadRequest, "merged_by is required")
		return
	}
	var it *item
	for _, x := range s.repoState(full).Items {
		if x.Number == n && x.IsPR {
			it = x
		}
	}
	if it == nil || it.State != "open" {
		fail(w, http.StatusUnprocessableEntity, "pull request is not open")
		return
	}
	baseRef := branchRef(it.Base)
	baseSHA, ok, err := repo.resolve(baseRef)
	if err != nil || !ok {
		fail(w, http.StatusUnprocessableEntity, "base does not exist")
		return
	}
	headSHA, ok, err := repo.resolve(branchRef(it.Head))
	if err != nil || !ok {
		fail(w, http.StatusUnprocessableEntity, "head does not exist")
		return
	}
	tree, err := repo.mergeTree(baseSHA, headSHA)
	if err != nil {
		fail(w, http.StatusMethodNotAllowed, "Pull Request is not mergeable: "+err.Error())
		return
	}
	webflow := identity{Login: "web-flow"}
	merger := in.MergedBy.identity(identity{})
	var sha string
	switch in.Method {
	case "", "merge":
		sha, err = repo.commitTreeAs(tree, []string{baseSHA, headSHA},
			"Merge pull request #"+strconv.Itoa(n)+" from "+it.Head+"\n\n"+it.Title, merger, webflow, s.cfg.Now())
	case "squash":
		sha, err = repo.commitTreeAs(tree, []string{baseSHA}, it.Title+" (#"+strconv.Itoa(n)+")", identityOf(it.User), webflow, s.cfg.Now())
	default:
		fail(w, http.StatusBadRequest, "method must be merge or squash")
		return
	}
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	if err := repo.updateRef(baseRef, sha, baseSHA); err != nil {
		fail(w, http.StatusConflict, err.Error())
		return
	}
	now := s.cfg.Now().UTC()
	it.State, it.Merged, it.MergedAt, it.MergedBy, it.MergeCommitSHA, it.UpdatedAt = "closed", true, &now, merger.Login, sha, now
	s.audit(auditEntry{Repo: full, Kind: "ref_update", Ref: baseRef, Old: baseSHA, New: sha, Actor: "web-flow", Number: n})
	_ = s.save()
	writeJSON(w, http.StatusOK, map[string]string{"sha": sha})
}

func (s *server) testState(w http.ResponseWriter) {
	type repoView struct {
		Branches map[string]string `json:"branches"`
		*repoState
	}
	out := map[string]any{"audit": s.state.Audit, "now": s.cfg.Now().UTC().Format(time.RFC3339)}
	repos := map[string]repoView{}
	for full := range s.state.Repos {
		repo, ok := s.repo(full)
		if !ok {
			continue
		}
		refs, _ := repo.branches()
		repos[full] = repoView{Branches: refs, repoState: s.repoState(full)}
	}
	out["repos"] = repos
	writeJSON(w, http.StatusOK, out)
}

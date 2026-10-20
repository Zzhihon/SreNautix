package main

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// config 是 gitlocal 的启动参数。
type config struct {
	DataDir        string
	PublicURL      string
	AppID          string
	InstallationID string
	AppSlug        string
	AppPublicKey   *rsa.PublicKey
	AdminToken     string
	// 管理员提交与 git push 使用的身份（模拟人工）
	AdminLogin string
	// 打开 /_test 控制接口（只用于测试部署）
	TestAPI bool
	Now     func() time.Time
}

// item 是 issue 或 PR（与 GitHub 一样共用编号）。
type item struct {
	Number    int       `json:"number"`
	IsPR      bool      `json:"is_pr"`
	Title     string    `json:"title"`
	Body      string    `json:"body"`
	State     string    `json:"state"`
	Labels    []string  `json:"labels"`
	User      string    `json:"user"`
	Head      string    `json:"head,omitempty"`
	Base      string    `json:"base,omitempty"`
	HeadSHA   string    `json:"head_sha,omitempty"`
	Reviewers []string  `json:"reviewers,omitempty"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
	// 合并只能经 /_test 接口模拟（模拟网页上的人工合并）；REST 的合并接口拒绝并记入审计
	Merged         bool       `json:"merged,omitempty"`
	MergedAt       *time.Time `json:"merged_at,omitempty"`
	MergedBy       string     `json:"merged_by,omitempty"`
	MergeCommitSHA string     `json:"merge_commit_sha,omitempty"`
}

type comment struct {
	ID        int       `json:"id"`
	Body      string    `json:"body"`
	User      string    `json:"user"`
	CreatedAt time.Time `json:"created_at"`
}

// auditEntry 记录每一次引用变更、PR 与 issue 的创建和被拒绝的合并请求，供端到端断言。
type auditEntry struct {
	Time   time.Time `json:"time"`
	Repo   string    `json:"repo"`
	Kind   string    `json:"kind"`
	Ref    string    `json:"ref,omitempty"`
	Old    string    `json:"old,omitempty"`
	New    string    `json:"new,omitempty"`
	Number int       `json:"number,omitempty"`
	Actor  string    `json:"actor"`
	Bot    bool      `json:"bot"`
}

type repoState struct {
	NextNumber int               `json:"next_number"`
	NextID     int               `json:"next_id"`
	Items      []*item           `json:"items"`
	Comments   map[int][]comment `json:"comments"`
	// 受保护的分支（GET /branches/{b} 的 protected）
	Protected map[string]bool `json:"protected,omitempty"`
	// /_test/race：下一次创建 srenautix/* 分支之后以人工身份推进的分支
	RaceBranch string `json:"race_branch,omitempty"`
}

type persisted struct {
	Repos map[string]*repoState `json:"repos"`
	Audit []auditEntry          `json:"audit"`
}

// requestRecord 是收到的一个 REST 请求（GET /_test/requests 返回，不含 /_test 自身）。
type requestRecord struct {
	Method string          `json:"method"`
	Path   string          `json:"path"`
	Body   json.RawMessage `json:"body,omitempty"`
}

type tokenInfo struct {
	who identity
	exp time.Time
}

// server 是 GitHub REST 子集与 git smart HTTP 的实现；全部状态由一把锁保护（端到端测试的请求量很小）。
type server struct {
	cfg      config
	mu       sync.Mutex
	state    persisted
	tokens   map[string]tokenInfo
	requests []requestRecord
}

func newServer(cfg config) (*server, error) {
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.AdminLogin == "" {
		cfg.AdminLogin = "kind-operator"
	}
	s := &server{cfg: cfg, tokens: map[string]tokenInfo{}, state: persisted{Repos: map[string]*repoState{}}}
	b, err := os.ReadFile(s.statePath())
	switch {
	case err == nil:
		if err := json.Unmarshal(b, &s.state); err != nil {
			return nil, fmt.Errorf("%s: %w", s.statePath(), err)
		}
	case !errors.Is(err, os.ErrNotExist):
		return nil, err
	}
	return s, nil
}

func (s *server) statePath() string { return filepath.Join(s.cfg.DataDir, "state.json") }

// save 在持有锁时调用，把 issue、PR 与审计写盘（Pod 重启后保留）。
func (s *server) save() error {
	b, err := json.MarshalIndent(s.state, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.statePath() + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.statePath())
}

var repoName = regexp.MustCompile(`^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$`)

func (s *server) repoDir(full string) string {
	return filepath.Join(s.cfg.DataDir, "repos", full+".git")
}

// repo 返回已存在的仓库。
func (s *server) repo(full string) (gitRepo, bool) {
	if !repoName.MatchString(full) {
		return gitRepo{}, false
	}
	dir := s.repoDir(full)
	if _, err := os.Stat(filepath.Join(dir, "HEAD")); err != nil {
		return gitRepo{}, false
	}
	return gitRepo{dir: dir}, true
}

func (s *server) repoState(full string) *repoState {
	st := s.state.Repos[full]
	if st == nil {
		st = &repoState{NextNumber: 1, NextID: 1, Comments: map[int][]comment{}}
		s.state.Repos[full] = st
	}
	if st.Comments == nil {
		st.Comments = map[int][]comment{}
	}
	if st.Protected == nil {
		st.Protected = map[string]bool{}
	}
	return st
}

func (s *server) audit(e auditEntry) {
	e.Time = s.cfg.Now().UTC()
	s.state.Audit = append(s.state.Audit, e)
}

// seed 在仓库不存在时新建，并把目录内容作为 main 的第一个提交。
func (s *server) seed(full, dir string) error {
	if !repoName.MatchString(full) {
		return fmt.Errorf("repository name %q is not owner/name", full)
	}
	if _, ok := s.repo(full); ok {
		return nil
	}
	r, err := initBare(s.repoDir(full))
	if err != nil {
		return err
	}
	who := identity{Login: s.cfg.AdminLogin}
	sha, err := r.seedFromDir(dir, "Initial import", who, s.cfg.Now())
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.repoState(full)
	s.audit(auditEntry{Repo: full, Kind: "ref_update", Ref: "refs/heads/main", Old: zeroSHA, New: sha, Actor: who.Login})
	return s.save()
}

// ---- 认证 ----

// verifyJWT 校验 GitHub App 的 RS256 JWT：签名、iss 等于 App id、未过期、有效期不超过 10 分钟。
func (s *server) verifyJWT(tok string) error {
	parts := strings.Split(tok, ".")
	if len(parts) != 3 {
		return errors.New("not a JWT")
	}
	hb, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return err
	}
	var hdr struct {
		Alg string `json:"alg"`
	}
	if err := json.Unmarshal(hb, &hdr); err != nil || hdr.Alg != "RS256" {
		return fmt.Errorf("JWT alg must be RS256")
	}
	// 配置了 App 公钥时校验签名；不变量测试的进程内 App 用的是临时密钥，只校验 iss 与有效期
	if s.cfg.AppPublicKey != nil {
		sig, err := base64.RawURLEncoding.DecodeString(parts[2])
		if err != nil {
			return err
		}
		sum := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
		if err := rsa.VerifyPKCS1v15(s.cfg.AppPublicKey, crypto.SHA256, sum[:], sig); err != nil {
			return errors.New("JWT signature does not match the App public key")
		}
	}
	cb, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return err
	}
	var claims struct {
		Iss json.RawMessage `json:"iss"`
		Iat int64           `json:"iat"`
		Exp int64           `json:"exp"`
	}
	if err := json.Unmarshal(cb, &claims); err != nil {
		return err
	}
	iss := strings.Trim(string(claims.Iss), `"`)
	if iss != s.cfg.AppID {
		return fmt.Errorf("JWT iss %q is not App %s", iss, s.cfg.AppID)
	}
	now := s.cfg.Now().Unix()
	if claims.Exp <= now || claims.Iat > now+60 || claims.Exp-claims.Iat > 600 {
		return errors.New("JWT expired or valid for more than 10 minutes")
	}
	return nil
}

func randomToken(prefix string) string {
	b := make([]byte, 20)
	_, _ = rand.Read(b)
	return prefix + hex.EncodeToString(b)
}

// caller 解析 Authorization：安装令牌（App 的 bot 身份）或管理员令牌（模拟人工）。
func (s *server) caller(r *http.Request) (identity, bool) {
	h := r.Header.Get("Authorization")
	var tok string
	switch {
	case strings.HasPrefix(h, "Bearer "):
		tok = strings.TrimPrefix(h, "Bearer ")
	case strings.HasPrefix(h, "token "):
		tok = strings.TrimPrefix(h, "token ")
	default:
		if _, pw, ok := r.BasicAuth(); ok {
			tok = pw
		}
	}
	if tok == "" {
		return identity{}, false
	}
	if s.cfg.AdminToken != "" && subtle.ConstantTimeCompare([]byte(tok), []byte(s.cfg.AdminToken)) == 1 {
		return identity{Login: s.cfg.AdminLogin}, true
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	t, ok := s.tokens[tok]
	if !ok || s.cfg.Now().After(t.exp) {
		return identity{}, false
	}
	return t.who, true
}

func (s *server) botIdentity() identity { return identity{Login: s.cfg.AppSlug + "[bot]", Bot: true} }

// ---- 响应 ----

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func fail(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"message": msg, "documentation_url": "https://docs.github.com/rest"})
}

func (s *server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	switch {
	case path == "/healthz":
		w.WriteHeader(http.StatusNoContent)
	case strings.HasSuffix(path, "/info/refs") || strings.HasSuffix(path, "/git-upload-pack") || strings.HasSuffix(path, "/git-receive-pack"):
		s.smartHTTP(w, r)
	case path == "/app" || strings.HasPrefix(path, "/app/"):
		s.appRoutes(w, r)
	case strings.HasPrefix(path, "/repos/"):
		s.repoRoutes(w, r)
	case strings.HasPrefix(path, "/_test/") && s.cfg.TestAPI:
		s.testRoutes(w, r)
	default:
		fail(w, http.StatusNotFound, "Not Found")
	}
}

func (s *server) appRoutes(w http.ResponseWriter, r *http.Request) {
	tok := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if err := s.verifyJWT(tok); err != nil {
		fail(w, http.StatusUnauthorized, "A JSON web token could not be decoded: "+err.Error())
		return
	}
	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/app":
		id, _ := strconv.Atoi(s.cfg.AppID)
		writeJSON(w, http.StatusOK, map[string]any{"id": id, "slug": s.cfg.AppSlug, "name": s.cfg.AppSlug})
	case r.Method == http.MethodPost && r.URL.Path == "/app/installations/"+s.cfg.InstallationID+"/access_tokens":
		tok := randomToken("ghs_")
		exp := s.cfg.Now().Add(time.Hour).UTC()
		s.mu.Lock()
		s.tokens[tok] = tokenInfo{who: s.botIdentity(), exp: exp}
		s.mu.Unlock()
		writeJSON(w, http.StatusCreated, map[string]any{"token": tok, "expires_at": exp.Format(time.RFC3339)})
	default:
		fail(w, http.StatusNotFound, "Not Found")
	}
}

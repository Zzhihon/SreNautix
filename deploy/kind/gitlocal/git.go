package main

import (
	"bytes"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// gitRepo 是一个 bare 仓库，全部读写都经 git 的底层命令完成。
type gitRepo struct{ dir string }

// identity 是调用方、提交作者或提交者；登录名以 [bot] 结尾的是机器人（与 GitHub App 的账号一致）。
type identity struct {
	Login string
	Bot   bool
}

func (i identity) email() string { return i.Login + "@users.noreply.gitlocal" }

func (i identity) userType() string {
	if i.Bot {
		return "Bot"
	}
	return "User"
}

// identityOf 由提交中的名字还原身份。
func identityOf(login string) identity {
	return identity{Login: login, Bot: strings.HasSuffix(login, "[bot]")}
}

const zeroSHA = "0000000000000000000000000000000000000000"

func (r gitRepo) run(env []string, stdin []byte, args ...string) ([]byte, error) {
	cmd := exec.Command("git", append([]string{"--git-dir", r.dir}, args...)...)
	cmd.Env = append(os.Environ(), env...)
	if stdin != nil {
		cmd.Stdin = bytes.NewReader(stdin)
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("git %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(stderr.String()))
	}
	return stdout.Bytes(), nil
}

func (r gitRepo) out(args ...string) (string, error) {
	b, err := r.run(nil, nil, args...)
	return strings.TrimSpace(string(b)), err
}

// initBare 新建 bare 仓库，默认分支 main。
func initBare(dir string) (gitRepo, error) {
	if err := os.MkdirAll(filepath.Dir(dir), 0o755); err != nil {
		return gitRepo{}, err
	}
	if out, err := exec.Command("git", "init", "--bare", "--quiet", "--initial-branch=main", dir).CombinedOutput(); err != nil {
		return gitRepo{}, fmt.Errorf("git init %s: %w: %s", dir, err, out)
	}
	return gitRepo{dir: dir}, nil
}

// resolve 返回 ref（分支名、refs/… 或提交 SHA）指向的提交；不存在时 ok=false。
func (r gitRepo) resolve(ref string) (string, bool, error) {
	cmd := exec.Command("git", "--git-dir", r.dir, "rev-parse", "--verify", "--quiet", ref+"^{commit}")
	out, err := cmd.Output()
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) && ee.ExitCode() == 1 {
			return "", false, nil
		}
		return "", false, err
	}
	return strings.TrimSpace(string(out)), true, nil
}

// branchRef 把分支名或 refs/heads/… 统一成完整的引用名。
func branchRef(b string) string {
	if strings.HasPrefix(b, "refs/") {
		return b
	}
	return "refs/heads/" + b
}

// updateRef 原子地把 ref 从 old 改为 new；old 为 zeroSHA 时要求 ref 不存在，new 为 zeroSHA 时删除。
func (r gitRepo) updateRef(ref, newSHA, oldSHA string) error {
	if newSHA == zeroSHA {
		_, err := r.run(nil, nil, "update-ref", "-d", ref, oldSHA)
		return err
	}
	_, err := r.run(nil, nil, "update-ref", ref, newSHA, oldSHA)
	return err
}

// branches 返回全部分支名到提交的映射。
func (r gitRepo) branches() (map[string]string, error) {
	out, err := r.out("for-each-ref", "--format=%(refname:strip=2) %(objectname)", "refs/heads/")
	if err != nil {
		return nil, err
	}
	m := map[string]string{}
	for _, line := range strings.Split(out, "\n") {
		if name, sha, ok := strings.Cut(line, " "); ok {
			m[name] = sha
		}
	}
	return m, nil
}

// objectType 返回 rev（例如 <提交>:<路径>）的对象类型；不存在时为空。
func (r gitRepo) objectType(rev string) string {
	out, err := exec.Command("git", "--git-dir", r.dir, "cat-file", "-t", rev).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

func (r gitRepo) revParse(rev string) (string, error) { return r.out("rev-parse", rev) }

// blob 读取 commit 上 path 的文件内容与 blob SHA。
func (r gitRepo) blob(commit, path string) ([]byte, string, bool, error) {
	rev := commit + ":" + path
	if r.objectType(rev) != "blob" {
		return nil, "", false, nil
	}
	sha, err := r.revParse(rev)
	if err != nil {
		return nil, "", false, err
	}
	b, err := r.run(nil, nil, "cat-file", "blob", sha)
	return b, sha, true, err
}

// treeEntry 是目录下的一项。
type treeEntry struct {
	Mode, Type, SHA, Name string
}

// listTree 列出 commit 上目录 path 的直接子项；path 不是目录时 ok=false。
func (r gitRepo) listTree(commit, path string) ([]treeEntry, bool, error) {
	rev := commit + ":" + strings.TrimSuffix(path, "/")
	if path == "" {
		rev = commit + "^{tree}"
	}
	if r.objectType(rev) != "tree" {
		return nil, false, nil
	}
	out, err := r.out("ls-tree", rev)
	if err != nil {
		return nil, false, err
	}
	var entries []treeEntry
	for _, line := range strings.Split(out, "\n") {
		meta, name, ok := strings.Cut(line, "\t")
		if !ok {
			continue
		}
		f := strings.Fields(meta)
		entries = append(entries, treeEntry{Mode: f[0], Type: f[1], SHA: f[2], Name: name})
	}
	return entries, true, nil
}

func (r gitRepo) hashObject(content []byte) (string, error) {
	b, err := r.run(nil, content, "hash-object", "-w", "--stdin")
	return strings.TrimSpace(string(b)), err
}

// treeChange 是对树的一处修改：Delete 为真时删除，否则写入 SHA（已有 blob）或 Content。
type treeChange struct {
	Path    string
	Mode    string
	SHA     string
	Content []byte
	Delete  bool
}

// writeTree 在 baseTree（可以为空）之上应用 changes，返回新树的 SHA。
func (r gitRepo) writeTree(baseTree string, changes []treeChange) (string, error) {
	idx, err := os.CreateTemp("", "gitlocal-index-")
	if err != nil {
		return "", err
	}
	idxPath := idx.Name()
	_ = idx.Close()
	_ = os.Remove(idxPath) // git 要求索引文件不存在或是合法的索引
	defer os.Remove(idxPath)
	env := []string{"GIT_INDEX_FILE=" + idxPath}
	if baseTree != "" {
		if _, err := r.run(env, nil, "read-tree", baseTree); err != nil {
			return "", err
		}
	} else if _, err := r.run(env, nil, "read-tree", "--empty"); err != nil {
		return "", err
	}
	// bare 仓库没有工作区：增删都经 update-index --index-info（mode 0 表示删除）
	var info strings.Builder
	for _, c := range changes {
		if c.Delete {
			fmt.Fprintf(&info, "0 %s\t%s\n", zeroSHA, c.Path)
			continue
		}
		sha := c.SHA
		if sha == "" {
			if sha, err = r.hashObject(c.Content); err != nil {
				return "", err
			}
		}
		mode := c.Mode
		if mode == "" {
			mode = "100644"
		}
		fmt.Fprintf(&info, "%s blob %s\t%s\n", mode, sha, c.Path)
	}
	if info.Len() > 0 {
		if _, err := r.run(env, []byte(info.String()), "update-index", "--index-info"); err != nil {
			return "", err
		}
	}
	b, err := r.run(env, nil, "write-tree")
	return strings.TrimSpace(string(b)), err
}

// commitTree 以 who 为作者与提交者创建提交。
func (r gitRepo) commitTree(tree string, parents []string, message string, who identity, when time.Time) (string, error) {
	return r.commitTreeAs(tree, parents, message, who, who, when)
}

// commitTreeAs 分别指定作者与提交者（网页合并时提交者是 web-flow）。
func (r gitRepo) commitTreeAs(tree string, parents []string, message string, author, committer identity, when time.Time) (string, error) {
	args := []string{"commit-tree", tree}
	for _, p := range parents {
		args = append(args, "-p", p)
	}
	date := strconv.FormatInt(when.Unix(), 10) + " +0000"
	env := []string{
		"GIT_AUTHOR_NAME=" + author.Login, "GIT_AUTHOR_EMAIL=" + author.email(), "GIT_AUTHOR_DATE=" + date,
		"GIT_COMMITTER_NAME=" + committer.Login, "GIT_COMMITTER_EMAIL=" + committer.email(), "GIT_COMMITTER_DATE=" + date,
	}
	b, err := r.run(env, []byte(message), args...)
	return strings.TrimSpace(string(b)), err
}

// commitInfo 是一个提交的元数据。
type commitInfo struct {
	SHA, Tree               string
	Parents                 []string
	AuthorName, AuthorEmail string
	AuthorDate              time.Time
	CommitterName           string
	CommitterEmail          string
	CommitterDate           time.Time
	Message                 string
}

const logFormat = "%H%x00%T%x00%P%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%B%x1e"

func parseLog(out []byte) ([]commitInfo, error) {
	var list []commitInfo
	for _, rec := range strings.Split(string(out), "\x1e") {
		rec = strings.TrimLeft(rec, "\n")
		if rec == "" {
			continue
		}
		f := strings.SplitN(rec, "\x00", 10)
		if len(f) != 10 {
			return nil, fmt.Errorf("unexpected git log record %q", rec)
		}
		ad, err := time.Parse(time.RFC3339, f[5])
		if err != nil {
			return nil, err
		}
		cd, err := time.Parse(time.RFC3339, f[8])
		if err != nil {
			return nil, err
		}
		c := commitInfo{SHA: f[0], Tree: f[1], AuthorName: f[3], AuthorEmail: f[4], AuthorDate: ad.UTC(),
			CommitterName: f[6], CommitterEmail: f[7], CommitterDate: cd.UTC(), Message: f[9]}
		if f[2] != "" {
			c.Parents = strings.Fields(f[2])
		}
		list = append(list, c)
	}
	return list, nil
}

// commit 返回一个提交的元数据；不是提交时 ok=false。
func (r gitRepo) commit(sha string) (commitInfo, bool, error) {
	if r.objectType(sha) != "commit" {
		return commitInfo{}, false, nil
	}
	out, err := r.run(nil, nil, "log", "-1", "--format="+logFormat, sha)
	if err != nil {
		return commitInfo{}, false, err
	}
	list, err := parseLog(out)
	if err != nil || len(list) != 1 {
		return commitInfo{}, false, err
	}
	return list[0], true, nil
}

// logRange 按时间倒序列出 ref 可达的提交；path 非空时只列出改动该路径的提交。
func (r gitRepo) logRange(ref, path string, since, until *time.Time, skip, n int) ([]commitInfo, error) {
	args := []string{"log", "--format=" + logFormat, "--skip=" + strconv.Itoa(skip), "--max-count=" + strconv.Itoa(n)}
	if since != nil {
		args = append(args, "--since="+since.UTC().Format(time.RFC3339))
	}
	if until != nil {
		args = append(args, "--until="+until.UTC().Format(time.RFC3339))
	}
	args = append(args, ref)
	if path != "" {
		args = append(args, "--", path)
	}
	out, err := r.run(nil, nil, args...)
	if err != nil {
		return nil, err
	}
	return parseLog(out)
}

// fileChange 是一个提交改动的文件。
type fileChange struct {
	Filename, Status, Previous string
}

// files 返回提交相对第一个父提交（根提交相对空树）改动的文件。
func (r gitRepo) files(sha string) ([]fileChange, error) {
	out, err := r.out("diff-tree", "--root", "--no-commit-id", "-r", "-M", "--name-status", "--first-parent", sha)
	if err != nil {
		return nil, err
	}
	var list []fileChange
	for _, line := range strings.Split(out, "\n") {
		if line == "" {
			continue
		}
		f := strings.Split(line, "\t")
		st := map[byte]string{'A': "added", 'M': "modified", 'D': "removed", 'R': "renamed"}[f[0][0]]
		if st == "" {
			st = "changed"
		}
		fc := fileChange{Filename: f[len(f)-1], Status: st}
		if st == "renamed" && len(f) == 3 {
			fc.Previous = f[1]
		}
		list = append(list, fc)
	}
	return list, nil
}

// mergeTree 返回把 head 合并进 base 的树；有冲突时报错。
func (r gitRepo) mergeTree(base, head string) (string, error) {
	out, err := r.out("merge-tree", "--write-tree", base, head)
	if err != nil {
		return "", fmt.Errorf("merge conflict: %w", err)
	}
	tree, _, _ := strings.Cut(out, "\n")
	return tree, nil
}

// isAncestor 报告 a 是否是 b 的祖先（或相同）。
func (r gitRepo) isAncestor(a, b string) bool {
	return exec.Command("git", "--git-dir", r.dir, "merge-base", "--is-ancestor", a, b).Run() == nil
}

// seedFromDir 把目录的全部文件作为 main 的第一个提交（仓库为空时）。
func (r gitRepo) seedFromDir(dir, message string, who identity, when time.Time) (string, error) {
	var changes []treeChange
	err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(dir, p)
		if err != nil {
			return err
		}
		mode := "100644"
		if info, err := d.Info(); err == nil && info.Mode()&0o111 != 0 {
			mode = "100755"
		}
		changes = append(changes, treeChange{Path: filepath.ToSlash(rel), Mode: mode, Content: b})
		return nil
	})
	if err != nil {
		return "", err
	}
	tree, err := r.writeTree("", changes)
	if err != nil {
		return "", err
	}
	sha, err := r.commitTree(tree, nil, message, who, when)
	if err != nil {
		return "", err
	}
	return sha, r.updateRef("refs/heads/main", sha, zeroSHA)
}

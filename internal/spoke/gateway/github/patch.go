package github

import (
	"bytes"
	"fmt"
	"path"
	"strings"

	"github.com/bluekeyes/go-gitdiff/gitdiff"
)

// FileChange 是补丁对一个文件的改动；Delete 时 Content 为空。
type FileChange struct {
	Path    string
	Content []byte
	Delete  bool
}

// ParsedPatch 是解析并通过路径检查的补丁。
type ParsedPatch struct {
	files []*gitdiff.File
}

// Paths 返回补丁读取的原文件路径（新建文件不读取）。
func (p *ParsedPatch) Paths() []string {
	var out []string
	for _, f := range p.files {
		if !f.IsNew {
			out = append(out, f.OldName)
		}
	}
	return out
}

func cleanPath(p string) bool {
	if p == "" || strings.Contains(p, "\\") || path.IsAbs(p) {
		return false
	}
	c := path.Clean(p)
	return c == p && c != ".." && !strings.HasPrefix(c, "../") && !strings.HasPrefix(c, ".git/") && c != ".git"
}

// ParsePatch 解析 unified diff，拒绝二进制补丁、可执行或符号链接模式、重复路径，以及 allowed 之外的路径。
func ParsePatch(patch string, allowed func(string) bool) (*ParsedPatch, error) {
	files, _, err := gitdiff.Parse(strings.NewReader(patch))
	if err != nil {
		return nil, fmt.Errorf("patch: %w", err)
	}
	if len(files) == 0 {
		return nil, fmt.Errorf("patch: no file changes")
	}
	seen := map[string]bool{}
	for _, f := range files {
		if f.IsBinary {
			return nil, fmt.Errorf("patch: binary change to %s is not allowed", f.NewName)
		}
		names := []string{f.OldName}
		if f.NewName != f.OldName {
			names = append(names, f.NewName)
		}
		for _, n := range names {
			if n == "" {
				continue
			}
			if !cleanPath(n) || !allowed(n) {
				return nil, fmt.Errorf("patch: path %s is not allowed", n)
			}
			if seen[n] {
				return nil, fmt.Errorf("patch: path %s appears more than once", n)
			}
			seen[n] = true
		}
		if f.NewMode != 0 && f.NewMode != 0o100644 {
			return nil, fmt.Errorf("patch: mode %o for %s is not allowed", f.NewMode, f.NewName)
		}
	}
	return &ParsedPatch{files: files}, nil
}

// Apply 把补丁应用到原文件内容（等价于 git apply）；originals 缺少的路径视为不存在。
func (p *ParsedPatch) Apply(originals map[string][]byte) ([]FileChange, error) {
	var out []FileChange
	for _, f := range p.files {
		var src []byte
		if !f.IsNew {
			b, ok := originals[f.OldName]
			if !ok {
				return nil, fmt.Errorf("patch: %s does not exist", f.OldName)
			}
			src = b
		} else if _, exists := originals[f.NewName]; exists {
			return nil, fmt.Errorf("patch: %s already exists", f.NewName)
		}
		var dst bytes.Buffer
		if err := gitdiff.Apply(&dst, bytes.NewReader(src), f); err != nil {
			return nil, fmt.Errorf("patch: %s does not apply: %w", f.NewName, err)
		}
		if f.IsDelete {
			out = append(out, FileChange{Path: f.OldName, Delete: true})
			continue
		}
		if f.IsRename && f.OldName != f.NewName {
			out = append(out, FileChange{Path: f.OldName, Delete: true})
		}
		out = append(out, FileChange{Path: f.NewName, Content: dst.Bytes()})
	}
	return out, nil
}

// BranchName 返回 srenautix/<执行 ID>。
func BranchName(executionID string) string { return BranchPrefix + executionID }

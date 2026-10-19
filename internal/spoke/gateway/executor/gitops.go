package executor

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/assertion"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/audit"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/execution"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/github"
)

// gitopsPR 以 GitHub App 在 srenautix/<执行 ID> 分支上提交补丁并开 PR，从不合并。断言的 target_uid 是 base 分支
// 被批准时的提交 SHA（绑定 head SHA）；base 分支没有分支保护时预检失败。
type gitopsPR struct{ d *Deps }

type prParams struct {
	Repository string `json:"repository"`
	Base       string `json:"base"`
	Title      string `json:"title"`
	Body       string `json:"body"`
	Patch      string `json:"patch"`
}

func (e *gitopsPR) repo(p prParams) (*github.Repo, func(string) bool, error) {
	if e.d.GitHub == nil {
		return nil, nil, errors.New("gitops_pr: no GitHub App is configured")
	}
	entry, ok := e.d.Policy().Repo(p.Repository)
	if !ok || entry.Base != p.Base {
		return nil, nil, fmt.Errorf("gitops_pr: %s@%s is not in the gateway policy", p.Repository, p.Base)
	}
	r, err := e.d.GitHub.Repo(p.Repository)
	return r, entry.PathAllowed, err
}

func (e *gitopsPR) Resolve(ctx context.Context, params json.RawMessage) (*Resolved, error) {
	var p prParams
	if err := decode(params, &p); err != nil {
		return nil, err
	}
	target := execution.TargetRef{Group: "srenautix.io", Version: "v1", Kind: "GitRepository", Resource: "gitrepositories", Name: p.Repository}
	res := &Resolved{Target: target, Domain: "gitops:" + p.Repository, Level: assertion.LevelCompensable, BlastRadius: 1, Snapshot: map[string]any{}}
	r, allowed, err := e.repo(p)
	if err != nil {
		res.Prechecks = []execution.CheckResult{check("configured", "git", false, "%v", err)}
		return res, nil
	}
	head, err := r.Head(ctx, p.Base)
	if err != nil {
		return nil, err
	}
	res.Target.UID = head
	protected, err := r.Protected(ctx, p.Base)
	if err != nil {
		return nil, err
	}
	parsed, perr := github.ParsePatch(p.Patch, allowed)
	applies := perr
	if perr == nil {
		files, err := e.originals(ctx, r, head, parsed)
		if err != nil {
			return nil, err
		}
		_, applies = parsed.Apply(files)
	}
	res.Snapshot["baseSHA"] = head
	res.Prechecks = []execution.CheckResult{
		check("branch_protection", "git", protected, "%s 的分支保护=%v", p.Base, protected),
		check("patch_paths", "git", perr == nil, "%s", errString(perr)),
		check("patch_applies", "git", applies == nil, "应用到 %s：%s", head, errString(applies)),
	}
	return res, nil
}

func (e *gitopsPR) originals(ctx context.Context, r *github.Repo, ref string, parsed *github.ParsedPatch) (map[string][]byte, error) {
	files := map[string][]byte{}
	for _, path := range parsed.Paths() {
		content, ok, err := r.FileAt(ctx, ref, path)
		if err != nil {
			return nil, err
		}
		if ok {
			files[path] = content
		}
	}
	return files, nil
}

// Execute 在断言绑定的 base 提交之上建分支并开 PR；base 已前进时由引擎在执行前的复核中判为 stale。
func (e *gitopsPR) Execute(ctx context.Context, x *Exec) error {
	var p prParams
	if err := decode(x.Params, &p); err != nil {
		return err
	}
	r, allowed, err := e.repo(p)
	if err != nil {
		return err
	}
	parsed, err := github.ParsePatch(p.Patch, allowed)
	if err != nil {
		return err
	}
	base := x.AE.Spec.Target.UID
	files, err := e.originals(ctx, r, base, parsed)
	if err != nil {
		return err
	}
	changes, err := parsed.Apply(files)
	if err != nil {
		return err
	}
	branch := github.BranchName(x.ID())
	body := p.Body + "\n\nSreNautix execution " + x.ID() + " (proposal " + x.AE.Spec.ProposalID + "). Review and merge are done by people."
	_, _, err = r.OpenPR(ctx, p.Base, base, branch, p.Title, body, changes)
	if werr := x.Wrote(ctx, audit.Target{Group: "github", Resource: "pulls", Name: p.Repository + ":" + branch, UID: base}, "create", err); werr != nil {
		return werr
	}
	return err
}

func (e *gitopsPR) Observe(ctx context.Context, x *Exec) (Observation, string, error) {
	var p prParams
	if err := decode(x.Params, &p); err != nil {
		return NotApplied, "", err
	}
	r, _, err := e.repo(p)
	if err != nil {
		return NotApplied, "", err
	}
	pr, ok, err := r.FindPR(ctx, github.BranchName(x.ID()))
	if err != nil {
		return NotApplied, "", err
	}
	if ok {
		return Applied, "PR " + pr.HTMLURL, nil
	}
	if _, err := r.Head(ctx, github.BranchName(x.ID())); err == nil {
		return Partial, "分支已推送但没有 PR", nil
	}
	return NotApplied, "没有本次执行的分支", nil
}

func (e *gitopsPR) Verify(ctx context.Context, x *Exec) ([]execution.CheckResult, error) {
	var p prParams
	if err := decode(x.Params, &p); err != nil {
		return nil, err
	}
	r, _, err := e.repo(p)
	if err != nil {
		return nil, err
	}
	pr, ok, err := r.FindPR(ctx, github.BranchName(x.ID()))
	if err != nil {
		return nil, err
	}
	return []execution.CheckResult{check("pr_open", "git", ok && pr.State == "open", "PR 存在=%v state=%s %s", ok, pr.State, pr.HTMLURL)}, nil
}

func (e *gitopsPR) Undo(context.Context, *Exec) (string, error) { return "", ErrNoUndo }

// Compensation：提交 revert PR，作为新的提议再次审批。参数中的 patch 由中心按合入的提交生成（PR 未合入时关闭 PR 即可）。
func (e *gitopsPR) Compensation(x *Exec) *execution.Compensation {
	var p prParams
	if decode(x.Params, &p) != nil {
		return nil
	}
	params, err := json.Marshal(map[string]any{"repository": p.Repository, "base": p.Base, "title": "Revert " + p.Title})
	if err != nil {
		return nil
	}
	return &execution.Compensation{Action: "gitops_pr", Params: rawExt(params),
		Reason: "执行后校验失败：分支 " + github.BranchName(x.ID()) + " 上的 PR 未合入时关闭它；已合入时提交 revert PR，patch 由合入的提交生成"}
}

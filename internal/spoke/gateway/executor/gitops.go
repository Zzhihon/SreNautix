package executor

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/audit"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/execution"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/github"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/policy"
)

// gitopsPR 以 GitHub App 在 srenautix/ 分支上提交补丁并开 PR，从不合并（不变量 12，ADR 0025）。断言的 target_uid 是 base 分支
// 被批准时的提交 SHA（绑定 head SHA）。base 分支没有分支保护、策略也没有登记补偿控制时，预检 base_guarded 失败。
// 推送与开 PR 的补偿控制在 internal/spoke/gateway/github 中实现，这里把它的每个事件写入执行审计链并计数。
type gitopsPR struct{ d *Deps }

// PRParams 是 gitops_pr 的参数。
type PRParams struct {
	Repository string   `json:"repository"`
	Base       string   `json:"base"`
	Title      string   `json:"title"`
	Body       string   `json:"body"`
	Patch      string   `json:"patch"`
	Branch     string   `json:"branch"`
	Reviewers  []string `json:"reviewers"`
}

// branch 返回推送的分支：参数给出时用它，否则为 srenautix/<执行 ID>。
func (p PRParams) branch(executionID string) string {
	if p.Branch != "" {
		return p.Branch
	}
	return github.BranchName(executionID)
}

// reviewers 返回请求审阅的账号：参数给出时用它，否则为策略中该仓库的全部 reviewers。
func (p PRParams) reviewers(entry *policy.Repository) []string {
	if p.Reviewers != nil {
		return p.Reviewers
	}
	return entry.Reviewers
}

func (e *gitopsPR) repo(p PRParams) (*github.Repo, *policy.Repository, error) {
	if e.d.GitHub == nil {
		return nil, nil, errors.New("gitops_pr: no GitHub App is configured")
	}
	entry, ok := e.d.Policy().Repo(p.Repository)
	if !ok || entry.Base != p.Base {
		return nil, nil, fmt.Errorf("gitops_pr: %s@%s is not in the gateway policy", p.Repository, p.Base)
	}
	r, err := e.d.GitHub.Repo(p.Repository)
	return r, entry, err
}

func (e *gitopsPR) Resolve(ctx context.Context, params json.RawMessage) (*Resolved, error) {
	var p PRParams
	if err := decode(params, &p); err != nil {
		return nil, err
	}
	target := execution.TargetRef{Group: "srenautix.io", Version: "v1", Kind: "GitRepository", Resource: "gitrepositories", Name: p.Repository}
	res := &Resolved{Target: target, Domain: "gitops:" + p.Repository, BlastRadius: 1, Snapshot: map[string]any{}}
	r, entry, err := e.repo(p)
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
	guard := "没有分支保护，也没有登记补偿控制"
	switch {
	case protected:
		guard = "分支保护"
	case entry.CompensatingControls != nil:
		cc := entry.CompensatingControls
		guard = fmt.Sprintf("补偿控制（%s 于 %s 批准：%s）", cc.ApprovedBy, cc.ApprovedAt, cc.Reference)
	}
	watchOK, watchDetail := false, "main watchdog 尚未完成检查"
	if e.d.MainWatchdog != nil {
		watchOK, watchDetail = e.d.MainWatchdog(ctx, p.Repository)
	}
	// 分支名由执行 ID 决定时，预检阶段还不知道执行 ID：srenautix/<执行 ID> 由 at-most-once 保证不会重复，只检查显式给出的分支
	branchFree, branchDetail := true, "分支 srenautix/<执行 ID>"
	if p.Branch != "" {
		if !github.ValidBranch(p.Branch) {
			branchFree, branchDetail = false, p.Branch+" 不是合法的 srenautix/ 分支"
		} else {
			_, exists, err := r.HeadIfExists(ctx, p.Branch)
			if err != nil {
				return nil, err
			}
			branchFree, branchDetail = !exists, fmt.Sprintf("分支 %s 已存在=%v", p.Branch, exists)
		}
	}
	reviewers := p.reviewers(entry)
	parsed, perr := github.ParsePatch(p.Patch, entry.PathAllowed)
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
		check("base_guarded", "git", protected || entry.CompensatingControls != nil, "%s：%s", p.Base, guard),
		check("main_watchdog", "git", watchOK, "%s", watchDetail),
		check("branch_free", "git", branchFree, "%s", branchDetail),
		check("reviewers_allowed", "git", entry.ReviewersAllowed(reviewers), "请求审阅 %v，策略允许 %v", reviewers, entry.Reviewers),
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

// recorder 把补偿控制的事件写入本次执行的审计链，并按事件计数。
func (e *gitopsPR) recorder(x *Exec, repository string) github.Recorder {
	return func(ctx context.Context, ev github.Event) error {
		if m := e.d.Metrics; m != nil {
			switch ev.Verb {
			case "push":
				m.GitOpsPushes.WithLabelValues(repository, result(ev.Err)).Inc()
			case "check_base":
				if errors.Is(ev.Err, github.ErrBaseMoved) {
					m.GitOpsPushes.WithLabelValues(repository, "base_moved").Inc()
				}
			case "create":
				m.GitOpsPullRequests.WithLabelValues(repository, result(ev.Err)).Inc()
			case "denied":
				m.GitOpsDenied.WithLabelValues(ev.Detail).Inc()
			}
		}
		target := audit.Target{Group: "github", Resource: ev.Resource, Name: ev.Name, UID: ev.UID}
		verb := ev.Verb
		if ev.Detail != "" {
			verb += " " + ev.Detail
		}
		return x.Wrote(ctx, target, verb, ev.Err)
	}
}

func result(err error) string {
	if err != nil {
		return "error"
	}
	return "ok"
}

// Execute 在断言绑定的 base 提交之上建分支并开 PR。base 在执行前已前进时由引擎在执行前的复核中判为 stale；
// 在推送期间前进时 OpenPR 返回 github.ErrBaseMoved，不开 PR。
func (e *gitopsPR) Execute(ctx context.Context, x *Exec) error {
	var p PRParams
	if err := decode(x.Params, &p); err != nil {
		return err
	}
	r, entry, err := e.repo(p)
	if err != nil {
		return err
	}
	parsed, err := github.ParsePatch(p.Patch, entry.PathAllowed)
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
	body := p.Body + "\n\nSreNautix execution " + x.ID() + " (proposal " + x.AE.Spec.ProposalID + "). Review and merge are done by people."
	_, err = r.WithRecorder(e.recorder(x, p.Repository)).OpenPR(ctx, github.PRRequest{
		Base: p.Base, BaseSHA: base, Branch: p.branch(x.ID()), Title: p.Title, Body: body, Reviewers: p.reviewers(entry), Changes: changes,
	})
	return err
}

func (e *gitopsPR) Observe(ctx context.Context, x *Exec) (Observation, string, error) {
	var p PRParams
	if err := decode(x.Params, &p); err != nil {
		return NotApplied, "", err
	}
	r, _, err := e.repo(p)
	if err != nil {
		return NotApplied, "", err
	}
	branch := p.branch(x.ID())
	pr, ok, err := r.FindPR(ctx, branch)
	if err != nil {
		return NotApplied, "", err
	}
	if ok {
		return Applied, fmt.Sprintf("PR %s #%d", pr.HTMLURL, pr.Number), nil
	}
	_, exists, err := r.HeadIfExists(ctx, branch)
	if err != nil {
		return NotApplied, "", err
	}
	if exists {
		return Partial, "分支 " + branch + " 已推送但没有 PR", nil
	}
	return NotApplied, "没有本次执行的分支", nil
}

func (e *gitopsPR) Verify(ctx context.Context, x *Exec) ([]execution.CheckResult, error) {
	var p PRParams
	if err := decode(x.Params, &p); err != nil {
		return nil, err
	}
	r, _, err := e.repo(p)
	if err != nil {
		return nil, err
	}
	pr, ok, err := r.FindPR(ctx, p.branch(x.ID()))
	if err != nil {
		return nil, err
	}
	return []execution.CheckResult{check("pr_open", "git", ok && pr.State == "open", "PR %s #%d state=%s", pr.HTMLURL, pr.Number, pr.State)}, nil
}

// Undo 关闭本次开出的 PR。PR 已经由人合并时改动已经生效，撤销需要新的 revert 提议，返回 ErrUndoConflict（转人工）。
func (e *gitopsPR) Undo(ctx context.Context, x *Exec) (string, error) {
	var p PRParams
	if err := decode(x.Params, &p); err != nil {
		return "", err
	}
	r, _, err := e.repo(p)
	if err != nil {
		return "", err
	}
	pr, ok, err := r.FindPR(ctx, p.branch(x.ID()))
	if err != nil {
		return "", err
	}
	if !ok {
		return "没有本次执行的 PR", nil
	}
	full, err := r.GetPR(ctx, pr.Number)
	if err != nil {
		return "", err
	}
	if full.Merged {
		return "", fmt.Errorf("%w: PR %s was merged; a revert needs a new proposal", ErrUndoConflict, pr.HTMLURL)
	}
	if full.State == "closed" {
		return "PR " + pr.HTMLURL + " 已关闭", nil
	}
	if _, err := r.WithRecorder(e.recorder(x, p.Repository)).ClosePR(ctx, pr.Number); err != nil {
		return "", err
	}
	return "已关闭 PR " + pr.HTMLURL, nil
}

func (e *gitopsPR) Compensation(*Exec) *execution.Compensation { return nil }

// GitOpsRepository 返回 gitops_pr 参数中的仓库（引擎按仓库限速）。
func GitOpsRepository(params json.RawMessage) (string, error) {
	var p PRParams
	if err := decode(params, &p); err != nil {
		return "", err
	}
	return p.Repository, nil
}

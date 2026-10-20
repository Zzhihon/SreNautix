package invariants

import (
	"crypto/rand"
	"crypto/rsa"
	"fmt"
	"net/http"
	"reflect"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/assertion"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/audit"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/execution"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/github"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/gwtest"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/metrics"
	"github.com/Zzhihon/SreNautix/internal/spoke/testenv"
	"github.com/Zzhihon/SreNautix/internal/spoke/tunnel"
)

func patchReplicas(from, to int) string {
	return fmt.Sprintf(`diff --git a/deploy/values.yaml b/deploy/values.yaml
--- a/deploy/values.yaml
+++ b/deploy/values.yaml
@@ -1 +1 @@
-replicas: %d
+replicas: %d
`, from, to)
}

const gitopsRepo = "acme/infra"

func gitopsPolicy(compensating bool) string {
	cc := ""
	if compensating {
		cc = `, compensating_controls: {approved_by: octo-human, approved_at: "2026-10-20", reference: "phase 2 charter §4.1"}`
	}
	return gwtest.DefaultPolicy(gwtest.DefaultActions) + "  - id: gitops_pr\n" +
		"gitops:\n  max_prs_per_hour: 2\n  main_watchdog: {interval: 1s}\n  repositories:\n" +
		"    - {repository: " + gitopsRepo + ", base: main, paths: [deploy/], reviewers: [octo-reviewer]" + cc + "}\n"
}

// 不变量 12：gitops_pr 从不合并，base 分支有分支保护或经批准的补偿控制（ADR 0025）。
// 补偿控制逐项覆盖：请求白名单与客户端都没有合并；只推送 srenautix/ 分支，推送到 main 被拒；推送前后核对 base，竞争时不开 PR；
// 每次推送与开 PR 写入审计链；按小时限速；main watchdog 发现机器人写入或合并 main 时告警并停止推送。
// 冻结只约束集群写入：冻结期间 gitops_pr 照常执行，其余动作不执行。
// 设置 SRENAUTIX_TEST_GITHUB_API 时，Git 服务是 Kind 中的本地服务（真实 bare 仓库），否则是进程内的同一实现。
func TestInvariant12GitOpsNeverMerges(t *testing.T) {
	t.Run("no merge in the allowlist or the client", func(t *testing.T) {
		for _, c := range []struct {
			method, path string
			body         map[string]any
			reason       string
		}{
			{http.MethodPut, "/repos/acme/infra/pulls/1/merge", nil, github.DeniedMerge},
			{http.MethodPost, "/repos/acme/infra/merges", map[string]any{"base": "main", "head": "srenautix/x"}, github.DeniedMerge},
			{http.MethodPut, "/repos/acme/infra/pulls/1/merge", map[string]any{"merge_method": "squash"}, github.DeniedMerge},
			{http.MethodPatch, "/repos/acme/infra/git/refs/heads/main", map[string]any{"sha": "x"}, github.DeniedRefOutsidePrefix},
			{http.MethodPatch, "/repos/acme/infra/git/refs/heads/srenautix/x", map[string]any{"sha": "x", "force": true}, github.DeniedRefOutsidePrefix},
			{http.MethodDelete, "/repos/acme/infra/git/refs/heads/srenautix/x", nil, github.DeniedRefOutsidePrefix},
			{http.MethodPost, "/repos/acme/infra/git/refs", map[string]any{"ref": "refs/heads/main", "sha": "x"}, github.DeniedRefOutsidePrefix},
			{http.MethodPost, "/repos/acme/infra/git/refs", map[string]any{"ref": "refs/heads/srenautix/../main", "sha": "x"}, github.DeniedRefOutsidePrefix},
			{http.MethodPost, "/repos/acme/infra/git/refs", map[string]any{"ref": "refs/tags/v1", "sha": "x"}, github.DeniedRefOutsidePrefix},
			{http.MethodPost, "/repos/acme/infra/pulls", map[string]any{"head": "feature", "base": "main"}, github.DeniedRefOutsidePrefix},
			{http.MethodPost, "/repos/acme/infra/pulls", map[string]any{"head": "srenautix/x", "base": "srenautix/y"}, github.DeniedRefOutsidePrefix},
			{http.MethodPatch, "/repos/acme/infra/pulls/1", map[string]any{"state": "closed", "base": "other"}, github.DeniedOther},
			{http.MethodPut, "/repos/acme/infra/contents/deploy/values.yaml", map[string]any{"message": "x"}, github.DeniedOther},
			{http.MethodPost, "/repos/acme/infra/pulls/1/requested_reviewers", map[string]any{"reviewers": []string{"a"}, "team_reviewers": []string{"b"}}, github.DeniedOther},
		} {
			err := github.CheckRequest(c.method, c.path, c.body)
			var d *github.DeniedError
			if !asDenied(err, &d) || d.Reason != c.reason {
				t.Errorf("%s %s %v: got %v, want denial %s", c.method, c.path, c.body, err, c.reason)
			}
		}
		// 客户端没有任何合并方法
		for _, v := range []any{&github.App{}, &github.Repo{}} {
			typ := reflect.TypeOf(v)
			for i := range typ.NumMethod() {
				if strings.Contains(strings.ToLower(typ.Method(i).Name), "merge") {
					t.Errorf("%s has method %s", typ, typ.Method(i).Name)
				}
			}
		}
	})

	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	e := gwtest.New(t, gwtest.DefaultActions)
	e.F.Node("worker-1", false, true)
	e.F.Node("worker-2", false, true)
	gh := testenv.StartGitHub(t, "acme", "infra", "srenautix-test", "main", map[string]string{"deploy/values.yaml": "replicas: 2\n", "README.md": "infra\n"})
	app, err := github.New("1", "2", "srenautix-test", key, gh.URL, 10*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	e.GitHubApp = app
	e.WritePolicy(gitopsPolicy(false))
	g := e.Start(gwtest.Options{})
	replicas := 2
	ticket := func(mut func(map[string]any)) tunnel.Ticket {
		params := map[string]any{"repository": gitopsRepo, "base": "main", "title": "[影子] raise replicas", "patch": patchReplicas(replicas, replicas+1),
			"body": "<!-- srenautix:pr=summary -->\n## 结论\n副本不足"}
		if mut != nil {
			mut(params)
		}
		target := tunnel.TargetRef{Group: "srenautix.io", Version: "v1", Kind: "GitRepository", Name: gitopsRepo, UID: gh.Head("main")}
		return e.Ticket(e.Request("gitops_pr", params, target, assertion.LevelReversible, assertion.TierL))
	}
	condition := func(typ string) tunnel.Condition {
		for _, c := range g.Engine.Conditions() {
			if c.Type == typ {
				return c
			}
		}
		return tunnel.Condition{}
	}
	waitCondition := func(t *testing.T, typ, status string) tunnel.Condition {
		t.Helper()
		testenv.Eventually(t, 20*time.Second, typ+" becomes "+status, func() (bool, string) {
			c := condition(typ)
			return c.Status == status, fmt.Sprintf("%+v", c)
		})
		return condition(typ)
	}
	gitRecords := func() []audit.Record {
		var out []audit.Record
		for _, r := range e.ReadSinkRecords(g.Audit) {
			if r.Type == audit.TypeWrite && r.Target != nil && r.Target.Group == "github" {
				out = append(out, r)
			}
		}
		return out
	}
	assertNoForeignRefs := func(t *testing.T, base string) {
		t.Helper()
		refs := gh.Refs()
		if refs["main"] != base {
			t.Fatalf("main moved from %s to %s", base, refs["main"])
		}
		for name := range refs {
			if name != "main" && !strings.HasPrefix(name, github.BranchPrefix) {
				t.Fatalf("branch %s exists", name)
			}
		}
		for _, r := range gh.Requests() {
			if strings.Contains(r.Path, "merge") || r.Method == http.MethodPut || r.Method == http.MethodDelete {
				t.Fatalf("gateway sent %s %s", r.Method, r.Path)
			}
			if r.Method == http.MethodPost && strings.HasSuffix(r.Path, "/git/refs") && !strings.HasPrefix(r.Body["ref"].(string), "refs/heads/"+github.BranchPrefix) {
				t.Fatalf("gateway pushed %v", r.Body["ref"])
			}
		}
	}

	t.Run("unguarded base branch", func(t *testing.T) {
		e.T, e.F.T = t, t
		c := waitCondition(t, metrics.ConditionGitBaseGuarded, "False")
		if c.Reason != "unguarded" {
			t.Fatalf("condition %+v", c)
		}
		tk := ticket(nil)
		e.Offer(tk)
		phase, reason, _ := waitFinal(t, e, tk.Proposal.ProposalID, 30*time.Second, execution.PhaseRejected, execution.PhaseVerified, execution.PhaseFailed)
		if phase != execution.PhaseRejected || reason != "precheck_failed" || !strings.Contains(e.Hub.Describe(tk.Proposal.ProposalID), "base_guarded") {
			t.Fatalf("got %s/%s: %s", phase, reason, e.Hub.Describe(tk.Proposal.ProposalID))
		}
		assertNoForeignRefs(t, gh.Head("main"))
	})

	e.WritePolicy(gitopsPolicy(true))

	t.Run("compensating controls: push to srenautix/ only, audited, reviewers requested, human merge is not flagged", func(t *testing.T) {
		e.T, e.F.T = t, t
		c := waitCondition(t, metrics.ConditionGitBaseGuarded, "True")
		if c.Reason != "compensating_controls" {
			t.Fatalf("condition %+v", c)
		}
		waitCondition(t, metrics.ConditionGitMainWatchdog, "True")
		base := gh.Head("main")
		tk := ticket(func(p map[string]any) { p["branch"] = "srenautix/inc1-config_resource" })
		e.Offer(tk)
		e.WaitPhase(tk.Proposal.ProposalID, execution.PhaseVerified, 30*time.Second)
		// verified 事件带 PR 地址与编号，中心据此关联 issue
		if d := e.Hub.Describe(tk.Proposal.ProposalID); !regexp.MustCompile(`verified\(checks_passed: pr_open: PR \S+/pull/1 #1 state=open\)`).MatchString(d) {
			t.Fatalf("verified event: %s", d)
		}
		assertNoForeignRefs(t, base)
		refs := gh.Refs()
		v, ok := gh.File(refs["srenautix/inc1-config_resource"], "deploy/values.yaml")
		if !ok || v != "replicas: 3\n" {
			t.Fatalf("branch content %q", v)
		}
		var sawReviewers bool
		for _, r := range gh.Requests() {
			if strings.HasSuffix(r.Path, "/pulls/1/requested_reviewers") && fmt.Sprint(r.Body["reviewers"]) == "[octo-reviewer]" {
				sawReviewers = true
			}
		}
		if !sawReviewers {
			t.Fatal("reviewers were not requested")
		}
		testenv.Eventually(t, 30*time.Second, "push, base checks and PR are in the audit chain", func() (bool, string) {
			verbs := map[string]int{}
			for _, r := range gitRecords() {
				verb, _, _ := strings.Cut(r.Write.Verb, " ")
				verbs[verb+"/"+r.Write.Outcome]++
			}
			ok := verbs["push/succeeded"] == 1 && verbs["check_base/succeeded"] == 2 && verbs["create/succeeded"] == 1 && verbs["request_reviewers/succeeded"] == 1
			return ok, fmt.Sprint(verbs)
		})
		if n := testutil.ToFloat64(g.Metrics.GitOpsPushes.WithLabelValues(gitopsRepo, "ok")); n != 1 {
			t.Fatalf("pushes ok = %v", n)
		}
		// 人在网页上 squash 合并：提交的 author 是 App 机器人、committer 是 web-flow，PR 由人合并，不是非人工提交
		gh.Merge(1, testenv.Human, "squash")
		replicas = 3
		time.Sleep(3 * time.Second)
		if c := condition(metrics.ConditionGitMainWatchdog); c.Status != "True" {
			t.Fatalf("human squash merge flagged: %+v", c)
		}
	})

	t.Run("base moves during the push: no pull request", func(t *testing.T) {
		e.T, e.F.T = t, t
		gh.Race("main")
		tk := ticket(nil)
		id := e.Offer(tk)
		phase, reason, _ := waitFinal(t, e, tk.Proposal.ProposalID, 30*time.Second, execution.PhaseFailed, execution.PhaseVerified, execution.PhaseNeedsHuman)
		if phase != execution.PhaseFailed || reason != "base_moved" {
			t.Fatalf("got %s/%s: %s", phase, reason, e.Hub.Describe(tk.Proposal.ProposalID))
		}
		for _, r := range gh.Requests() {
			if r.Method == http.MethodPost && strings.HasSuffix(r.Path, "/pulls") && r.Body["head"] == github.BranchName(id) {
				t.Fatal("a pull request was opened after base moved")
			}
		}
		testenv.Eventually(t, 30*time.Second, "failed base check is audited", func() (bool, string) {
			for _, r := range gitRecords() {
				if strings.HasPrefix(r.Write.Verb, "check_base") && r.Write.Outcome == "failed" && r.ExecutionID == id {
					return true, ""
				}
			}
			return false, "no failed check_base record"
		})
		if n := testutil.ToFloat64(g.Metrics.GitOpsPushes.WithLabelValues(gitopsRepo, "base_moved")); n != 1 {
			t.Fatalf("pushes base_moved = %v", n)
		}
	})

	t.Run("frozen: gitops_pr executes, cluster actions do not", func(t *testing.T) {
		e.T, e.F.T = t, t
		cms := e.Kube.Core.CoreV1().ConfigMaps(testenv.Namespace)
		setFrozen := func(v string) {
			cm, err := cms.Get(bg, "srenautix-freeze", metav1.GetOptions{})
			if err != nil {
				t.Fatal(err)
			}
			cm.Data["frozen"] = v
			if _, err := cms.Update(bg, cm, metav1.UpdateOptions{}); err != nil {
				t.Fatal(err)
			}
		}
		setFrozen("true")
		defer setFrozen("false")
		testenv.Eventually(t, 20*time.Second, "heartbeat: propose_only, still accepting gitops_pr", func() (bool, string) {
			hb, ok := e.Hub.LastHeartbeat()
			return ok && hb.ProposeOnly && fmt.Sprint(hb.AcceptsActions) == "[gitops_pr]", fmt.Sprintf("%+v", hb)
		})
		// 中心不理会 actions 时，gateway 自己也不认领集群动作
		e.Hub.IgnoreActionFilter(true)
		defer e.Hub.IgnoreActionFilter(false)
		cordon := cordonTicket(e, "worker-1", nil)
		e.Offer(cordon)
		tk := ticket(nil)
		e.Offer(tk)
		e.WaitPhase(tk.Proposal.ProposalID, execution.PhaseVerified, 30*time.Second)
		time.Sleep(3 * time.Second)
		if evs := e.Hub.EventsForProposal(cordon.Proposal.ProposalID); len(evs) != 0 {
			t.Fatalf("frozen gateway handled a cluster action: %s", e.Hub.Describe(cordon.Proposal.ProposalID))
		}
		if unschedulable(t, e, "worker-1") {
			t.Fatal("node was cordoned while frozen")
		}
		// 冻结解除后，集群动作照常执行
		setFrozen("false")
		e.WaitPhase(cordon.Proposal.ProposalID, execution.PhaseVerifying, 30*time.Second)
	})

	t.Run("hourly cap", func(t *testing.T) {
		e.T, e.F.T = t, t
		tk := ticket(nil)
		e.Offer(tk)
		phase, reason, _ := waitFinal(t, e, tk.Proposal.ProposalID, 30*time.Second, execution.PhaseRejected, execution.PhaseVerified)
		if phase != execution.PhaseRejected || reason != "gitops_rate_limited" {
			t.Fatalf("got %s/%s: %s", phase, reason, e.Hub.Describe(tk.Proposal.ProposalID))
		}
		if n := testutil.ToFloat64(g.Metrics.GitOpsRateLimited.WithLabelValues(gitopsRepo)); n != 1 {
			t.Fatalf("rate limited = %v", n)
		}
	})

	t.Run("main watchdog: merge by the App and a direct push by the App", func(t *testing.T) {
		e.T, e.F.T = t, t
		// 冻结期间开出的 PR（#2）被 App 身份合并
		gh.Merge(2, gh.AppBot(), "merge")
		c := waitCondition(t, metrics.ConditionGitMainWatchdog, "False")
		if c.Reason != "unexpected_commits" || !strings.Contains(c.Message, "merged by srenautix-test[bot]") {
			t.Fatalf("condition %+v", c)
		}
		gh.Push("main", map[string]string{"deploy/values.yaml": "replicas: 9\n"}, gh.AppBot(), gh.AppBot(), "direct push")
		testenv.Eventually(t, 20*time.Second, "both commits counted", func() (bool, string) {
			n := testutil.ToFloat64(g.Metrics.MainUnexpected.WithLabelValues(gitopsRepo, github.ActorSreNautix))
			return n >= 2, fmt.Sprint(n)
		})
		if n := testutil.ToFloat64(g.Metrics.MainUnexpectedNow.WithLabelValues(gitopsRepo)); n < 2 {
			t.Fatalf("unexpected commits gauge = %v", n)
		}
		// 另一个机器人直接推送：同样告警
		gh.Push("main", map[string]string{"README.md": "bumped\n"}, testenv.GitHubAccount{Login: "renovate[bot]", Type: "Bot"},
			testenv.GitHubAccount{Login: "renovate[bot]", Type: "Bot"}, "chore: bump")
		testenv.Eventually(t, 20*time.Second, "other bot counted", func() (bool, string) {
			n := testutil.ToFloat64(g.Metrics.MainUnexpected.WithLabelValues(gitopsRepo, github.ActorOtherBot))
			return n == 1, fmt.Sprint(n)
		})
		// watchdog 告警期间不再推送
		replicas = 9
		tk := ticket(func(p map[string]any) { p["patch"] = patchReplicas(9, 10) })
		e.Offer(tk)
		phase, reason, _ := waitFinal(t, e, tk.Proposal.ProposalID, 30*time.Second, execution.PhaseRejected, execution.PhaseVerified)
		if phase != execution.PhaseRejected || reason != "precheck_failed" || !strings.Contains(e.Hub.Describe(tk.Proposal.ProposalID), "main_watchdog") {
			t.Fatalf("got %s/%s: %s", phase, reason, e.Hub.Describe(tk.Proposal.ProposalID))
		}
	})
}

func asDenied(err error, out **github.DeniedError) bool {
	d, ok := err.(*github.DeniedError)
	if ok {
		*out = d
	}
	return ok
}

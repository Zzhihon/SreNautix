package invariants

import (
	"crypto/rand"
	"crypto/rsa"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/assertion"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/execution"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/github"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/gwtest"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/metrics"
	"github.com/Zzhihon/SreNautix/internal/spoke/testenv"
	"github.com/Zzhihon/SreNautix/internal/spoke/tunnel"
)

const patch = `diff --git a/deploy/values.yaml b/deploy/values.yaml
--- a/deploy/values.yaml
+++ b/deploy/values.yaml
@@ -1 +1 @@
-replicas: 2
+replicas: 3
`

// 不变量 12：gitops_pr 从不合并。
// 请求白名单中没有合并、删除或改写已有分支的接口；gateway 只向 srenautix/ 分支推送；base 分支没有分支保护时
// 启动探测给出 False 条件，gitops_pr 被预检拒绝。
func TestInvariant12GitOpsNeverMerges(t *testing.T) {
	t.Run("request allowlist", func(t *testing.T) {
		for _, c := range []struct {
			method, path string
			body         map[string]any
		}{
			{http.MethodPut, "/repos/acme/infra/pulls/1/merge", nil},
			{http.MethodPost, "/repos/acme/infra/merges", map[string]any{"base": "main", "head": "srenautix/x"}},
			{http.MethodPatch, "/repos/acme/infra/git/refs/heads/main", map[string]any{"sha": "x"}},
			{http.MethodDelete, "/repos/acme/infra/git/refs/heads/srenautix/x", nil},
			{http.MethodPost, "/repos/acme/infra/git/refs", map[string]any{"ref": "refs/heads/main", "sha": "x"}},
			{http.MethodPost, "/repos/acme/infra/pulls", map[string]any{"head": "feature", "base": "main"}},
			{http.MethodPatch, "/repos/acme/infra/pulls/1", map[string]any{"state": "closed", "base": "other"}},
			{http.MethodPut, "/repos/acme/infra/contents/deploy/values.yaml", map[string]any{"message": "x"}},
		} {
			if err := github.CheckRequest(c.method, c.path, c.body); err == nil {
				t.Errorf("%s %s is allowed", c.method, c.path)
			}
		}
	})

	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	e := gwtest.New(t, gwtest.DefaultActions)
	gh := testenv.StartGitHub(t, "acme", "infra", "srenautix-test", "main", map[string]string{"deploy/values.yaml": "replicas: 2\n", "README.md": "infra\n"})
	app, err := github.New("1", "2", "srenautix-test", key, gh.Server.URL, 10*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	e.GitHubApp = app
	e.WritePolicy(gwtest.DefaultPolicy(gwtest.DefaultActions) + "  - id: gitops_pr\ngitops:\n  repositories:\n    - {repository: acme/infra, base: main, paths: [deploy/]}\n")
	g := e.Start(gwtest.Options{})
	ticket := func() tunnel.Ticket {
		params := map[string]any{"repository": "acme/infra", "base": "main", "title": "Raise replicas", "patch": patch}
		target := tunnel.TargetRef{Group: "srenautix.io", Version: "v1", Kind: "GitRepository", Name: "acme/infra", UID: gh.Head("main")}
		return e.Ticket(e.Request("gitops_pr", params, target, assertion.LevelCompensable, assertion.TierH))
	}
	conditionStatus := func() string {
		for _, c := range g.Engine.Conditions() {
			if c.Type == metrics.ConditionGitHubBranchProtection {
				return c.Status
			}
		}
		return ""
	}

	t.Run("unprotected base branch", func(t *testing.T) {
		e.T, e.F.T = t, t
		testenv.Eventually(t, 15*time.Second, "branch protection probe reports False", func() (bool, string) { return conditionStatus() == "False", conditionStatus() })
		tk := ticket()
		e.Offer(tk)
		phase, reason, _ := waitFinal(t, e, tk.Proposal.ProposalID, 30*time.Second, execution.PhaseRejected, execution.PhaseVerified, execution.PhaseFailed)
		if phase != execution.PhaseRejected || reason != "precheck_failed" {
			t.Fatalf("got %s/%s: %s", phase, reason, e.Hub.Describe(tk.Proposal.ProposalID))
		}
	})

	t.Run("protected base branch", func(t *testing.T) {
		e.T, e.F.T = t, t
		base := gh.Head("main")
		gh.SetProtected("main", true)
		testenv.Eventually(t, 15*time.Second, "branch protection probe reports True", func() (bool, string) { return conditionStatus() == "True", conditionStatus() })
		tk := ticket()
		id := e.Offer(tk)
		e.WaitPhase(tk.Proposal.ProposalID, execution.PhaseVerified, 30*time.Second)
		refs := gh.Refs()
		if refs["main"] != base {
			t.Fatalf("main moved from %s to %s", base, refs["main"])
		}
		branch := github.BranchName(id)
		v, ok := gh.File(refs[branch], "deploy/values.yaml")
		if !ok || v != "replicas: 3\n" {
			t.Fatalf("branch %s content %q", branch, v)
		}
		for name := range refs {
			if name != "main" && !strings.HasPrefix(name, github.BranchPrefix) {
				t.Fatalf("gateway created branch %s", name)
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
	})
}

package policy_test

import (
	"strings"
	"testing"

	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/catalog"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/policy"
)

func load(t *testing.T) *catalog.Catalog {
	t.Helper()
	c, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	return c
}

const base = `
version: 1
cluster: prod-east
approvers:
  - {principal: "oidc:alice", namespaces: [payments], max_tier: L}
  - {principal: "oidc:root", namespaces: ["*"], max_tier: H}
actions:
`

func TestAutoExecutionOnlyForReversible(t *testing.T) {
	cat := load(t)
	for _, a := range cat.Actions {
		ns := "namespaces: [payments]\n    "
		autoNS := ", namespaces: [payments]"
		if !a.Target.Namespaced {
			ns, autoNS = "", ""
		}
		doc := base + "  - id: " + a.ID + "\n    " + ns + "auto_execution: {rules: [stuck-pod]" + autoNS + "}\n"
		if a.ID == "gitops_pr" {
			doc += "gitops:\n  repositories:\n    - {repository: acme/infra, base: main, paths: [deploy/]}\n"
		}
		_, err := policy.Parse([]byte(doc), cat)
		if a.AutoAllowed() {
			if err != nil {
				t.Fatalf("%s: %v", a.ID, err)
			}
			continue
		}
		if err == nil || !strings.Contains(err.Error(), "cannot be executed automatically") {
			t.Fatalf("%s (%s): automatic execution must fail to load, got %v", a.ID, a.Level, err)
		}
	}
}

func TestPolicyRejections(t *testing.T) {
	cat := load(t)
	for what, doc := range map[string]string{
		"unknown action":              base + "  - id: delete_namespace\n    namespaces: [x]\n",
		"namespaced without list":     base + "  - id: workload_scale\n",
		"cluster target with list":    base + "  - id: node_cordon\n    namespaces: [x]\n",
		"auto outside namespaces":     base + "  - id: workload_scale\n    namespaces: [a]\n    auto_execution: {rules: [r], namespaces: [b]}\n",
		"workflow without allowlist":  base + "  - id: workflow_submit\n    namespaces: [ci]\n",
		"gitops without repositories": base + "  - id: gitops_pr\n",
		"duplicate action":            base + "  - id: node_cordon\n  - id: node_cordon\n",
		"schema violation":            base + "  - id: node_cordon\n    color: red\n",
	} {
		if _, err := policy.Parse([]byte(doc), cat); err == nil {
			t.Errorf("%s: policy loaded", what)
		}
	}
}

func TestApproverScope(t *testing.T) {
	cat := load(t)
	p, err := policy.Parse([]byte(base+"  - id: workload_scale\n    namespaces: [payments, ledger]\n    auto_execution: {rules: [stuck-pod], namespaces: [payments]}\n"), cat)
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		principal, channel, ns, tier string
		ok                           bool
	}{
		{"oidc:alice", "telegram", "payments", "L", true},
		{"oidc:alice", "telegram", "ledger", "L", false},
		{"oidc:alice", "console", "payments", "H", false},
		{"oidc:root", "console", "ledger", "H", true},
		{"oidc:root", "console", "", "H", true},
		{"oidc:mallory", "console", "payments", "L", false},
		{"auto:stuck-pod", "auto", "payments", "L", true},
		{"auto:stuck-pod", "auto", "ledger", "L", false},
		{"auto:other", "auto", "payments", "L", false},
		{"auto:stuck-pod", "telegram", "payments", "L", false},
		{"oidc:alice", "auto", "payments", "L", false},
	}
	for _, c := range cases {
		err := p.CheckApprover(c.principal, c.channel, "workload_scale", c.ns, c.tier)
		if (err == nil) != c.ok {
			t.Errorf("%+v: %v", c, err)
		}
	}
}

// gitops 设置：默认值、范围、路径白名单（完整路径、目录前缀、glob）、审阅人子集。
func TestGitOpsSettings(t *testing.T) {
	cat := load(t)
	doc := base + "  - id: gitops_pr\n    auto_execution: {rules: [remediation-pr]}\ngitops:\n  repositories:\n" +
		"    - repository: acme/infra\n      base: main\n      reviewers: [alice, bob]\n" +
		"      paths: [apps/cchp/prod/release.json, platform/observability/metrics/*.yaml, deploy/]\n" +
		"      compensating_controls: {approved_by: alice, approved_at: \"2026-10-20\", reference: charter}\n"
	p, err := policy.Parse([]byte(doc), cat)
	if err != nil {
		t.Fatal(err)
	}
	g := p.GitOps
	if g.PRsPerHour() != 2 || g.WatchdogInterval().String() != "5m0s" || g.WatchdogLookback().String() != "24h0m0s" {
		t.Fatalf("defaults %d %s %s", g.PRsPerHour(), g.WatchdogInterval(), g.WatchdogLookback())
	}
	r, ok := p.Repo("acme/infra")
	if !ok || r.CompensatingControls == nil || r.CompensatingControls.ApprovedBy != "alice" {
		t.Fatalf("repository %+v", r)
	}
	for path, want := range map[string]bool{
		"apps/cchp/prod/release.json":                  true,
		"apps/cchp/prod/other.json":                    false,
		"platform/observability/metrics/cchp.yaml":     true,
		"platform/observability/metrics/sub/cchp.yaml": false,
		"platform/observability/metrics/cchp.json":     false,
		"deploy/a/b.yaml":                              true,
	} {
		if r.PathAllowed(path) != want {
			t.Errorf("PathAllowed(%s) = %v", path, !want)
		}
	}
	if !r.ReviewersAllowed([]string{"bob"}) || r.ReviewersAllowed([]string{"mallory"}) {
		t.Fatal("reviewers subset")
	}
	for what, extra := range map[string]string{
		"interval too short": "  main_watchdog: {interval: 100ms}\n",
		"lookback too long":  "  main_watchdog: {lookback: 400h}\n",
		"cap too high":       "  max_prs_per_hour: 50\n",
	} {
		bad := strings.Replace(doc, "gitops:\n", "gitops:\n"+extra, 1)
		if _, err := policy.Parse([]byte(bad), cat); err == nil {
			t.Errorf("%s: loaded", what)
		}
	}
}

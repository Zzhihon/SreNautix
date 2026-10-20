// Package policy 加载 gateway 策略（Git 经 ConfigMap 挂载，contract/gateway/v1/gateway-policy.schema.json），
// 并与动作目录交叉核对：只能启用目录中的动作，自动执行只能用于目录允许的可撤销动作（不变量 7）。
package policy

import (
	"encoding/json"
	"fmt"
	"os"
	"path"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/assertion"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/catalog"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/schema"
)

// Auto 是一个动作的自动执行设置。
type Auto struct {
	Rules      []string `json:"rules"`
	Namespaces []string `json:"namespaces"`
}

// ActionPolicy 是一个启用的动作。
type ActionPolicy struct {
	ID         string   `json:"id"`
	Namespaces []string `json:"namespaces"`
	Auto       *Auto    `json:"auto_execution"`
}

// Approver 是一个审批人的作用域。
type Approver struct {
	Principal  string   `json:"principal"`
	Namespaces []string `json:"namespaces"`
	MaxTier    string   `json:"max_tier"`
}

// ParamRule 是工作流模板参数的约束。
type ParamRule struct {
	Enum      []string `json:"enum"`
	Pattern   string   `json:"pattern"`
	MaxLength int      `json:"max_length"`

	re *regexp.Regexp
}

// WorkflowTemplate 是 workflow_submit 白名单中的一个模板。
type WorkflowTemplate struct {
	Namespace      string                `json:"namespace"`
	Name           string                `json:"name"`
	SHA256         string                `json:"sha256"`
	ServiceAccount string                `json:"service_account"`
	Parameters     map[string]*ParamRule `json:"parameters"`
}

// Repository 是 gitops_pr 的一个仓库与路径白名单。
type Repository struct {
	Repository string   `json:"repository"`
	Base       string   `json:"base"`
	Paths      []string `json:"paths"`
	Reviewers  []string `json:"reviewers"`
	// CompensatingControls 不为 nil 表示 base 没有分支保护时以补偿控制代替（不变量 12，ADR 0025）
	CompensatingControls *CompensatingControls `json:"compensating_controls"`
}

// CompensatingControls 记录补偿控制的批准人与依据。
type CompensatingControls struct {
	ApprovedBy string `json:"approved_by"`
	ApprovedAt string `json:"approved_at"`
	Reference  string `json:"reference"`
}

// GitOps 是 gitops_pr 的仓库与补偿控制设置。
type GitOps struct {
	MaxPRsPerHour *int `json:"max_prs_per_hour"`
	MainWatchdog  struct {
		Interval    string   `json:"interval"`
		Lookback    string   `json:"lookback"`
		AllowedBots []string `json:"allowed_bots"`
	} `json:"main_watchdog"`
	Repositories []Repository `json:"repositories"`

	interval, lookback time.Duration
}

// PRsPerHour 返回每个仓库每小时开 PR 的上限（默认 2）。
func (g *GitOps) PRsPerHour() int {
	if g.MaxPRsPerHour == nil {
		return 2
	}
	return *g.MaxPRsPerHour
}

// WatchdogInterval 返回 main watchdog 的检查间隔（默认 5 分钟）。
func (g *GitOps) WatchdogInterval() time.Duration { return g.interval }

// WatchdogLookback 返回 main watchdog 的回看窗口（默认 24 小时）。
func (g *GitOps) WatchdogLookback() time.Duration { return g.lookback }

func (g *GitOps) parse() error {
	dur := func(s, def string, min, max time.Duration, field string) (time.Duration, error) {
		if s == "" {
			s = def
		}
		d, err := time.ParseDuration(s)
		if err != nil || d < min || d > max {
			return 0, fmt.Errorf("policy: gitops.main_watchdog.%s must be a duration between %s and %s, got %q", field, min, max, s)
		}
		return d, nil
	}
	var err error
	if g.interval, err = dur(g.MainWatchdog.Interval, "5m", time.Second, time.Hour, "interval"); err != nil {
		return err
	}
	if g.lookback, err = dur(g.MainWatchdog.Lookback, "24h", time.Hour, 168*time.Hour, "lookback"); err != nil {
		return err
	}
	seen := map[string]bool{}
	for _, r := range g.Repositories {
		if seen[r.Repository] {
			return fmt.Errorf("policy: gitops repository %s is listed twice", r.Repository)
		}
		seen[r.Repository] = true
	}
	return nil
}

// SelfDependencies 是 SreNautix 自身的依赖集合。
type SelfDependencies struct {
	Namespaces []string `json:"namespaces"`
	Nodes      []string `json:"nodes"`
	PGClusters []struct {
		Namespace string `json:"namespace"`
		Name      string `json:"name"`
	} `json:"pg_clusters"`
}

// Policy 是加载并核对过的策略。
type Policy struct {
	Version                  int                `json:"version"`
	Cluster                  string             `json:"cluster"`
	Actions                  []ActionPolicy     `json:"actions"`
	MaxAutoExecutionsPerHour *int               `json:"max_auto_executions_per_hour"`
	Self                     SelfDependencies   `json:"self_dependencies"`
	Approvers                []Approver         `json:"approvers"`
	WorkflowTemplates        []WorkflowTemplate `json:"workflow_templates"`
	GitOps                   *GitOps            `json:"gitops"`

	byID map[string]*ActionPolicy
}

// MaxAutoPerHour 返回每小时自动执行的上限（默认 6）。
func (p *Policy) MaxAutoPerHour() int {
	if p.MaxAutoExecutionsPerHour == nil {
		return 6
	}
	return *p.MaxAutoExecutionsPerHour
}

// Action 返回启用的动作策略。
func (p *Policy) Action(id string) (*ActionPolicy, bool) {
	a, ok := p.byID[id]
	return a, ok
}

// Enabled 返回启用的动作 ID，按字母排序。
func (p *Policy) Enabled() []string {
	var out []string
	for id := range p.byID {
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}

// Load 读取挂载的策略文件。
func Load(path string, cat *catalog.Catalog) (*Policy, error) {
	doc, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return Parse(doc, cat)
}

// Parse 校验策略文档并与目录交叉核对；任何不一致都使加载失败。
func Parse(doc []byte, cat *catalog.Catalog) (*Policy, error) {
	raw, err := schema.ValidateYAML(schema.GatewayPolicy, doc)
	if err != nil {
		return nil, err
	}
	var p Policy
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, err
	}
	p.byID = map[string]*ActionPolicy{}
	for i := range p.Actions {
		ap := &p.Actions[i]
		a, ok := cat.Get(ap.ID)
		if !ok {
			return nil, fmt.Errorf("policy: action %s is not in the catalog", ap.ID)
		}
		if _, dup := p.byID[ap.ID]; dup {
			return nil, fmt.Errorf("policy: action %s is enabled twice", ap.ID)
		}
		if a.Target.Namespaced != (len(ap.Namespaces) > 0) {
			return nil, fmt.Errorf("policy: action %s: namespaces are required for namespaced targets and forbidden for cluster-scoped ones", ap.ID)
		}
		if ap.Auto != nil {
			if !a.AutoAllowed() {
				return nil, fmt.Errorf("policy: action %s (level %s) cannot be executed automatically", ap.ID, a.Level)
			}
			if a.Target.Namespaced != (len(ap.Auto.Namespaces) > 0) {
				return nil, fmt.Errorf("policy: action %s: auto_execution.namespaces are required for namespaced targets and forbidden for cluster-scoped ones", ap.ID)
			}
			if a.Target.Namespaced {
				for _, ns := range ap.Auto.Namespaces {
					if !contains(ap.Namespaces, ns) {
						return nil, fmt.Errorf("policy: action %s: auto namespace %s is not an enabled namespace", ap.ID, ns)
					}
				}
			}
		}
		p.byID[ap.ID] = ap
	}
	if _, ok := p.byID["workflow_submit"]; ok && len(p.WorkflowTemplates) == 0 {
		return nil, fmt.Errorf("policy: workflow_submit is enabled without workflow_templates")
	}
	for i := range p.WorkflowTemplates {
		wt := &p.WorkflowTemplates[i]
		for name, r := range wt.Parameters {
			if r.Pattern != "" {
				if r.re, err = regexp.Compile(r.Pattern); err != nil {
					return nil, fmt.Errorf("policy: workflow template %s/%s parameter %s: %w", wt.Namespace, wt.Name, name, err)
				}
			}
		}
	}
	if _, ok := p.byID["gitops_pr"]; ok && (p.GitOps == nil || len(p.GitOps.Repositories) == 0) {
		return nil, fmt.Errorf("policy: gitops_pr is enabled without gitops.repositories")
	}
	if p.GitOps != nil {
		if err := p.GitOps.parse(); err != nil {
			return nil, err
		}
	}
	for _, ap := range p.Approvers {
		if strings.HasPrefix(ap.Principal, "auto:") {
			return nil, fmt.Errorf("policy: approver %s: auto:<rule> principals come from auto_execution rules", ap.Principal)
		}
	}
	return &p, nil
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// NamespaceAllowed 表示目标命名空间在动作的启用范围内；集群级目标传空串。
func (ap *ActionPolicy) NamespaceAllowed(ns string) bool {
	if ns == "" {
		return len(ap.Namespaces) == 0
	}
	return contains(ap.Namespaces, ns)
}

// ScopeError 是审批人作用域的拒绝原因。
type ScopeError struct{ Reason string }

func (e *ScopeError) Error() string { return e.Reason }

// CheckApprover 核对审批人的作用域：按目标所在的命名空间（集群级目标为空串）与档位（DESIGN §9.2、§13）。
// 自动批准的审批人 auto:<规则名> 必须是该动作 auto_execution 中的规则，且命名空间在自动执行范围内。
func (p *Policy) CheckApprover(principal, channel, action, namespace, tier string) error {
	if rule, ok := strings.CutPrefix(principal, "auto:"); ok {
		if channel != assertion.ChannelAuto {
			return &ScopeError{"auto:<rule> principals must use the auto channel"}
		}
		ap, ok := p.byID[action]
		if !ok || ap.Auto == nil || !contains(ap.Auto.Rules, rule) {
			return &ScopeError{fmt.Sprintf("rule %q may not approve %s automatically", rule, action)}
		}
		if namespace != "" && !contains(ap.Auto.Namespaces, namespace) {
			return &ScopeError{fmt.Sprintf("%s is not executed automatically in namespace %s", action, namespace)}
		}
		if tier != assertion.TierL {
			return &ScopeError{"automatic approvals are L tier only"}
		}
		return nil
	}
	if channel == assertion.ChannelAuto {
		return &ScopeError{"the auto channel requires an auto:<rule> principal"}
	}
	for _, ap := range p.Approvers {
		if ap.Principal != principal {
			continue
		}
		if assertion.TierRank(tier) > assertion.TierRank(ap.MaxTier) {
			continue
		}
		if contains(ap.Namespaces, "*") || (namespace != "" && contains(ap.Namespaces, namespace)) {
			return nil
		}
	}
	return &ScopeError{fmt.Sprintf("approver %s has no %s-tier scope over namespace %q", principal, tier, namespace)}
}

// IsSelfDependency 表示目标落在 SreNautix 自身的依赖集合中；extraNodes 为运行时得知的节点（gateway 所在节点）。
func (p *Policy) IsSelfDependency(namespace string, nodes []string, pg *[2]string, extraNodes []string) bool {
	if namespace != "" && contains(p.Self.Namespaces, namespace) {
		return true
	}
	for _, n := range nodes {
		if contains(p.Self.Nodes, n) || contains(extraNodes, n) {
			return true
		}
	}
	if pg != nil {
		for _, c := range p.Self.PGClusters {
			if c.Namespace == pg[0] && c.Name == pg[1] {
				return true
			}
		}
	}
	return false
}

// Template 返回白名单中的工作流模板。
func (p *Policy) Template(namespace, name string) (*WorkflowTemplate, bool) {
	for i := range p.WorkflowTemplates {
		if p.WorkflowTemplates[i].Namespace == namespace && p.WorkflowTemplates[i].Name == name {
			return &p.WorkflowTemplates[i], true
		}
	}
	return nil, false
}

// CheckParameters 核对提交的参数恰好是白名单中的名称，且取值满足约束。
func (wt *WorkflowTemplate) CheckParameters(params map[string]string) error {
	for name := range params {
		if _, ok := wt.Parameters[name]; !ok {
			return fmt.Errorf("parameter %s is not allowed for %s/%s", name, wt.Namespace, wt.Name)
		}
	}
	for name, r := range wt.Parameters {
		v, ok := params[name]
		if !ok {
			return fmt.Errorf("parameter %s is required for %s/%s", name, wt.Namespace, wt.Name)
		}
		if len(r.Enum) > 0 && !contains(r.Enum, v) {
			return fmt.Errorf("parameter %s=%q is not one of %v", name, v, r.Enum)
		}
		if r.re != nil && !r.re.MatchString(v) {
			return fmt.Errorf("parameter %s=%q does not match %s", name, v, r.Pattern)
		}
		if r.MaxLength > 0 && len(v) > r.MaxLength {
			return fmt.Errorf("parameter %s is longer than %d", name, r.MaxLength)
		}
	}
	return nil
}

// Repo 返回 gitops_pr 白名单中的仓库。
func (p *Policy) Repo(repository string) (*Repository, bool) {
	if p.GitOps == nil {
		return nil, false
	}
	for i := range p.GitOps.Repositories {
		if p.GitOps.Repositories[i].Repository == repository {
			return &p.GitOps.Repositories[i], true
		}
	}
	return nil, false
}

// ReviewersAllowed 表示 reviewers 都在该仓库的 reviewers 中。
func (r *Repository) ReviewersAllowed(reviewers []string) bool {
	for _, v := range reviewers {
		if !contains(r.Reviewers, v) {
			return false
		}
	}
	return true
}

// PathAllowed 表示补丁可以修改该路径：等于白名单中的完整路径，在以 / 结尾的目录前缀之下，
// 或匹配含 * ? [ 的模式（path.Match 语义，* 不跨越 /）。
func (r *Repository) PathAllowed(p string) bool {
	for _, allowed := range r.Paths {
		switch {
		case strings.HasSuffix(allowed, "/") && strings.HasPrefix(p, allowed):
			return true
		case p == allowed:
			return true
		case strings.ContainsAny(allowed, "*?["):
			if ok, err := path.Match(allowed, p); err == nil && ok {
				return true
			}
		}
	}
	return false
}

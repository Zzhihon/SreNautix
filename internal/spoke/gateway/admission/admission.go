// Package admission 从动作目录生成 gateway 的 ValidatingAdmissionPolicy 与 RBAC 规则（DESIGN §9.4、不变量 2、11）。
//
// 输出写到 deploy/helm/srenautix/files/admission/：index.yaml 列出每个动作需要的策略文件与 ClusterRole 规则，
// 每个策略文件恰好一个 ValidatingAdmissionPolicy。chart 为每个策略生成 Binding（paramRef 指向 srenautix-freeze，
// parameterNotFoundAction: Deny）。策略文件经 Helm tpl 渲染，ServiceAccount 用户名与名称前缀以 include 写入；
// 测试用 Options 填入具体值，在 envtest 的 apiserver 上运行同一份生成结果。
//
// 每个策略：
//   - 只匹配 gateway 的 ServiceAccount；
//   - 声明 paramKind ConfigMap，frozen 不等于 "false" 或 ConfigMap 缺失时拒绝写入；
//   - 另外匹配 ActionExecution 的 CREATE：带 srenautix.io/admission-probe=<策略短名> 标签的对象一律拒绝，
//     gateway 以 dryRun=All 提交这样的对象做自检，被放行即说明该策略或其 Binding 失效（不变量 3）。
package admission

import (
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/catalog"
)

// ProbeLabel 是自检探针对象的标签，取值为策略短名。
const ProbeLabel = "srenautix.io/admission-probe"

// 允许 gateway 写入的注解。
const (
	AnnotationExecutionID = "srenautix.io/execution-id"
	AnnotationCordonedBy  = "srenautix.io/cordoned-by"
	AnnotationFluxRequest = "reconcile.fluxcd.io/requestedAt"
)

// Options 决定策略中的 ServiceAccount 用户名与名称前缀。
type Options struct {
	Username string
	Prefix   string
}

// HelmOptions 生成供 Helm tpl 渲染的策略文件。
func HelmOptions() Options {
	return Options{
		Username: `{{ include "srenautix.gateway.username" . }}`,
		Prefix:   `{{ include "srenautix.fullname" . }}`,
	}
}

// Rule 是 ClusterRole 规则。
type Rule struct {
	APIGroups     []string `json:"apiGroups"`
	Resources     []string `json:"resources"`
	ResourceNames []string `json:"resourceNames,omitempty"`
	Verbs         []string `json:"verbs"`
}

// ActionEntry 是 index.yaml 中一个动作的条目。
type ActionEntry struct {
	Policies []string `json:"policies"`
	Rules    []Rule   `json:"rules"`
}

// Index 是 index.yaml。
type Index struct {
	Actions map[string]ActionEntry `json:"actions"`
}

// Policy 是一个生成的策略。
type Policy struct {
	Short string
	File  string
	Doc   map[string]any
}

// Name 返回策略的 metadata.name。
func (p Policy) Name() string { return p.Doc["metadata"].(map[string]any)["name"].(string) }

// Output 是生成结果。
type Output struct {
	Policies []Policy
	Index    Index
}

// Policy 返回短名对应的策略。
func (o *Output) Policy(short string) (Policy, bool) {
	for _, p := range o.Policies {
		if p.Short == short {
			return p, true
		}
	}
	return Policy{}, false
}

var readVerbs = []string{"get", "list", "watch"}

func read(group string, resources ...string) Rule {
	return Rule{APIGroups: []string{group}, Resources: resources, Verbs: readVerbs}
}

// workloadReads 是判断 Pod 属主、就绪副本与 PDB 余量所需的读取。
var workloadReads = []Rule{
	read("", "pods"),
	read("apps", "deployments", "statefulsets", "replicasets", "daemonsets"),
	read("policy", "poddisruptionbudgets"),
}

// actionPlan 是每个动作的策略与额外读取；写入规则由目录中的 writes 生成。
var actionPlan = map[string]struct {
	policies []string
	reads    []Rule
}{
	"pod_restart":                    {[]string{"pod-eviction"}, workloadReads},
	"workload_rolling_restart":       {[]string{"pod-eviction"}, workloadReads},
	"workload_scale":                 {[]string{"workload-deployments", "workload-statefulsets"}, append(append([]Rule{}, workloadReads...), read("autoscaling", "horizontalpodautoscalers"))},
	"hpa_bounds_set":                 {[]string{"hpa-bounds"}, []Rule{read("autoscaling", "horizontalpodautoscalers")}},
	"rollout_pause":                  {[]string{"workload-deployments"}, []Rule{read("apps", "deployments")}},
	"rollout_resume":                 {[]string{"workload-deployments"}, []Rule{read("apps", "deployments")}},
	"cronjob_suspend":                {[]string{"cronjob-suspend"}, []Rule{read("batch", "cronjobs")}},
	"cronjob_resume":                 {[]string{"cronjob-suspend"}, []Rule{read("batch", "cronjobs")}},
	"node_cordon":                    {[]string{"node-scheduling"}, []Rule{read("", "nodes")}},
	"node_uncordon":                  {[]string{"node-scheduling"}, []Rule{read("", "nodes")}},
	"cnpg_replica_restart":           {[]string{"pod-eviction"}, []Rule{read("", "pods"), read("postgresql.cnpg.io", "clusters"), read("policy", "poddisruptionbudgets")}},
	"cnpg_switchover":                {[]string{"cnpg-switchover"}, []Rule{read("", "pods"), read("postgresql.cnpg.io", "clusters")}},
	"argocd_app_sync":                {[]string{"argocd-applications"}, []Rule{read("argoproj.io", "applications")}},
	"argocd_app_terminate_operation": {[]string{"argocd-applications"}, []Rule{read("argoproj.io", "applications")}},
	"argocd_autosync_suspend":        {[]string{"argocd-applications"}, []Rule{read("argoproj.io", "applications")}},
	"argocd_autosync_resume":         {[]string{"argocd-applications"}, []Rule{read("argoproj.io", "applications")}},
	"flux_suspend":                   {[]string{"flux-objects"}, []Rule{read("kustomize.toolkit.fluxcd.io", "kustomizations"), read("helm.toolkit.fluxcd.io", "helmreleases")}},
	"flux_resume":                    {[]string{"flux-objects"}, []Rule{read("kustomize.toolkit.fluxcd.io", "kustomizations"), read("helm.toolkit.fluxcd.io", "helmreleases")}},
	"flux_reconcile":                 {[]string{"flux-objects"}, []Rule{read("kustomize.toolkit.fluxcd.io", "kustomizations"), read("helm.toolkit.fluxcd.io", "helmreleases")}},
	"workflow_submit":                {[]string{"argo-workflows"}, []Rule{read("argoproj.io", "workflowtemplates", "workflows")}},
	"workflow_terminate":             {[]string{"argo-workflows"}, []Rule{read("argoproj.io", "workflows")}},
	"gitops_pr":                      {nil, nil},
}

// Generate 为目录中的全部动作生成策略与 index；目录中有动作没有生成规则时失败。
func Generate(cat *catalog.Catalog, opts Options) (*Output, error) {
	if opts.Username == "" || opts.Prefix == "" {
		return nil, fmt.Errorf("admission: username and prefix are required")
	}
	out := &Output{Index: Index{Actions: map[string]ActionEntry{}}}
	used := map[string]bool{}
	for _, a := range cat.Actions {
		plan, ok := actionPlan[a.ID]
		if !ok {
			return nil, fmt.Errorf("admission: catalog action %s has no admission plan", a.ID)
		}
		if (len(a.Writes) == 0) != (len(plan.policies) == 0) {
			return nil, fmt.Errorf("admission: action %s writes %v but maps to policies %v", a.ID, a.Writes, plan.policies)
		}
		rules := append([]Rule{}, plan.reads...)
		for _, w := range a.Writes {
			res := w.Resource
			if w.Subresource != "" {
				res += "/" + w.Subresource
			}
			rules = append(rules, Rule{APIGroups: []string{w.Group}, Resources: []string{res}, Verbs: []string{w.Verb}})
		}
		files := []string{}
		for _, short := range plan.policies {
			files = append(files, short+".yaml")
			used[short] = true
		}
		out.Index.Actions[a.ID] = ActionEntry{Policies: files, Rules: mergeRules(rules)}
	}
	for id := range actionPlan {
		if _, ok := cat.Get(id); !ok {
			return nil, fmt.Errorf("admission: plan for %s has no catalog action", id)
		}
	}
	shorts := make([]string, 0, len(used))
	for s := range used {
		shorts = append(shorts, s)
	}
	sort.Strings(shorts)
	for _, s := range shorts {
		build, ok := builders[s]
		if !ok {
			return nil, fmt.Errorf("admission: no builder for policy %s", s)
		}
		out.Policies = append(out.Policies, Policy{Short: s, File: s + ".yaml", Doc: build(opts, s)})
	}
	return out, nil
}

// mergeRules 合并组与资源相同的规则的动词，输出顺序固定。
func mergeRules(rules []Rule) []Rule {
	type key struct{ group, resource string }
	verbs := map[key]map[string]bool{}
	var order []key
	for _, r := range rules {
		for _, g := range r.APIGroups {
			for _, res := range r.Resources {
				k := key{g, res}
				if verbs[k] == nil {
					verbs[k] = map[string]bool{}
					order = append(order, k)
				}
				for _, v := range r.Verbs {
					verbs[k][v] = true
				}
			}
		}
	}
	sort.Slice(order, func(i, j int) bool {
		if order[i].group != order[j].group {
			return order[i].group < order[j].group
		}
		return order[i].resource < order[j].resource
	})
	var out []Rule
	for _, k := range order {
		var vs []string
		for v := range verbs[k] {
			vs = append(vs, v)
		}
		sort.Strings(vs)
		out = append(out, Rule{APIGroups: []string{k.group}, Resources: []string{k.resource}, Verbs: vs})
	}
	return out
}

// ── CEL 片段 ───────────────────────────────────────────────────────

// celString 返回 CEL 字符串字面量。
func celString(s string) string { return strconv.Quote(s) }

func celList(items []string) string {
	q := make([]string, len(items))
	for i, s := range items {
		q[i] = celString(s)
	}
	return "[" + strings.Join(q, ", ") + "]"
}

// sameFields 生成 `object.<path>.?f == oldObject.<path>.?f && ...`。
func sameFields(path string, fields []string) string {
	var parts []string
	for _, f := range fields {
		parts = append(parts, fmt.Sprintf("object.%s.?%s == oldObject.%s.?%s", path, f, path, f))
	}
	return strings.Join(parts, " &&\n")
}

// annotationsExcept 生成"除 allowed 中的键外注解保持原值"。
func annotationsExcept(allowed []string) string {
	l := celList(allowed)
	return fmt.Sprintf("variables.annOld.all(k, k in %s || (k in variables.annNew && variables.annNew[k] == variables.annOld[k])) &&\n"+
		"variables.annNew.all(k, k in %s || k in variables.annOld)", l, l)
}

// executionAnnotationValid 要求执行 ID 注解（如果有）是 32 位小写十六进制。
const executionAnnotationValid = `(!('` + AnnotationExecutionID + `' in variables.annNew) || variables.annNew['` + AnnotationExecutionID + `'].matches('^[0-9a-f]{32}$'))`

type validation struct {
	expr string
	msg  string
}

type resourceRule struct {
	group, version string
	resources      []string
	operations     []string
}

// policy 组装一个策略：匹配 gateway 用户、freeze 参数、ActionExecution 自检探针，并把每条校验限定在非 ActionExecution 请求上。
func buildPolicy(opts Options, short, comment string, rules []resourceRule, vars [][2]string, vals []validation) map[string]any {
	var rr []any
	for _, r := range rules {
		rr = append(rr, map[string]any{
			"apiGroups": []any{r.group}, "apiVersions": []any{r.version},
			"resources": toAny(r.resources), "operations": toAny(r.operations),
		})
	}
	rr = append(rr, map[string]any{
		"apiGroups": []any{"srenautix.io"}, "apiVersions": []any{"v1"},
		"resources": []any{"actionexecutions"}, "operations": []any{"CREATE"},
	})
	variables := []any{
		map[string]any{"name": "isRecord", "expression": "request.resource.group == 'srenautix.io' && request.resource.resource == 'actionexecutions'"},
	}
	for _, v := range vars {
		variables = append(variables, map[string]any{"name": v[0], "expression": v[1]})
	}
	validations := []any{
		map[string]any{
			"expression": "!variables.isRecord || object.metadata.?labels.orValue({})[?'" + ProbeLabel + "'].orValue('') != '" + short + "'",
			"message":    "admission self-check probe denied by " + short,
		},
		map[string]any{
			"expression": "variables.isRecord || params.?data.?frozen.orValue('true') == 'false'",
			"message":    "srenautix-freeze is frozen or missing, gateway writes are proposal-only",
		},
	}
	for _, v := range vals {
		validations = append(validations, map[string]any{"expression": "variables.isRecord || (" + v.expr + ")", "message": v.msg})
	}
	return map[string]any{
		"apiVersion": "admissionregistration.k8s.io/v1",
		"kind":       "ValidatingAdmissionPolicy",
		"metadata": map[string]any{
			"name": opts.Prefix + "-gateway-" + short,
			"labels": map[string]any{
				"app.kubernetes.io/name":      "srenautix",
				"app.kubernetes.io/component": "gateway-admission",
			},
			"annotations": map[string]any{"srenautix.io/description": comment},
		},
		"spec": map[string]any{
			"failurePolicy":    "Fail",
			"paramKind":        map[string]any{"apiVersion": "v1", "kind": "ConfigMap"},
			"matchConstraints": map[string]any{"resourceRules": rr},
			"matchConditions": []any{map[string]any{
				"name":       "gateway-only",
				"expression": "request.userInfo.username == '" + opts.Username + "'",
			}},
			"variables":   variables,
			"validations": validations,
		},
	}
}

func toAny(ss []string) []any {
	out := make([]any, len(ss))
	for i, s := range ss {
		out[i] = s
	}
	return out
}

var annVars = [][2]string{
	{"annOld", "oldObject.metadata.?annotations.orValue({})"},
	{"annNew", "object.metadata.?annotations.orValue({})"},
}

// metaUnchanged 要求标签、属主、finalizer 不变，注解只在 allowed 范围内变化。
func metaUnchanged(allowed []string) validation {
	return validation{
		expr: "object.metadata.?labels == oldObject.metadata.?labels &&\n" +
			"object.metadata.?ownerReferences == oldObject.metadata.?ownerReferences &&\n" +
			"object.metadata.?finalizers == oldObject.metadata.?finalizers &&\n" +
			annotationsExcept(allowed) + " &&\n" + executionAnnotationValid,
		msg: "gateway may only add its execution annotations; labels, owners, finalizers and other annotations must not change",
	}
}

var builders = map[string]func(Options, string) map[string]any{
	"pod-eviction":          podEviction,
	"workload-deployments":  workloadDeployments,
	"workload-statefulsets": workloadStatefulSets,
	"hpa-bounds":            hpaBounds,
	"cronjob-suspend":       cronJobSuspend,
	"node-scheduling":       nodeScheduling,
	"cnpg-switchover":       cnpgSwitchover,
	"argocd-applications":   argoApplications,
	"flux-objects":          fluxObjects,
	"argo-workflows":        argoWorkflows,
}

func podEviction(o Options, short string) map[string]any {
	return buildPolicy(o, short, "pod_restart、workload_rolling_restart、cnpg_replica_restart：Eviction 必须与 Pod 同名、带 UID 前置条件，不缩短优雅终止时间，不改变删除传播",
		[]resourceRule{{"", "v1", []string{"pods/eviction"}, []string{"CREATE"}}}, nil,
		[]validation{{
			expr: "object.metadata.?name == optional.of(request.name) &&\n" +
				"object.?deleteOptions.?preconditions.?uid.orValue('') != '' &&\n" +
				"!object.?deleteOptions.?gracePeriodSeconds.hasValue() &&\n" +
				"!object.?deleteOptions.?propagationPolicy.hasValue() &&\n" +
				"!object.?deleteOptions.?orphanDependents.hasValue()",
			msg: "gateway evictions must name the Pod, carry its UID precondition and keep the default grace period and deletion semantics",
		}})
}

func workloadDeployments(o Options, short string) map[string]any {
	return buildPolicy(o, short, "workload_scale、rollout_pause、rollout_resume：Deployment 只改 spec.replicas 与 spec.paused",
		[]resourceRule{{"apps", "v1", []string{"deployments"}, []string{"UPDATE"}}}, annVars,
		[]validation{
			metaUnchanged([]string{AnnotationExecutionID}),
			{expr: sameFields("spec", deploymentSpecFields), msg: "gateway may only change spec.replicas and spec.paused of a Deployment"},
		})
}

func workloadStatefulSets(o Options, short string) map[string]any {
	return buildPolicy(o, short, "workload_scale：StatefulSet 只改 spec.replicas",
		[]resourceRule{{"apps", "v1", []string{"statefulsets"}, []string{"UPDATE"}}}, annVars,
		[]validation{
			metaUnchanged([]string{AnnotationExecutionID}),
			{expr: sameFields("spec", statefulSetSpecFields), msg: "gateway may only change spec.replicas of a StatefulSet"},
		})
}

func hpaBounds(o Options, short string) map[string]any {
	return buildPolicy(o, short, "hpa_bounds_set：HorizontalPodAutoscaler 只改 spec.minReplicas 与 spec.maxReplicas，且下限不大于上限",
		[]resourceRule{{"autoscaling", "v2", []string{"horizontalpodautoscalers"}, []string{"UPDATE"}}}, annVars,
		[]validation{
			metaUnchanged([]string{AnnotationExecutionID}),
			{expr: sameFields("spec", hpaSpecFields) + " &&\nobject.spec.?minReplicas.orValue(1) <= object.spec.maxReplicas",
				msg: "gateway may only change spec.minReplicas and spec.maxReplicas of a HorizontalPodAutoscaler"},
		})
}

func cronJobSuspend(o Options, short string) map[string]any {
	return buildPolicy(o, short, "cronjob_suspend、cronjob_resume：CronJob 只改 spec.suspend",
		[]resourceRule{{"batch", "v1", []string{"cronjobs"}, []string{"UPDATE"}}}, annVars,
		[]validation{
			metaUnchanged([]string{AnnotationExecutionID}),
			{expr: sameFields("spec", cronJobSpecFields), msg: "gateway may only change spec.suspend of a CronJob"},
		})
}

func nodeScheduling(o Options, short string) map[string]any {
	return buildPolicy(o, short, "node_cordon、node_uncordon：Node 只改 spec.unschedulable 与 srenautix.io/cordoned-by；控制面节点不能被 cordon",
		[]resourceRule{{"", "v1", []string{"nodes"}, []string{"UPDATE"}}}, annVars,
		[]validation{
			metaUnchanged([]string{AnnotationExecutionID, AnnotationCordonedBy}),
			{expr: sameFields("spec", nodeSpecFields), msg: "gateway may only change spec.unschedulable of a Node"},
			{expr: "!object.spec.?unschedulable.orValue(false) || !('node-role.kubernetes.io/control-plane' in oldObject.metadata.?labels.orValue({}))",
				msg: "gateway may not cordon a control-plane node"},
			{expr: "!('" + AnnotationCordonedBy + "' in variables.annNew) || variables.annNew['" + AnnotationCordonedBy + "'].matches('^[0-9a-f]{32}$')",
				msg: AnnotationCordonedBy + " must name an execution id"},
		})
}

func cnpgSwitchover(o Options, short string) map[string]any {
	return buildPolicy(o, short, "cnpg_switchover：Cluster status 只改 kubectl cnpg promote 写入的字段，targetPrimary 必须是现有实例",
		[]resourceRule{{"postgresql.cnpg.io", "v1", []string{"clusters/status"}, []string{"UPDATE"}}},
		[][2]string{{"otherStatusUnchanged", sameFields("status", cnpgStatusFields)}},
		[]validation{{
			expr: "has(object.status.targetPrimary) && has(object.status.instanceNames) &&\n" +
				"object.status.targetPrimary in object.status.instanceNames &&\n" +
				"object.status.?targetPrimary != oldObject.status.?targetPrimary &&\n" +
				"(object.status.?phase == oldObject.status.?phase || object.status.?phase == optional.of('Switchover in progress')) &&\n" +
				"object.spec == oldObject.spec && variables.otherStatusUnchanged",
			msg: "gateway may only switch the target primary of a Cluster to one of its instances",
		}})
}

func argoApplications(o Options, short string) map[string]any {
	var automatedSame []string
	for _, f := range applicationAutomatedFields {
		automatedSame = append(automatedSame, fmt.Sprintf("object.spec.?syncPolicy.?automated.?%s == oldObject.spec.?syncPolicy.?automated.?%s", f, f))
	}
	var syncPolicySame []string
	for _, f := range applicationSyncPolicyFields {
		syncPolicySame = append(syncPolicySame, fmt.Sprintf("object.spec.?syncPolicy.?%s == oldObject.spec.?syncPolicy.?%s", f, f))
	}
	return buildPolicy(o, short, "argocd_app_sync、argocd_app_terminate_operation、argocd_autosync_suspend、argocd_autosync_resume：同步固定到 40 位提交 SHA，或终止运行中的操作，或只切换 automated.enabled",
		[]resourceRule{{"argoproj.io", "v1alpha1", []string{"applications"}, []string{"UPDATE"}}},
		append(append([][2]string{}, annVars...),
			[2]string{"specUnchanged", "object.spec == oldObject.spec"},
			[2]string{"startsPinnedSync", "!has(oldObject.operation) && has(object.operation) && has(object.operation.sync) &&\n" +
				"object.operation.sync.?revision.orValue('').matches('^[0-9a-f]{40}$') &&\n" +
				"!has(object.operation.sync.revisions) &&\n" +
				"object.operation.sync.?prune.orValue(false) == false &&\n" +
				"object.operation.sync.?dryRun.orValue(false) == false &&\n" +
				"object.operation.sync.?syncStrategy.?apply.?force.orValue(false) == false &&\n" +
				"object.operation.sync.?syncStrategy.?hook.?force.orValue(false) == false &&\n" +
				"!has(object.operation.sync.manifests) && !has(object.operation.sync.source) &&\n" +
				"!has(object.operation.sync.sources) && !has(object.operation.sync.syncOptions) &&\n" +
				"!has(object.operation.sync.resources) &&\n" +
				"object.?status == oldObject.?status"},
			[2]string{"terminatesRunningOperation", "has(oldObject.operation) && object.?operation == oldObject.?operation &&\n" +
				"oldObject.?status.?operationState.?phase == optional.of('Running') &&\n" +
				"object.?status.?operationState.?phase == optional.of('Terminating') &&\n" +
				sameFields("status", applicationStatusFields) + " &&\n" +
				sameFields("status.operationState", applicationOperationStateFields)},
			[2]string{"togglesAutosync", sameFields("spec", applicationSpecFields) + " &&\n" +
				strings.Join(syncPolicySame, " &&\n") + " &&\n" +
				strings.Join(automatedSame, " &&\n") + " &&\n" +
				"has(object.spec.syncPolicy) && has(object.spec.syncPolicy.automated) && has(object.spec.syncPolicy.automated.enabled) &&\n" +
				"object.?operation == oldObject.?operation && object.?status == oldObject.?status"},
		),
		[]validation{
			metaUnchanged([]string{AnnotationExecutionID}),
			{expr: "(variables.specUnchanged && (variables.startsPinnedSync || variables.terminatesRunningOperation)) || variables.togglesAutosync",
				msg: "gateway may only start a sync pinned to a commit SHA without prune, force or dry run, terminate a running operation, or toggle spec.syncPolicy.automated.enabled"},
		})
}

func fluxObjects(o Options, short string) map[string]any {
	return buildPolicy(o, short, "flux_suspend、flux_resume、flux_reconcile：Kustomization 与 HelmRelease 只改 spec.suspend 或 reconcile.fluxcd.io/requestedAt",
		[]resourceRule{
			{"kustomize.toolkit.fluxcd.io", "v1", []string{"kustomizations"}, []string{"UPDATE"}},
			{"helm.toolkit.fluxcd.io", "v2", []string{"helmreleases"}, []string{"UPDATE"}},
		},
		append(append([][2]string{}, annVars...),
			[2]string{"specSame", "request.resource.resource == 'kustomizations' ?\n(" + sameFields("spec", kustomizationSpecFields) + ") :\n(" + sameFields("spec", helmReleaseSpecFields) + ")"}),
		[]validation{
			metaUnchanged([]string{AnnotationExecutionID, AnnotationFluxRequest}),
			{expr: "variables.specSame", msg: "gateway may only change spec.suspend of a Flux Kustomization or HelmRelease"},
			{expr: "object.?status == oldObject.?status", msg: "gateway may not change the status of a Flux object"},
		})
}

func argoWorkflows(o Options, short string) map[string]any {
	var absent []string
	for _, f := range workflowSpecFields {
		absent = append(absent, "!has(object.spec."+f+")")
	}
	absent = append(absent, "!has(object.spec.shutdown)")
	return buildPolicy(o, short, "workflow_submit、workflow_terminate：新建的 Workflow 只引用 WorkflowTemplate 并传入普通参数，带执行 ID 标签；修改只设置 spec.shutdown=Terminate。模板白名单与参数约束由 workflow-allowlist 策略检查",
		[]resourceRule{{"argoproj.io", "v1alpha1", []string{"workflows"}, []string{"CREATE", "UPDATE"}}},
		append(append([][2]string{}, annVars...),
			[2]string{"params", "object.spec.?arguments.?parameters.orValue([])"},
			[2]string{"referenceOnly", strings.Join(absent, " && ")},
		),
		[]validation{
			{expr: "request.operation != 'CREATE' ||\n" +
				"(has(object.spec.workflowTemplateRef) && has(object.spec.workflowTemplateRef.name) &&\n" +
				"!object.spec.workflowTemplateRef.?clusterScope.orValue(false) && variables.referenceOnly && !has(object.status))",
				msg: "gateway may only submit a namespaced WorkflowTemplate reference with arguments"},
			{expr: "request.operation != 'CREATE' ||\n" +
				"(!object.spec.?arguments.?artifacts.hasValue() &&\n" +
				"variables.params.all(p, has(p.value) && !has(p.default) && !has(p.description) && !has(p.enum) && !has(p.globalName) && !has(p.valueFrom)))",
				msg: "gateway may only pass plain name/value parameters"},
			{expr: "request.operation != 'CREATE' ||\n" +
				"object.metadata.?labels.orValue({})[?'" + AnnotationExecutionID + "'].orValue('').matches('^[0-9a-f]{32}$')",
				msg: "workflows submitted by gateway must carry the srenautix.io/execution-id label"},
			{expr: "request.operation != 'UPDATE' ||\n" +
				"(object.spec.?shutdown == optional.of('Terminate') &&\n" +
				sameFields("spec", append(append([]string{}, workflowSpecFields...), "arguments", "workflowTemplateRef")) + " &&\n" +
				"object.metadata.?labels == oldObject.metadata.?labels &&\n" +
				annotationsExcept([]string{AnnotationExecutionID}) + " &&\n" +
				"object.?status == oldObject.?status)",
				msg: "gateway may only set spec.shutdown=Terminate on an existing Workflow"},
		})
}

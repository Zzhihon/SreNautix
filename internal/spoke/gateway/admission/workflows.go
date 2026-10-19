package admission

import (
	"fmt"
	"sort"
	"strings"

	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/policy"
)

// WorkflowAllowlistShort 是工作流模板白名单策略的短名。
const WorkflowAllowlistShort = "workflow-allowlist"

// WorkflowAllowlist 按 gateway 策略中的 workflow_templates 生成策略：新建的 Workflow 只能引用白名单中的模板，
// 参数恰好是白名单中的名称，取值满足 enum、pattern、max_length。白名单来自 Git 中的 gateway 策略，
// 由 `srenautix-spoke admission workflow-allowlist --policy=<文件>` 在部署时生成。
func WorkflowAllowlist(pol *policy.Policy, opts Options) (Policy, error) {
	if len(pol.WorkflowTemplates) == 0 {
		return Policy{}, fmt.Errorf("admission: the gateway policy has no workflow_templates")
	}
	var alts []string
	for _, wt := range pol.WorkflowTemplates {
		names := make([]string, 0, len(wt.Parameters))
		for n := range wt.Parameters {
			names = append(names, n)
		}
		sort.Strings(names)
		conds := []string{
			"request.namespace == " + celString(wt.Namespace),
			"object.spec.workflowTemplateRef.name == " + celString(wt.Name),
			fmt.Sprintf("size(variables.params) == %d", len(names)),
		}
		for _, n := range names {
			r := wt.Parameters[n]
			conds = append(conds, fmt.Sprintf("variables.params.exists_one(p, p.name == %s)", celString(n)))
			var vc []string
			if len(r.Enum) > 0 {
				vc = append(vc, "p.value in "+celList(r.Enum))
			}
			if r.Pattern != "" {
				vc = append(vc, "p.value.matches("+celString(r.Pattern)+")")
			}
			if r.MaxLength > 0 {
				vc = append(vc, fmt.Sprintf("size(p.value) <= %d", r.MaxLength))
			}
			if len(vc) > 0 {
				conds = append(conds, fmt.Sprintf("variables.params.exists(p, p.name == %s && has(p.value) && %s)", celString(n), strings.Join(vc, " && ")))
			}
		}
		alts = append(alts, "("+strings.Join(conds, " &&\n")+")")
	}
	doc := buildPolicy(opts, WorkflowAllowlistShort,
		"workflow_submit：模板与参数必须在 gateway 策略的 workflow_templates 白名单中（模板内容的 sha256 与 ServiceAccount 由 gateway 在执行前核对）",
		[]resourceRule{{"argoproj.io", "v1alpha1", []string{"workflows"}, []string{"CREATE"}}},
		[][2]string{{"params", "object.spec.?arguments.?parameters.orValue([])"}},
		[]validation{{
			expr: "has(object.spec.workflowTemplateRef) && has(object.spec.workflowTemplateRef.name) && (\n" + strings.Join(alts, " ||\n") + ")",
			msg:  "gateway may only submit an allowlisted WorkflowTemplate with parameters that match its allowlist entry",
		}})
	return Policy{Short: WorkflowAllowlistShort, File: WorkflowAllowlistShort + ".yaml", Doc: doc}, nil
}

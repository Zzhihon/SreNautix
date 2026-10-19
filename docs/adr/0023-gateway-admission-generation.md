# 0023 由动作目录生成 gateway 的准入策略与 RBAC

## 背景

gateway 是被管集群中唯一的写身份。RBAC 只能按"资源 × 动词"授权，例如允许 patch Deployment，就允许修改它的镜像。DESIGN §9.4 要求按启用的动作生成准入策略，只约束 gateway 自己的 ServiceAccount，显式覆盖 `pods/eviction`，以 `srenautix-freeze` 作为 `paramRef` 实现熔断（不变量 11），并由 gateway 在启动时和每次执行前用违规的 `dryRun=All` 写入自检（不变量 3）。策略的形状必须与动作目录、执行器的实际写入保持一致。

## 决定

1. **唯一来源**：`contract/gateway/v1/action-catalog.yaml` 中每个动作的 `writes` 决定写权限，`internal/spoke/gateway/admission` 为每个动作补上读取需要的权限与策略。生成器拒绝目录中没有生成规则的动作。
2. **输出**（`make gateway-generate`，写到 `deploy/helm/srenautix/files/admission/`）：
   - `index.yaml`：`actions.<动作>.policies` 是策略文件名，`actions.<动作>.rules` 是 ClusterRole 规则（读取用 get、list、watch，写入用 patch 或 create）。规则中没有 Secret、ServiceAccount、token、RBAC、准入配置与通配符。
   - 每个策略文件恰好一个 `ValidatingAdmissionPolicy`，不含 Binding。名称写成 `{{ include "srenautix.fullname" . }}-gateway-<短名>`，`matchConditions` 中的用户名写成 `{{ include "srenautix.gateway.username" . }}`，由 chart 的 `tpl` 渲染。
   - chart 为每个策略生成 Binding：`validationActions: [Deny]`，`paramRef` 指向 `srenautix-freeze`，`parameterNotFoundAction: Deny`。chart 另有一条兜底策略，拒绝 gateway 对目录之外资源的写入。
3. **每个策略的固定部分**：
   - 只匹配 gateway 的 ServiceAccount；
   - 声明 `paramKind: ConfigMap`，要求 `params.?data.?frozen.orValue('true') == 'false'`；`frozen` 不是 `false`、或 ConfigMap 缺失时拒绝；
   - 另外匹配 `srenautix.io` 的 `actionexecutions` CREATE：带 `srenautix.io/admission-probe=<短名>` 标签的对象一律拒绝，其余 ActionExecution 放行（冻结时 gateway 仍能记录执行状态）。
4. **形状约束**：

   | 策略 | 动作 | 允许的写入 |
   |---|---|---|
   | `pod-eviction` | `pod_restart`、`workload_rolling_restart`、`cnpg_replica_restart` | Eviction 与 Pod 同名，带 UID 前置条件，不改优雅终止时间与删除传播 |
   | `workload-deployments`、`workload-statefulsets` | `workload_scale`、`rollout_pause`、`rollout_resume` | 只改 `spec.replicas`、`spec.paused` |
   | `hpa-bounds` | `hpa_bounds_set` | 只改 `spec.minReplicas`、`spec.maxReplicas`，下限不大于上限 |
   | `cronjob-suspend` | `cronjob_suspend`、`cronjob_resume` | 只改 `spec.suspend` |
   | `node-scheduling` | `node_cordon`、`node_uncordon` | 只改 `spec.unschedulable` 与 `srenautix.io/cordoned-by`；控制面节点不能被 cordon |
   | `cnpg-switchover` | `cnpg_switchover` | 只改 `kubectl cnpg promote` 写入的 status 字段，`targetPrimary` 必须是现有实例 |
   | `argocd-applications` | `argocd_app_sync`、`argocd_app_terminate_operation`、`argocd_autosync_suspend`、`argocd_autosync_resume` | 同步固定到 40 位小写提交 SHA，不带 prune、force、dry run、同步选项、资源子集；或把运行中的操作标为 Terminating；或只切换 `automated.enabled` |
   | `flux-objects` | `flux_suspend`、`flux_resume`、`flux_reconcile` | 只改 `spec.suspend` 或 `reconcile.fluxcd.io/requestedAt` |
   | `argo-workflows` | `workflow_submit`、`workflow_terminate` | 新建的 Workflow 只引用命名空间内的 WorkflowTemplate，只传普通的名称与取值参数，带 `srenautix.io/execution-id` 标签；修改只设置 `spec.shutdown=Terminate` |

   所有修改都只允许新增或改变 `srenautix.io/execution-id` 注解（32 位小写十六进制），标签、属主、finalizer 与其他注解不变。"其余字段不变"按资源逐个列出字段比较；`fields_test.go` 用 `test/crds/` 中固定版本的 CRD 与 k8s.io/api 的类型核对列表覆盖了全部字段。
5. **工作流模板白名单**：模板名称与参数约束来自 Git 中的 gateway 策略（`workflow_templates`），不在动作目录中。`srenautix-spoke admission workflow-allowlist --policy=<策略文件>` 生成 `workflow-allowlist` 策略：模板必须在白名单中，参数恰好是白名单中的名称，取值满足 `enum`、`pattern`、`max_length`。模板内容的 sha256 与 ServiceAccount 由 gateway 在执行前核对。
6. **自检**：gateway 在启动时、每 15 秒、每次执行前，为启用动作用到的每个策略提交一次带探针标签的 `dryRun=All` ActionExecution 创建请求，并要求被该策略拒绝。任何一个被放行（策略或 Binding 被删除、Binding 改成 Warn 或 Audit），gateway 转为只提议。
7. **测试**：`internal/spoke/gateway/admission` 在 envtest 的 kube-apiserver 1.37 上安装生成结果（具体用户名与前缀），以 gateway 身份逐项验证允许与拒绝的写入、冻结与 ConfigMap 缺失时的拒绝、探针在冻结时仍被拒绝而普通 ActionExecution 放行。

## 结果

- 新增动作必须同时声明写入、补齐生成规则与测试，否则生成器或 CI 失败；`make gateway-generate-check` 在生成结果有差异时失败。
- 一个策略文件可能服务多个动作，策略允许的是这些动作写入的并集（例如只启用 `rollout_pause` 时，`workload-deployments` 仍允许改 `spec.replicas`）；动作级的限制由 gateway 的策略与断言核对保证。
- 命名空间范围由 gateway 策略与断言核对保证；准入策略按资源形状约束，ClusterRole 由 chart 按 `index.yaml` 生成。

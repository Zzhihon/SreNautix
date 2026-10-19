# 0060 一个 Helm chart 与三种安装配置

## 背景

DESIGN §17 要求一个 chart、一个版本号，三种安装配置（observe、standard、compliance，§1.3）对应三份 values 预设，各角色可以单独开关。配置之间只改变"强度"类的选项，12 条不变量在三种配置下都成立。chart 同时承载安全约束：worker、mcp、reader 只读且不读 Secret（不变量 1），gateway 的写权限只来自动作目录且不触及准入配置、RBAC、token 与 Secret（不变量 4），熔断开关不依赖 gateway（不变量 11），自身告警不能路由到 SreNautix 自己（§11、§15.5）。

## 决定

1. **profile 是默认值的来源**：`profile` 决定每个为 `null` 的开关（角色启用、治理选项、审计汇类型、对象锁模式、镜像签名策略），默认值写在 `templates/_profile.tpl`。`values-<配置>.yaml` 把这些默认值显式写出，便于审阅和差异比较；`--set profile=observe` 与使用 `values-observe.yaml` 的结果相同。
2. **渲染时校验**：`templates/validate.yaml` 在渲染阶段检查全部前提，不满足时 `fail`，不留给运行时：
   - gateway 要求 Kubernetes ≥1.30、服务签名密钥、非空的动作列表；
   - CNPG 默认至少 2 个实例，单实例需要显式接受；
   - 合规配置要求 WORM 审计（COMPLIANCE 模式、≥180 天）、专用节点池、三权分立、通行密钥、禁止自审批、镜像签名策略；
   - 自身告警必须有 SreNautix 以外的接收方与路由标签，接收方的 webhook 不能指向 SreNautix server。
3. **RBAC 由数据生成**：只读角色的规则在 `_rbac.tpl` 中显式列出资源，没有通配符，没有 `secrets`；worker 与 mcp 另外不读 ConfigMap 与 Pod 日志（§8.4）。gateway 的 ClusterRole 规则逐条来自 `files/admission/index.yaml`（ADR 0023），渲染时再按禁用清单检查一遍。
4. **准入策略的组装**：生成器只输出策略，chart 负责 Binding（`paramRef` 指向 `srenautix-freeze`，`parameterNotFoundAction: Deny`）与一条兜底策略。兜底策略对 gateway 的全部写入生效：目录之外的资源、准入配置、RBAC、Secret、token、熔断开关本身一律拒绝；冻结时只放行 gateway 在自己命名空间内的 ActionExecution、Lease 与 Event。
5. **配置与凭证**：server 的配置由 chart 按部署事实生成（地址、挂载路径、领域包目录、审计汇），键与 `apps/srenautix/src/config/server.ts` 一致，`roles.server.config` 深度合并覆盖；其余角色的配置就是 `roles.<角色>.config`。凭证一律以文件挂载，每个角色只挂载 §1.1 中它持有的部分。服务调用方 token、接入源 token、审计检查点密钥由 chart 生成，升级时用 `lookup` 沿用，卸载时保留。
6. **数据库**：CNPG 模式创建 Cluster（同步复制 preferred）与三个库角色；外部 PostgreSQL 模式只引用 Secret。两种模式都可以用 `db bootstrap` Job 建 schema 与权限（CNPG 用超级用户 Secret，外部模式用 `adminSecret`）。
7. **gateway 的部署形态**：单副本、Recreate、长优雅终止时间、本地审计暂存 PVC（卸载时保留），与 PG 实例默认 preferred 反亲和，合规配置为 required。
8. **测试**：helm-unittest 覆盖角色开关、RBAC、准入策略、熔断开关、校验失败路径与每个角色挂载的凭证；`deploy/helm/check.sh` 对每份 values 执行 `helm lint --strict` 与 kubeconform（含 CNPG、prometheus-operator、policy-controller、Cilium 的 CRD schema）。

## 结果

- 新增开关时同时更新 `_profile.tpl` 与三份预设，否则 profile 与预设的结果会不同。
- 动作目录变化不需要改 chart：重新生成 `files/admission/` 即可；chart 的禁用清单在生成器之外再挡一次。
- chart 生成的凭证依赖 `lookup`，`helm template` 每次输出新的随机值；GitOps 渲染（Argo CD 不执行 `lookup`）时应把这些 Secret 预先创建，并通过对应的 `existingSecret` 引用。

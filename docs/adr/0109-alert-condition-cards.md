# 0109 告警条件卡：主卡由告警规则生成，与规则在同一份夹具上核对

## 背景

契约 2.15.0 的告警目录条目可以声明 `primary_card`：告警触发时应当判为异常的卡，评测按它统计证据卡与告警结论的一致率（ADR 0110）。已有的证据卡大多判断的是与告警相关、但不相同的量（例如告警判断"慢请求占比"，卡判断"p99 相对基线"），阈值也各自写一份，告警在触发、卡判为正常的情形时有发生。逐条手写与告警等价的卡工作量大，阈值也会随规则修改而漂移。

## 决定

1. **主卡的检查**：`pack lint` 要求主卡存在、`applies_to` 包含条目的实体 kind（忽略大小写与 API 组，与评测相同）、卡所在的证据链在条目的 `chains` 中，告警触发时阶段 A 才会在告警实体上执行它。
2. **与规则核对**：`pack test --alert-rules <规则文件>` 读入 Prometheus 规则文件、PrometheusRule 或 VMRule（同名告警的严重度变体按条目的 `match_labels` 选，没有拆开时任一条触发都算），对主卡的每个夹具测试在同一份夹具上再求一次规则：告警在卡片窗口内触发（满足 `for`）当且仅当主卡判为异常。MetricsQL 才能解析的规则只在 VictoriaMetrics 上核对。
3. **告警条件卡**：没有现成的卡判断告警条件时，从规则生成（packs-sdk 的 `generateConditionPack`）。每个条目一张卡：
   - `value` 是规则表达式本身；`for` 大于 0 时 `held` 为 `count_over_time((表达式)[for:1m])`，等于 `for` 的分钟数表示告警已经触发；
   - 只看与实体对应的序列：条目 `name_labels` 中第一个出现在序列上的标签等于实体名，都不出现时整条序列都算；
   - `inputs`（no_data 引用）是表达式读取的原始序列是否存在，都不存在时卡片无法判定；缺失本身就是条件的表达式（absent）与不读序列的表达式以 `up` 代替；
   - 窗口与默认卡片窗口相同，窗口内任一时刻告警已触发即判异常；
   - 卡片以 1 分钟为步长求值，不足一分钟的 `for`（例如 1s、10s）按 0 处理，条件成立即判异常。
4. **kube-prometheus-stack**：内置包 `kps-conditions` 由 `pnpm --filter @srenautix/packs-sdk run gen:kps-conditions` 从固定版本 chart 渲染出的规则生成，alerts-kps 的 139 个条目（不含接入时丢弃的 Watchdog、InfoInhibitor）都以它为主卡。夹具来自 chart 固定的 kubernetes-mixin 提交的 promtool 单元测试（`upstream/kubernetes-mixin-tests.json`，sha256 固定），只转能在两个后端上原样复现的组：选择器都匹配夹具序列、不用 `time()`、`timestamp()`、`changes()`、`resets()`。builtin-packs 测试核对仓库内容与生成结果一致，并以渲染出的规则执行一致性核对。包的成熟度是 beta：夹具只覆盖一部分告警，其余卡的语义由生成方式保证。
5. **其他内置包**：告警条件已有对应卡的条目直接声明主卡（argocd、cert-manager、envoy-gateway、flux、ingress-nginx、kafka、longhorn、mysql、nacos、postgres、redis、rocketmq 共 51 个）。其余条目的主卡在内置包 `upstream-conditions`，由 `pnpm --filter @srenautix/packs-sdk run gen:upstream-conditions` 从上游规则生成：
   - 来源固定在 `upstream/community-rules.json`，每个文件都有固定提交与 sha256，包括 argo-cd-mixin、cert-manager-mixin 与 postgres-exporter mixin 的渲染结果、ingress-nginx chart values 中的示例、Strimzi 示例规则、Longhorn 文档、mysqld-mixin、nacos-k8s 的 chart、CloudNativePG cluster chart、awesome-prometheus-alerts 的 redis_exporter 规则，以及 rocketmq-exporter 的示例规则。
   - 规则以多种形式给出：规则文件、注释掉的示例、文档中的 yaml 代码块，或按 values 渲染的 chart。
   - chart 模板或渲染留下的具体名字由 `replace` 换成实体变量。例如 CNPG 规则里的集群名，Cluster 条目换成 `$name`，Pod 条目换成任意集群名的正则；命名空间换成 `$namespace`。换过名字的来源会在卡片说明中注明。
   - 没有手写主卡的 33 个条目都以 `upstream-conditions` 中的条件卡为主卡。
   - 夹具来自 argo-cd-mixin 同一提交的 promtool 测试。
   - builtin-packs 测试做三件事：核对仓库内容与生成结果一致；核对内置包中有证据链的条目都有主卡；在夹具上用上游规则做一致性核对。
   - rocketmq 目录的 `SendTPSTooHigh` 在 rocketmq-exporter 的示例规则与文档中都不存在，是唯一没有主卡的条目。
   - 成熟度是 beta。
6. **用户包**：与 CCHP 一样，用户可以用同一个函数从自己的规则生成条件卡包，并在 CI 中执行 `pack test --alert-rules`。

## 结果

- 阈值只在告警规则里写一次；规则修改后重新生成，`--check` 与 builtin-packs 测试在生成结果过期时失败。
- 条件卡只说明"告警条件在这个实体上是否成立"。根因分析仍然依靠证据链中的其他卡，条件卡不能代替它们。

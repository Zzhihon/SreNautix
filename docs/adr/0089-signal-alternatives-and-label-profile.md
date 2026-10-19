# 0089 信号备选、标签档案与官方解析器

## 背景

同一个逻辑信号在不同环境里的写法不同：有的装了录制规则，有的 cAdvisor 版本没有 `container_oom_events_total`，有的采集链路把 `namespace` 写成 `kubernetes_namespace` 或 `k8s_namespace_name`，外部标签 `cluster` 的名字也各不相同。领域包要在这些环境中不经修改直接工作（DESIGN §6.2）。用正则或手写解析器改写 PromQL 会在子查询、`by`/`without`、`on`/`ignoring`、函数参数里出错。

## 决定

1. **备选按优先级探测**：信号的每个备选是一条查询。加载时逐个探测，选中第一个可用的，按数据源记录：指标备选要求渲染后查询中的每个指标名在探测窗口内都有序列，声明了 `probe` 时 probe 还要非空；日志、链路备选要求数据源具备对应能力与方言。`recording_rule: true` 的备选不能是最后一个。被拒绝的原因（`capability`、`dialect`、`missing_metric`、`probe`、`error`）由 `srenautix pack doctor` 列出。
2. **标签档案**：模板只用规范名（`namespace`、`pod`、`container`、`node`、`persistentvolumeclaim`）。启动时对每个指标数据源探测各逻辑字段实际使用的标签名、外部标签 `cluster` 的名字、抓取间隔与租户；`$rate_window` 取 `max(60s, 4 × 抓取间隔)`。
3. **官方解析器**：Prometheus（`promql/parser`，v0.313.0）与 VictoriaMetrics（`metricsql`，v0.87.5）的 Go 解析器编译为一个 wasm 模块，随 `integration-sdk` 发布，提供分析（选择器、函数、标签、回看与前看、`@` 修饰符）、改写（按档案重命名标签、注入 cluster 匹配器）与 promtool 序列写法的解析。构建需要 Go，版本由 `packages/integration-sdk/promql-wasm/go.mod` 决定。
4. **严格检查**：`lint` 对每个备选按 `applies_to` 的每种实体渲染并用对应方言的解析器解析；禁止 `@` 修饰符；`range` 模式的结果必须是瞬时向量。回放时钟窗口检查使用同一解析器算出的回看量。

## 结果

- 同一份领域包在 kube-prometheus-stack、OTel 采集、VictoriaMetrics 上都能运行，环境差异集中在探测结果里，`doctor` 可以解释每个信号为什么选了哪条查询。
- 解析与改写和后端使用同一份解析器代码，改写后的查询与后端的理解一致。
- wasm 模块约 11 MB，每个进程加载一次后复用；解析器升级随 Go 模块版本一起评审。

# 0090 领域包测试在真实 Prometheus 与 VictoriaMetrics 上执行

## 背景

证据卡的结论依赖后端的查询语义：`rate` 的外推、陈旧标记、回看、空结果与错误的形状。在内存里模拟后端的测试无法发现这些差异；只在一种后端上测试，又无法保证 VictoriaMetrics 用户得到相同结论（DESIGN §6.3）。告警目录要覆盖 kube-prometheus-stack 的全部告警（DESIGN §3.2），手工维护的列表会随上游升级悄悄过时。

## 决定

1. **真实后端**：`srenautix pack test` 把夹具（promtool `input_series` 写法）装进真实的 Prometheus（`promtool tsdb create-blocks-from openmetrics` 回填成块）与 VictoriaMetrics（`/api/v1/import/prometheus` 导入带时间戳的样本），有日志夹具时装进真实的 Loki；每个测试在两个后端上各跑一遍，结论（verdict、显示状态、原因类型）必须与期望一致，两个后端之间也必须一致。后端用上游发布的二进制，版本与各平台 sha256 固定在 `packages/integration-sdk/backends.json`，下载到工作区的 `.scratch/backends`。
2. **自动测试**：每张卡自动生成空后端、缺单个 `no_data` 引用、引用报错三类测试（ADR 0088）。
3. **成熟度**：`stable` 的包每张卡都必须有夹具测试；只有 `stable` 的包计入"支持"。全部内置包都是 `stable`，CI 每次运行全部内置包的测试。
4. **录制与回放**：`srenautix pack record` 在真实数据源上执行卡片并把查询与响应写成快照（`srenautix.io/query-snapshot/v1`），`pack test --replay` 用快照代替数据源；快照中没有的查询直接失败，修改查询的提交必须重新录制。
5. **告警目录覆盖**：CI 按 `packages/packs-sdk/upstream/kube-prometheus-stack.json` 固定的 chart 版本与 sha256，用固定版本的 Helm 渲染，取出全部告警规则，检查每个上游告警名在 `alerts-kps` 中都有条目、目录中没有上游不存在的告警名、条目角色为 `forecast` 当且仅当规则表达式调用了 `predict_linear`。

## 结果

- 夹具测试发现的后端差异在合入前暴露，包作者按两个后端都成立的写法修改查询或判定。
- CI 需要下载数百 MB 的后端发行包，按 `backends.json` 的内容缓存。
- 升级 kube-prometheus-stack 时，覆盖检查会列出新增与删除的告警名，目录与固定文件同一提交更新。

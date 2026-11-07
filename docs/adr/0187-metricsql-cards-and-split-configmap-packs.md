# 0187 只能用 MetricsQL 查询的卡与分在多个 ConfigMap 中的包

## 背景

用 vmalert 的部署方从告警规则生成告警条件卡（ADR 0109）时，有的规则用了 MetricsQL 独有的函数（`tlast_over_time`、`default_rollup` 等），对应的信号只有 `dialect: metricsql` 的备选。`pack test` 在 Prometheus 与 VictoriaMetrics 上各执行一遍每个测试，并要求两个后端的结论相同；Prometheus 执行不了 MetricsQL，这类卡在它上面只能判为无法判定，夹具测试必然失败。部署方只能不给这类卡写夹具，卡与告警规则之间就没有了一致性核对（ADR 0109 的主卡核对）。

用户包以 ConfigMap 挂载（docs/packs 的约定是一个 ConfigMap 放一个包）。ConfigMap 的键与值合计不能超过 1 MiB。从几百条告警规则生成的条件卡包，证据链与信号文件会随规则增长，超过上限后包无法同步，部署方只能把一个包拆成几个包，包名、pack.lock 与 `packs.revision` 的计算都要跟着改。

## 决定

### 1. 按卡的方言选后端

后端执行的指标方言是固定的：Prometheus 执行 `promql`，VictoriaMetrics 执行 `promql` 与 `metricsql`。`pack test` 对每个用例求出能执行它的后端：用例读取的每个指标信号至少有一个备选的方言是这个后端执行的。

- 卡读取的指标信号只有 `metricsql` 备选时，这张卡的夹具测试、结论规则测试（用例列出的全部卡）、无数据测试与主卡核对只在 VictoriaMetrics 上执行；两个后端之间的一致性比较只在两个后端都执行时进行。
- 部分无数据与数据源报错的自动变换取用例执行的第一个后端的夹具结果（两个后端都执行时仍是 Prometheus）。
- 用例的 `dialect_skipped` 列出没有运行的后端；命令行另输出一行这类用例的个数。
- 判断只看信号声明的方言，不看解析结果：PromQL 备选因为指标不存在等原因解析失败时，卡仍在两个后端上执行并照常失败。没有后端能执行全部信号时仍在全部后端上执行，由信号解析报出原因。

`stable` 的要求（每张卡有夹具测试、结论一致）按「能执行这张卡的每个后端」理解：只有 MetricsQL 备选的卡在 VictoriaMetrics 上有夹具测试并通过，即满足要求。

### 2. 一个包分在多个 ConfigMap 中

chart 的 `packs.userConfigMaps` 增加一种写法 `{configMaps: [<名>, ...], pack: <包名>}`。列出的 ConfigMap 以投影卷（projected volume）挂载到同一个包目录 `/etc/srenautix/packs/<第一个 ConfigMap>/<包名>`，卷名与 `packs.dirs` 用第一个 ConfigMap 的名字。

- 每个 ConfigMap 仍按 `<子目录>__<文件名>` 的键约定放包里的部分文件，各 ConfigMap 的键不能重复。加载器看到的目录与单个 ConfigMap 挂载时相同（kubelet 的 `..data` 与 `..<时间戳>` 条目照样跳过），内容摘要与源目录相同，server 不需要改动。
- `configMap` 与 `configMaps` 只能写一个，`configMaps` 不能有重复；违反时渲染失败。只写一个 ConfigMap 时仍渲染为普通的 configMap 卷，已有部署升级后 Pod 模板不变。
- 单个文件仍不能超过 1 MiB。

## 考虑过的方案

- **Prometheus 上跳过结论比较但仍然执行**：Prometheus 上的结果总是无法判定，记进报告只会让人误以为卡在 Prometheus 上有问题。
- **要求部署方把规则改写成 PromQL**：告警规则属于部署方的观测变更流程，MetricsQL 的函数（例如按最后一个样本的时间判断）不一定有等价的 PromQL 写法。
- **允许压缩的包（gzip 写进 binaryData）**：能把单个大文件压到上限以内，但 Helm 模板没有压缩函数，部署方要把压缩结果提交进仓库，评审时看不到差异；加载器还要区分压缩前后的摘要。按文件分到几个 ConfigMap 已经满足当前的增长，压缩留到单个文件接近 1 MiB 时再考虑。
- **把一个包拆成几个包**：每个包有自己的包名、引用写法（`<包>/<链>/<卡>`）与 pack.lock 条目，拆分点一变引用都要改；投影卷只改变挂载方式，不改变包。

## 结果

- 只能用 MetricsQL 查询的告警条件卡可以写夹具，主卡在 VictoriaMetrics 上与告警规则核对。
- 超过 1 MiB 的用户包按文件分到几个 ConfigMap，不改包名、引用与 pack.lock。

# 技能 oom-rootcause：内存终止根因

容器因内存被终止（OOMKilled）、Pod 被驱逐，或工作集持续贴近 limit 时，只读地完成一次根因排查，在业务仓库开 issue；同一根因再次出现时在已有 issue 下评论。机制见 [ADR 0181](../adr/0181-hot-pluggable-skills.md) 与 [README.zh-CN.md](README.zh-CN.md)。清单在 [skills/oom-rootcause/skill.yaml](../../skills/oom-rootcause/skill.yaml)，绑定 schema 在 [binding.schema.json](../../skills/oom-rootcause/binding.schema.json)。

技能目录只含通用的步骤、参数与模板。工作负载自己的指标、日志事件、代码路径提示、运维选项与已有 issue 编号由部署方领域包的 `skill-bindings.yaml` 提供。

## 1. 边界

| 允许 | 不允许 |
|---|---|
| 领域包信号的区间查询 | 自由的 PromQL、LogQL |
| 按绑定声明的事件查询 Loki，只保留声明的字段 | 读取请求体、响应体与其他用户数据 |
| Pod 状态摘要、事件、上一次退出的容器日志尾部（运行对象的命名空间与 Pod） | `exec`、`cp`、`port-forward`、读取 Secret、读取环境变量 |
| 业务仓库默认分支的头上的文件（固定到提交） | 写入业务仓库的内容、开 PR |
| 业务仓库的 issue：创建、评论、读取 | 修改 issue 的状态与标签 |
| issue 中列出堆画像的文件名与取出命令 | 取出或读取堆画像 |
| issue 中列出运维侧选项 | 修改 limit、GOMEMLIMIT、运行时配置，重启或驱逐 Pod |

## 2. 触发与步骤

触发：`workload/container_oom_restarts`（容器重启并且最近一次终止的原因为 OOMKilled）、`workload/container_memory_limit_ratio` 持续 `rss_sustain`（默认 10 分钟）超过 `rss_limit_ratio`（默认 0.85）、informer 中容器以 OOMKilled 终止、Pod 被驱逐、手动运行。`settle` 5 分钟，`coalesce` 2 小时。只在绑定了的工作负载上运行。

| 步骤 | 步骤类型 | 内容 |
|---|---|---|
| `status`、`events` | `kube.read@v1` | Pod 状态摘要（重启、最近一次终止的原因与时刻、内存 limit、镜像）；Pod 的事件（可选） |
| `occ` | `trigger.occurrences@v1` | `occurrence_window`（48 小时）内的发生：OOM 重启的区间查询（第一个为正的点之前一个步长内发生终止，取这个下界），Pod 状态中更精确的终止时刻，以及触发带来的发生（驱逐、贴近 limit）；标出没有报告过的发生 |
| `around` | `metrics.range@v1` | 每次发生前 30 分钟、后 30 分钟，步长 30 秒：Go 存活堆、next_gc、GOMEMLIMIT、GC CPU、GOMAXPROCS、RSS、容器 limit、容器 CPU、节点可用内存，以及绑定的嫌疑项与上下文序列 |
| `history` | `metrics.range@v1` | 整个工作负载 48 小时，步长 5 分钟：内存序列、上限与嫌疑项序列；峰值型序列（`evidence: peak`）按步长内的最大值取样（`max_over_time` 子查询，分辨率为 `step`；同一信号在任何一个嫌疑项里声明为峰值型都按最大值取样） |
| `logs`、`previous`、`previous_events` | `logs.events@v1`、`kube.read@v1`、`logs.extract@v1` | 发生之前 30 分钟的日志事件；上一次退出的容器日志尾部中的同样事件 |
| `kind` | `analyze.memory_kind@v1` | 分类（§3.1） |
| `rank` | `analyze.suspects@v1` | 嫌疑项的检验、分组、置信度与证据表（§3.2） |
| `requests` | `analyze.top@v1` | 主因分组的大请求，按请求体与时长排序；请求体字节份额最高的组织 |
| `profile_logs`、`previous_profiles`、`profiles` | `logs.events@v1`、`logs.extract@v1`、`analyze.profiles@v1` | 发生之前一直到参考时刻写出的堆画像，加上上一次退出的容器日志尾部里的画像（终止前最后一份），按文件名模式校验，同一路径只列一次，每个 Pod 最近 `max_profiles` 个 |
| `code` | `code.locate@v1` | 嫌疑项的代码路径提示在默认分支的头上的位置（可选） |
| `related` | `issue.related@v1` | 绑定声明的已有 issue 与本技能在同一工作负载上开过的 issue |
| `publish` | `issue.publish@v1` | 有新的发生时按指纹开 issue、评论或计数 |

## 3. 算法

记号：一次发生 `o = (pod, container, at)`；内存序列 `M`（Go 为 heap_inuse，其他为 RSS），上限 `L`（Go 为 GOMEMLIMIT，其他为容器 limit）；嫌疑项的检验序列 `X`（绑定中 `role: indicator` 的序列）。

### 3.1 分类

| `kind` | 条件 |
|---|---|
| `node_pressure` | 原因为驱逐；或 Pod 状态的原因为 Evicted；或 5 分钟内有这个 Pod 的 Evicted 事件；或发生之前 5 分钟内节点可用内存比例低于 `node_available_min` |
| `near_limit` | 贴近 limit 的触发，没有终止 |
| `container_limit` | OOMKilled，且不满足上面两项 |

| `heap`（`runtime: go`） | 条件 | 写法 |
|---|---|---|
| `live_heap_at_limit` | 发生之前 5 分钟内 `max(heap_inuse) / GOMEMLIMIT ≥ heap_near_limit_ratio`（0.8），`next_gc / GOMEMLIMIT ≥ next_gc_near_limit_ratio`（0.9），GC CPU 不低于 `gc_cpu_ratio`（0.4）× GOMAXPROCS 累计 `gc_cpu_sustain_seconds`（60 秒）。heap_inuse 按 30 秒步长采样，峰值常落在两个样本之间，所以阈值低于 1 | 存活堆贴着 GOMEMLIMIT，GC 连续运行也收不回：占用的是存活数据 |
| `non_heap` | `RSS / limit ≥ 0.95`，同时 `heap_inuse / GOMEMLIMIT < 0.7` | 堆之外的内存（goroutine stack、mmap、cgo）占满了 limit |
| `no_gomemlimit` | 没有 GOMEMLIMIT，或它不小于容器 limit | GOMEMLIMIT 没有生效 |
| `not_at_limit`、`no_data` | 其他；没有 Go 运行时指标 | — |

没有 GC CPU 指标时用容器 CPU 代替，"未验证"一节写明这一点（"推断（代替）"）。

### 3.2 嫌疑项

对每个嫌疑项：

1. **发生之前**（`[at − 30m, at]`）：至少一条检验序列通过。趋势型序列（`evidence: trend`，默认）要上涨（终点比起点高出峰值的 10% 以上）并且与内存序列的 Pearson 相关系数不低于 `rise_corr`（0.5）；峰值型序列（`evidence: peak`，例如请求体预算 held）要窗口内的峰值达到 `high`（绑定声明，没有时取 48 小时的 p90），不要求与内存同步：单个大请求的瞬时占用在发生前可能已经回落，起点到终点的趋势与平均类的速率序列都看不到它，这次发生上的相关至少记为 `rise_corr`。绑定声明了 `logs_required`（事件名列表）时窗口内还要出现其中至少一个事件。满足时这次发生支持该嫌疑项，通过检验的序列中最高的相关系数记为这次发生上的相关。速率类序列（例如请求体转换字节）在请求开始时冲高、之后回落，不一定与内存同步，所以只要求一条序列通过；只靠指标分不开的机制（同一条积压序列既可能来自大请求，也可能来自流量很低时的重试）由 `logs_required` 区分。最后 2 分钟仍在上升时记下。
2. **48 小时**（每条检验序列，全部 Pod，5 分钟一个样本，峰值型序列取步长内的最大值）：`high`（绑定声明，没有时取 p90）以上的样本中内存高（`M / L ≥ memory_high_ratio`，0.75）的比例为支持度，相对全部样本中内存高的比例为提升，`1 − 支持度`为反例比例。内存高的时段本来就少（真实工作负载上常低于 1%），反例比例总是接近 1，判定只用提升，反例比例写进证据表；高位样本少于 `min_history_samples`（12）时为不足。
3. **先后**：检验序列领先内存 1–3 个步长的最大相关系数（lead）与落后内存的最大相关系数（lag）；`lag − lead ≥ reverse_margin`（0.2）且 `lag ≥ 0.5` 时记为反向：它跟在内存后面变化。

判定与分组：

- 排除只凭直接反证：每次发生之前的窗口里全部检验序列都有数据并且一直为 0，机制在发生时没有出现。排除的置信度为高，不给修复方向与运维选项。
- 统计上缺乏关联不排除：一条检验序列样本足够、提升不低于 `rule_out_lift`（1.2）并且不反向时它在统计上支持嫌疑项；有样本足够的检验序列、却没有一条支持时，嫌疑项记为"统计上未得到支持"。平均或按步长取样的序列会抹平单个请求的瞬时峰值，看不到关联不等于没有关联，所以它没有置信度、照常参与分组、修复方向照常列出；没有归到任何一组时写进结论与 §3，在主因分组的发生之前最后 2 分钟仍在上升时写作可能的次要加重因素（推断）。
- 代表嫌疑项的统计取支持它的检验序列中提升最高的一条，没有时取样本足够的序列中提升最高的一条；证据表列出每条检验序列的统计。
- 每次发生归到支持它的、没有被排除的、在这次发生上分数（提升 × 这次发生上的相关）最高的嫌疑项；发生最多的一组给出主因（同样多时取组内分数之和高的一组），其余组写作"另一种触发"，没有嫌疑项支持的发生写作"未解释"。
- 置信度：

| 置信度 | 条件 |
|---|---|
| 高 | 这一组解释了全部发生（没有另一种触发）且至少 2 次；提升 ≥ 3；有日志事件；每次发生都是容器 limit（Go 服务还要是存活堆贴着 GOMEMLIMIT） |
| 中高 | 组内至少 2 次发生；提升 ≥ `lift_min`（1.5）；有日志事件 |
| 中 | 提升 ≥ `lift_min`，或有日志事件 |
| 低 | 其他 |

48 小时数据不足时置信度最高为中；统计上没有关联的嫌疑项成为主因或另一种触发时，提升低于 `lift_min`，置信度最高为中（有日志事件）。

### 3.3 证据表

每一行有时间、Pod、指标或日志、数值、依据与查询：

| 依据 | 含义 |
|---|---|
| 观测 | 查询结果、日志字段、Pod 状态的原值 |
| 推断（统计） | 支持度、提升、反例、相关与先后 |
| 推断（代替） | 用其他指标代替的判断，例如用容器 CPU 代替 GC CPU |

"查询"列是实际发出的 PromQL 或 LogQL；从上一次退出的日志取出的事件写作 `kube_logs --previous <Pod>/<容器>`。机制段落来自绑定，标为"推断，领域包声明的机制"。

## 4. 指纹与再次出现

指纹：`sha256(oom-rootcause, 集群, 绑定 id, 主因的第一个代码路径, 主因的机制 id, 请求体字节份额不低于 org_share_min 的组织前缀或 *)`。没有主因时代码路径与机制 id 都为 `unexplained`。

- 同一指纹的 issue 打开时，有新的发生的运行追加评论：新的发生、结论、证据表与新保留的堆画像。
- 以 completed 关闭之后再次出现：开新 issue，开头写"修复后再次出现"并引用旧 issue。
- 以 not planned 关闭：30 天内只计数，之后再出现时开新 issue。
- 主因变化时指纹不同，开新 issue；"相关"一节引用这个工作负载上的其他 issue。

## 5. issue

正文模板 [templates/issue.zh-CN.md](../../skills/oom-rootcause/templates/issue.zh-CN.md)（英文 `issue.en.md`），评论模板 `comment.zh-CN.md`。结构：现象（对象、limit、GOMEMLIMIT、GOMAXPROCS、镜像、每次发生的分类）与结论（主因、另一种触发、统计上未得到支持的嫌疑项、排除项与置信度）；1. 证据（含大请求表，只有 request_id、组织前缀与数值）；2. 机制与代码位置（链接固定到提交）；3. 排除项与统计反例（排除项的直接反证，统计上未得到支持的嫌疑项的支持度、提升与反例）；4. 修复方向与运维侧选项（没有被排除的嫌疑项；作用领域、影响范围、收益、风险，只列出、不执行）；5. 未验证（推断的项、失效的代码提示、未解释的发生、堆画像与命令）；相关 issue。

## 6. 参数

`skills.params.oom-rootcause` 可以覆盖：`rss_limit_ratio`、`rss_sustain`、`occurrence_window`、`occurrence_step`、`pre_window`、`post_window`、`step`、`history`、`history_step`、`memory_high_ratio`、`heap_near_limit_ratio`、`next_gc_near_limit_ratio`、`gc_cpu_ratio`、`gc_cpu_sustain_seconds`、`node_available_min`、`rise_corr`、`lift_min`、`rule_out_lift`、`reverse_margin`、`min_history_samples`、`org_share_min`、`max_profiles`。

## 7. 测试

夹具（`apps/srenautix/test/support/oom-skill-fixture.ts`）是按一次真实的网关内存终止排查整理的虚构工作负载 StatefulSet shop/api-gateway（4 个副本，limit 4 GiB，GOMEMLIMIT 3865470566，GOMAXPROCS 2）：48 小时内 3 次 OOMKilled，一次由不可重试的拒绝被反复重试主导（流量接近零，归档积压上涨），两次由大请求体主导（转换字节与归档积压一起上涨）；另有大请求体的繁忙时段（存活堆高、没有终止）与内存不高时的导出推迟（反例）。测试包 `test/fixtures/skills/packs/shop` 提供序列与绑定。

| 测试 | 内容 |
|---|---|
| `test/unit/skill-oom-analyze.test.ts` | 分类为容器 limit 与存活堆贴着 GOMEMLIMIT（容器 CPU 代替 GC CPU）；主因为大请求体（中高，11-02 的两次），另一种触发为不可重试的拒绝（中），导出看门狗统计上未得到支持、不排除并是可能的次要加重因素；判定分级：统计上没有关联只记为统计上未得到支持，峰值型证据（请求体预算 held 在发生前冲高又回落）支持发生并成为主因，检验序列一直为 0 时才排除；峰值型序列的历史查询；证据表的依据与查询；组织只留前缀、请求体字段不进入记录；堆画像只列合法的文件名；渲染出的中英文正文与 `test/fixtures/skills/oom-rootcause/issue.*.md` 逐字一致 |
| `test/integration/skills-oom.test.ts` | 指标装进真实的 VictoriaMetrics、日志装进真实的 Loki、代码在内存中的 GitHub、Pod 状态与上一次退出的日志用录制的结果：手动运行开出 issue（标题、标签、结论、代码链接固定到提交、失效的提示、实际发出的查询、组织前缀、堆画像、运维选项、相关 issue），issue、运行记录与访问记录里没有请求体、上游错误文字与环境变量；没有新的发生时不投递；同一根因再次出现时评论 |
| `test/integration/skills-host.test.ts` | 宿主：加载与保留旧版本、授权与作用范围、暂停、能力白名单、去重与再次出现的四种情况、找回、每小时上限 |
| `packages/packs-sdk/test/skills-manifest.test.ts` | 清单与绑定的校验、引用、模板安全、能力注册表 |

# 技能 oom-rootcause：内存终止根因

容器因内存被终止（OOMKilled）、节点内存压力驱逐，或工作集持续贴近 limit 时，只读地完成一次根因排查，在业务仓库开 issue；同一根因再次出现时在已有 issue 下评论。机制见 [ADR 0181](../adr/0181-hot-pluggable-skills.md) 与 [README.zh-CN.md](README.zh-CN.md)。

技能目录 `skills/oom-rootcause/` 只含通用的步骤、算法参数与模板。工作负载自己的指标、日志事件、代码路径提示、运维选项与已有 issue 编号由部署方领域包的 `skill-bindings.yaml` 提供。

## 1. 边界

| 允许 | 不允许 |
|---|---|
| 领域包信号的瞬时与区间查询 | 自由的 PromQL、LogQL |
| 按绑定声明的事件查询 Loki，只保留声明的字段 | 读取请求体、响应体与其他用户数据 |
| Pod 状态、事件、上一次退出的容器日志尾部（运行对象的命名空间与 Pod） | `exec`、`cp`、`port-forward`、读取 Secret、读取环境变量 |
| 业务仓库的目录树与文件内容（固定到提交） | 写入业务仓库的内容、开 PR |
| 业务仓库的 issue：创建、评论、读取 | 修改 issue 的状态与标签 |
| issue 中列出堆画像的文件名与取出命令 | 取出或读取堆画像 |
| issue 中列出运维侧选项 | 修改 limit、GOMEMLIMIT、运行时配置，重启或驱逐 Pod |

## 2. 清单

`skills/oom-rootcause/skill.yaml`：

```yaml
api_version: srenautix.io/skill/v1
name: oom-rootcause
version: 1.0.0
title: {zh-CN: 内存终止根因, en: Memory kill root cause}
description:
  zh-CN: 容器因内存被终止或长期贴近 limit 时，只读地分类、取证、检验相关性与反例、定位代码，在业务仓库开 issue 或在已有 issue 下评论
  en: When a container is killed for memory or stays near its limit, classifies, collects evidence, tests correlation against counter-examples, locates code, and opens or comments on an issue in the business repository, read-only
maturity: beta
min_srenautix_version: 0.2.0
contract: '>=2.45.0 <3.0.0'

params:
  rss_limit_ratio: 0.85          # 工作集 / limit 的触发门槛
  rss_sustain: 10m               # 持续这么久才触发
  pre_window: 30m                # 发生之前的窗口
  post_window: 30m               # 发生之后的窗口（看重启后是否再次上涨）
  step: 30s
  history: 48h                   # 相关性与反例的窗口
  history_step: 5m
  memory_high_ratio: 0.75        # 内存序列 / 上限 达到它算"内存高"
  heap_near_limit_ratio: 0.9     # heap_inuse / GOMEMLIMIT
  next_gc_near_limit_ratio: 0.95 # next_gc / GOMEMLIMIT
  gc_cpu_ratio: 0.4              # GC 占用的核数 / GOMAXPROCS
  gc_cpu_sustain: 3m
  node_pressure_usage: 0.9       # 节点内存使用率达到它算节点压力
  rise_corr: 0.6                 # 发生之前嫌疑序列与内存序列的相关系数门槛
  lift_min: 1.5
  counter_max: 0.5
  reverse_margin: 0.2
  min_history_samples: 12
  org_share_min: 0.5
  max_profiles: 4

inputs:
  type: object
  additionalProperties: false
  required: [namespace, workload_kind, workload]
  properties:
    namespace: {type: string, minLength: 1}
    workload_kind: {type: string, enum: [Deployment, StatefulSet, DaemonSet]}
    workload: {type: string, minLength: 1}
    at: {type: string, format: date-time}       # 手动运行的参考时刻；不填为现在

binding:
  required: true
  schema: binding.schema.json

triggers:
  - id: oom-killed
    kind: metric
    signal: workload/container_oom_events
    window: 2m
    interval: 60s
  - id: evicted
    kind: kube
    object: pod
    match: {status_reason: [Evicted]}
  - id: node-memory-pressure
    kind: kube
    object: node
    match: {condition: [MemoryPressure], status: ['True']}
    expand: pods_on_node                # 节点上、作用范围内的工作负载各自一次
  - id: near-limit
    kind: metric
    signal: workload/container_memory_limit_ratio
    condition: value > params.rss_limit_ratio
    for: {param: rss_sustain}
    interval: 60s
  - id: manual
    kind: manual

debounce:
  settle: 5m
  coalesce: 2h

scope:
  component_types: [Deployment, StatefulSet, DaemonSet]

capabilities:
  metrics.query: {}
  metrics.query_range: {}
  logs.query: {}
  kube.read: {objects: [pod_status, pod_logs_previous, events]}
  code.read: {repo_role: business}
  issue.write: {repo_role: business}

budgets:
  run:
    duration: 10m
    metrics_queries: 200
    logs_queries: 30
    log_lines: 5000
    kube_reads: 20
    github_requests: 80
    code_files: 24
    code_bytes: 2MiB
    tokens: 0
  hourly: {runs: 6, issues: 1, comments: 6}

steps:
  - id: occ
    uses: trigger.occurrences@v1
    with:
      history: {param: history}

  - id: status
    uses: kube.read@v1
    needs: [occ]
    with:
      object: pod_status
      pods: "${{ steps.occ.output.pods }}"

  - id: events
    uses: kube.read@v1
    needs: [occ]
    with:
      object: events
      pods: "${{ steps.occ.output.pods }}"

  - id: around
    uses: metrics.range@v1
    needs: [occ]
    with:
      for_each: "${{ steps.occ.output.occurrences }}"
      before: {param: pre_window}
      after: {param: post_window}
      step: {param: step}
      signals:
        memory: "${{ binding.runtime == 'go' ? 'go-runtime/heap_inuse' : 'workload/container_memory_rss' }}"
        memory_limit: "${{ binding.runtime == 'go' ? 'go-runtime/gomemlimit' : 'workload/container_memory_limit' }}"
        rss: workload/container_memory_rss
        container_limit: workload/container_memory_limit
        next_gc: go-runtime/next_gc
        gc_cpu: go-runtime/gc_cpu_cores
        gomaxprocs: go-runtime/gomaxprocs
        cpu: workload/container_cpu_cores
        node_memory: node/node_memory_usage
      extra: "${{ binding.suspects.map(s, s.series).flatten() + binding.context }}"

  - id: logs
    uses: logs.events@v1
    needs: [occ]
    with:
      events: "${{ binding.logs }}"
      container: "${{ binding.container }}"
      windows: "${{ steps.occ.output.occurrences.map(o, {'pod': o.pod, 'from': o.at - duration(params.pre_window), 'to': o.at}) }}"

  - id: previous
    uses: kube.read@v1
    needs: [status]
    when: "${{ steps.status.output.pods.exists(p, p.containers.exists(c, c.name == binding.container && c.restarts > 0)) }}"
    with:
      object: pod_logs_previous
      pods: "${{ steps.occ.output.pods }}"
      container: "${{ binding.container }}"

  - id: previous_events
    uses: logs.extract@v1
    needs: [previous]
    with:
      text: "${{ steps.previous.output.logs }}"
      events: "${{ binding.logs }}"

  - id: kind
    uses: analyze.memory_kind@v1
    needs: [occ, status, events, around]
    with:
      runtime: "${{ binding.runtime }}"
      occurrences: "${{ steps.occ.output.occurrences }}"
      pods: "${{ steps.status.output.pods }}"
      kube_events: "${{ steps.events.output.events }}"
      series: "${{ steps.around.output }}"

  - id: history
    uses: metrics.range@v1
    needs: [occ]
    with:
      pods: all_of_workload
      window: {last: {param: history}}
      step: {param: history_step}
      signals:
        memory: "${{ binding.runtime == 'go' ? 'go-runtime/heap_inuse' : 'workload/container_memory_rss' }}"
        memory_limit: "${{ binding.runtime == 'go' ? 'go-runtime/gomemlimit' : 'workload/container_memory_limit' }}"
      extra: "${{ binding.suspects.map(s, s.series).flatten() + binding.context }}"

  - id: rank
    uses: analyze.suspects@v1
    needs: [kind, around, history, logs, previous_events]
    with:
      suspects: "${{ binding.suspects }}"
      occurrences: "${{ steps.kind.output.occurrences }}"
      around: "${{ steps.around.output }}"
      history: "${{ steps.history.output }}"
      log_events: "${{ steps.logs.output.records + steps.previous_events.output.records }}"

  - id: requests
    uses: analyze.top@v1
    needs: [rank, logs]
    with:
      records: "${{ steps.logs.output.records.filter(r, r.event == binding.top_requests.event && r.pod in steps.rank.output.main_group.pods) }}"
      by: "${{ binding.top_requests.by }}"
      limit: 10
      group:
        field: org
        value_field: "${{ binding.top_requests.by[0] }}"
        min_value: "${{ binding.top_requests.large_bytes }}"
        share_min: {param: org_share_min}

  - id: profiles
    uses: analyze.top@v1
    needs: [logs, previous_events]
    when: "${{ has(binding.profiles) }}"
    with:
      records: "${{ (steps.logs.output.records + steps.previous_events.output.records).filter(r, r.event == binding.profiles.event) }}"
      by: [time]
      limit_per_pod: {param: max_profiles}
      validate:
        field: "${{ binding.profiles.field }}"
        pattern: "${{ binding.profiles.pattern }}"

  - id: code
    uses: code.locate@v1
    needs: [rank]
    with:
      hints: "${{ steps.rank.output.ranked.map(s, s.code).flatten() }}"

  - id: related
    uses: issue.related@v1
    needs: [rank]
    with:
      references: "${{ steps.rank.output.ranked.map(s, s.references).flatten() }}"

  - id: publish
    uses: issue.publish@v1
    needs: [kind, rank, requests, profiles, code, related]
    when: "${{ steps.kind.output.occurrences.size() > 0 }}"
    with: {output: issue}

outputs:
  fingerprint:
    - "${{ binding.id }}"
    - "${{ steps.rank.output.main != null ? steps.rank.output.main.code_path : 'unexplained' }}"
    - "${{ steps.rank.output.main != null ? steps.rank.output.main.id : 'unexplained' }}"
    - "${{ steps.requests.output.group.key }}"
  issue:
    templates: {zh-CN: templates/issue.zh-CN.md, en: templates/issue.en.md}
    comment_templates: {zh-CN: templates/comment.zh-CN.md, en: templates/comment.en.md}
    title:
      zh-CN: '{{workload}} 内存终止：{{headline}}（{{occurrences.count}} 次，{{window}}）'
      en: '{{workload}} memory kills: {{headline}} ({{occurrences.count}} in {{window}})'
    labels: "${{ binding.labels }}"
```

`with` 中的 `{param: <名字>}` 取 `params` 的值（部署方可在 values 覆盖）。这个技能使用的内置信号：`workload` 包的 `container_oom_events`、`container_memory_limit_ratio`、`container_last_terminated` 与新增的 `container_memory_rss`、`container_memory_limit`、`container_cpu_cores`；`node` 包的 `node_memory_usage`；新的内置包 `go-runtime` 的 `heap_inuse`（`go_memstats_heap_inuse_bytes`）、`next_gc`（`go_memstats_next_gc_bytes`）、`gomemlimit`（`go_gc_gomemlimit_bytes`）、`gc_cpu_cores`（`rate(go_cpu_classes_gc_total_cpu_seconds_total)`）、`gomaxprocs`（`go_sched_gomaxprocs_threads`）。

## 3. 绑定

`binding.schema.json` 规定的字段：

| 字段 | 内容 |
|---|---|
| `runtime` | `go` 或 `other`；`go` 时内存序列为 `heap_inuse`、上限为 GOMEMLIMIT，否则为 RSS 与容器 limit |
| `container` | 目标容器名 |
| `labels` | issue 的标签（另加 `srenautix`、`srenautix:oom-rootcause`） |
| `context` | 只进入证据表的序列：`{signal, title, unit}` |
| `suspects[]` | 嫌疑项，顺序即同分时的优先级 |
| `suspects[].id`、`title`、`mechanism` | 机制 id（进入指纹）、标题与机制说明（`zh-CN`、`en`） |
| `suspects[].series[]` | `{signal, role, unit, high}`：`role` 为 `indicator`（参与检验）或 `context`；`high` 是"高"的门槛，没有时取 48 小时内的 p90 |
| `suspects[].logs[]` | 支持这个嫌疑项的日志事件 id |
| `suspects[].logs_required` | `true` 时一次发生之前的窗口内必须出现 `logs` 中的事件，这次发生才支持该嫌疑项（用于只靠指标分不开的机制） |
| `suspects[].code[]` | `{path, pattern, before, after, note}`：业务仓库中的路径与字面量模式，命中行前后各取若干行 |
| `suspects[].fixes[]` | 业务代码的修复方向（文案） |
| `suspects[].options[]` | 运维侧选项：`title`、`domain`（作用领域）、`impact`（影响范围）、`benefit`（收益）、`risk`（风险） |
| `suspects[].references[]` | 业务仓库中已有的相关 issue 编号 |
| `logs[]` | 日志事件：`id`、`message`（消息键的取值，精确匹配）、`format`（`json` 或 `logfmt`）、`message_key`、`fields[]`（`{name, type, as}`，类型为 `bytes`、`int`、`float`、`bool`、`duration_ms`、`string`、`path`、`request_id`、`org_id`）、可选的 `where`（字段等值条件，解析之后过滤） |
| `identifiers.org` | 组织 id 的字段与保留的前缀长度 |
| `top_requests` | 大请求的事件、排序字段、"大请求体"的字节门槛 |
| `profiles` | 堆画像：事件、文件路径字段、文件名模式（RE2）、取出命令与分析命令的模板 |

通用的示例（名字是虚构的）：

```yaml
bindings:
  - skill: oom-rootcause
    id: api-gateway
    applies_to:
      workloads: [{kind: StatefulSet, namespace: shop, name: api-gateway}]
    data:
      runtime: go
      container: gateway
      labels: [bug, area/gateway]
      context:
        - {signal: shop/active_requests, title: {zh-CN: 活跃请求, en: Active requests}, unit: count}
      suspects:
        - id: body-buffering
          title: {zh-CN: 大请求体整体读入内存, en: Large request bodies buffered whole}
          mechanism:
            zh-CN: 大请求体整体解码进堆，并发的大请求叠加，超出请求体预算预留的余量
            en: Large request bodies are decoded whole into the heap and concurrent ones add up beyond the budget headroom
          series:
            - {signal: shop/body_bytes_rate, role: indicator, unit: bytes_per_second}
            - {signal: shop/large_bodies, role: context, unit: count}
          logs: [request_end]
          code:
            - {path: internal/body/limit.go, pattern: 'func budgetCeiling', before: 2, after: 8}
          fixes:
            - {zh-CN: 大请求体流式处理，或限制每个副本同时在途的大请求数, en: Stream large bodies or cap concurrent large requests per replica}
          options:
            - title: {zh-CN: 降低单个请求体的上限, en: Lower the per-request body limit}
              domain: {zh-CN: 网关请求准入, en: Gateway admission}
              impact: {zh-CN: 超过上限的请求返回 413, en: Requests over the limit get 413}
              benefit: {zh-CN: 单个请求占用的堆有上限, en: Bounds heap per request}
              risk: {zh-CN: 有业务影响，需要和调用方确认, en: Business-visible, needs caller agreement}
          references: [101]
        - id: retry-backlog
          title: {zh-CN: 不可重试的拒绝被反复重试, en: Non-retryable rejections retried}
          mechanism: {zh-CN: 不可重试的上游拒绝仍被重试，每次尝试都让同一条归档记录变大, en: Non-retryable upstream rejections are retried and every attempt grows the same archive record}
          series:
            - {signal: shop/archive_backlog_bytes, role: indicator, unit: bytes}
          logs: [attempts_exhausted]
          logs_required: true
          code:
            - {path: internal/executor/retry.go, pattern: 'func retryConfig', before: 1, after: 10}
        - id: export-watchdog
          title: {zh-CN: 导出任务的内存看门狗, en: Export task memory watchdog}
          mechanism: {zh-CN: 导出任务按进程的堆对象计量，把其他请求的垃圾算进任务, en: The export task measures process heap objects and counts other requests' garbage}
          series:
            - {signal: shop/export_deferred_rate, role: indicator, unit: per_second}
          code:
            - {path: internal/export/memory.go, pattern: 'heapObjectsMetric', before: 1, after: 4}
      logs:
        - id: request_end
          message: request_end
          format: json
          message_key: msg
          fields:
            - {name: request_id, type: request_id}
            - {name: organization_id, type: org_id, as: org}
            - {name: path, type: path}
            - {name: duration_ms, type: duration_ms}
            - {name: request_body_bytes, type: bytes}
        - id: attempts_exhausted
          message: request_failed
          format: json
          message_key: msg
          fields:
            - {name: request_id, type: request_id}
            - {name: attempts, type: int}
            - {name: retryable, type: bool}
          where: {retryable: false}
        - id: heap_profile
          message: heap_profile_captured
          format: json
          message_key: msg
          fields:
            - {name: path, type: path}
      identifiers:
        org: {field: org, prefix: 8}
      top_requests: {event: request_end, by: [request_body_bytes, duration_ms], large_bytes: 16777216}
      profiles:
        event: heap_profile
        field: path
        pattern: '^/var/lib/app/heap-profiles/heap-[0-9]{8}T[0-9]{6}Z-[0-9]+MiB\.pb\.gz$'
        fetch: 'kubectl -n {namespace} cp {pod}:{path} ./{file} -c {container}'
        analyze: 'go tool pprof -sample_index=inuse_space -top {file}'
```

## 4. 步骤与算法

记号：一次发生 `o = (pod, container, at, trigger)`；内存序列 `M`（Go 为 heap_inuse，其他为 RSS），上限 `L`（Go 为 GOMEMLIMIT，其他为容器 limit）；嫌疑项 `s` 的检验序列 `X_s`。全部序列按 `step` 取到相同的时间点上，缺失点为 null，两边都有值的点才参与计算。

### 4.1 发生（`trigger.occurrences@v1`）

触发产生的发生按 `debounce.settle` 合并。手动运行或发生缺少时刻时，在 `history` 窗口内按 `workload/container_oom_events` 与 `workload/container_last_terminated` 找出终止时刻（Pod 状态的 `last_terminated.finished_at` 优先）。

### 4.2 分类（`analyze.memory_kind@v1`）

每次发生给出 `kind` 与 Go 服务的 `heap`：

| `kind` | 条件 |
|---|---|
| `node_pressure` | 触发为驱逐或节点压力；或 Pod 状态的原因为 `Evicted`；或发生之前 5 分钟内 `node_memory_usage ≥ node_pressure_usage` |
| `container_limit` | 终止原因为 `OOMKilled`，并且不满足 `node_pressure` |
| `near_limit` | `near-limit` 触发，没有终止 |
| `unknown` | 其他 |

| `heap`（`runtime: go`） | 条件 | issue 中的写法 |
|---|---|---|
| `live_heap_at_limit` | 发生之前 5 分钟内 `max(heap_inuse / GOMEMLIMIT) ≥ heap_near_limit_ratio`，`next_gc / GOMEMLIMIT ≥ next_gc_near_limit_ratio`，并且 `gc_cpu_cores ≥ gc_cpu_ratio × GOMAXPROCS` 持续 `gc_cpu_sustain` | 存活堆贴着 GOMEMLIMIT，GC 连续运行也收不回：占用的是存活数据 |
| `non_heap` | `RSS / limit ≥ 0.95`，同时 `heap_inuse / GOMEMLIMIT < 0.7` | 堆之外的内存（goroutine stack、mmap、cgo）占满了 limit |
| `no_gomemlimit` | 没有 GOMEMLIMIT，或它不小于容器 limit | GOMEMLIMIT 没有生效 |
| `no_data` | 缺少 Go 运行时指标 | — |

没有 `gc_cpu_cores` 时用容器 CPU 作为上界判断，这一行标为推断（"用容器 CPU 代替 GC CPU"）。

### 4.3 嫌疑项的检验（`analyze.suspects@v1`）

对每个嫌疑项的每条 `indicator` 序列：

1. **发生之前**：在 `[at − pre_window, at]` 上，`rise = X(at) − X(at − pre_window) > 0`，并且 `high` 有声明时 `max X ≥ high`；`corr` 为 X 与 M 的 Pearson 相关系数（至少 10 个点）。`rise` 且 `corr ≥ rise_corr`（`logs_required` 时还要求窗口内出现声明的日志事件）时这次发生支持该嫌疑项。`[at − 2m, at]` 内 X 仍在上升时记 `last_minute`。
2. **48 小时**：工作负载全部 Pod 在 `[now − history, now]`、步长 `history_step` 的样本。`mem_high = M / L ≥ memory_high_ratio`；`x_high = X ≥ high`（没有声明时为 X 的 p90）。`support = P(mem_high | x_high)`，`lift = support / P(mem_high)`，`counter = 1 − support`（X 高而内存不高的样本比例，即反例）。`x_high` 的样本少于 `min_history_samples` 时为 `insufficient`。
3. **先后**：`lead = max_k corr(X_t, M_{t+k})`，`lag = max_k corr(M_t, X_{t+k})`，k 为 1 到 3 个步长。`lag − lead ≥ reverse_margin` 且 `lag ≥ 0.5` 时记 `reverse`：X 跟在内存后面变化。
4. **日志**：发生之前的窗口内，嫌疑项声明的日志事件（含上一次退出的日志）出现的次数。

判定：

| 判定 | 条件 |
|---|---|
| `ruled_out` | `counter > counter_max`，或 `reverse` |
| `main` 候选 | 没有判为 `ruled_out`；分组内至少一半的发生支持它；`lift ≥ lift_min` |
| `secondary` | 没有判为前两者；至少一次发生支持它，或日志事件出现过 |
| `no_data` | 全部发生都没有 X |

排序分数 `score = 支持的发生数 × lift × (1 − counter)`，同分时按绑定中的顺序。

**分组**：每次发生取支持它的嫌疑项中分数最高的一个作为它的触发项；触发项相同的发生为一组。发生数最多的一组（同数时分数高者）给出主因，其余组在 issue 中写作"另一种触发"，各自给出嫌疑项与置信度；没有任何嫌疑项支持的发生列为"未解释"。

**置信度**：

| 主因的置信度 | 条件 |
|---|---|
| 高 | 组内每次发生都支持；`lift ≥ 2`；`counter ≤ 0.3`；有日志事件；分类为 `live_heap_at_limit`（Go）或 `container_limit` |
| 中高 | 至少 2/3 的发生支持；`lift ≥ 1.5`；`counter ≤ 0.5`；有日志事件 |
| 中 | 至少一半的发生支持，并且 `lift ≥ 1.5` 或有日志事件 |
| 低 | 其他 |

`ruled_out` 的置信度：`counter ≥ 0.6` 且 `reverse` 时为高，满足其一为中。`ruled_out` 而有 `last_minute` 的嫌疑项写作"次要加重因素"：存活堆已经贴近上限时，它在最后几分钟的分配可能是压垮的最后一下（推断）。

证据表另外给出每条 `indicator` 与 `context` 序列在 48 小时样本上与 M 的相关系数。

### 4.4 大请求与组织（`analyze.top@v1`）

主因分组的发生之前的窗口内，`top_requests.event` 的记录按 `by` 排序取前 10 条，只含 request_id、组织前缀、路径、请求体字节数、时长。请求体不小于 `large_bytes` 的记录按组织前缀汇总字节数：份额最高的组织占比不低于 `org_share_min` 时，它的前缀进入指纹；否则指纹中的组织为 `*`，issue 写"多个组织"。

### 4.5 代码定位（`code.locate@v1`）

业务仓库的提交按仓库布局的版本规则取得（`running`：ops 仓库发布输入中的业务提交；没有时取默认分支的头，与主动优化相同，`compare/<分支>...<分支>` 的 `base_commit`）。每条提示读取文件，找出模式（字面量）第一次出现的行，取 `[行 − before, 行 + after]`，生成固定到提交的链接 `https://github.com/<仓库>/blob/<提交>/<路径>#L<起>-L<止>`。文件不存在或模式不再出现时记为"提示失效"，进入 issue 的"未验证"一节，领域包测试同样报告它。

### 4.6 堆画像（`analyze.top@v1`）

`profiles.event` 的记录中，路径按 `pattern` 校验，不符合的丢弃；每个 Pod 按时间取最近 `max_profiles` 个。issue 列出文件、取出命令与分析命令；命令中的占位符只用校验过的值替换。

### 4.7 相关 issue（`issue.related@v1`）

本技能在同一工作负载上开过的其他 issue（任何指纹），加上各嫌疑项的 `references`。

## 5. 去重与再次出现

- 指纹：`sha256(oom-rootcause, 集群, 绑定 id, 主因的第一个代码路径, 主因的机制 id, 组织前缀或 *)`。没有主因时代码路径与机制 id 都为 `unexplained`，同一工作负载上未解释的终止进入同一个 issue。
- 同一指纹的 issue 打开时，`debounce.coalesce` 之后的新运行只追加评论：新的发生表、证据表中数值变化的行、置信度与分组的变化、新出现的大请求组织（只有前缀）。
- 主因变化时（例如新的发生由另一种机制主导）指纹不同，开新 issue，正文的"相关"一节引用旧 issue。

## 6. issue 模板

模板的变量由 `issue.publish@v1` 从步骤输出整理而成：`headline` 为主因的标题，没有主因时为"原因未解释"；`evidence` 是证据表的行，每行带依据与实际发出的查询。评论模板 `templates/comment.zh-CN.md` 只含新的发生、变化的证据行与置信度的变化。

`templates/issue.zh-CN.md`（Mustache；每个值在渲染时做 Markdown 转义）：

```markdown
<!-- srenautix:skill=oom-rootcause/{{fingerprint}} -->
## 现象

{{workload_kind}} `{{workload}}`（命名空间 `{{namespace}}`，容器 `{{container}}`，limit {{limit}}{{#gomemlimit}}，GOMEMLIMIT {{gomemlimit}}，GOMAXPROCS {{gomaxprocs}}{{/gomemlimit}}{{#image}}，镜像 `{{image}}`{{/image}}）在 {{window}} 内 {{occurrences.count}} 次内存终止：

| 时间 (UTC) | Pod | 分类 | 说明 |
|---|---|---|---|
{{#occurrences.items}}
| {{at}} | {{pod}} | {{kind_text}} | {{note}} |
{{/occurrences.items}}

结论（主因 / 次因 / 置信度）：

{{#main}}
- **主因（置信度{{confidence}}）**：{{title}}。{{mechanism}} {{heap_text}}
{{/main}}
{{#others}}
- **另一种触发（置信度{{confidence}}）**：{{pods_and_times}} 由 {{title}} 主导。{{mechanism}}
{{/others}}
{{#ruled_out}}
- **排除为主因（置信度{{confidence}}）**：{{title}}{{#aggravating}}，是次要加重因素{{/aggravating}}，理由见 §3。
{{/ruled_out}}
{{^main}}
- 没有嫌疑项同时满足发生之前的上涨与 48 小时的支持，见 §5。
{{/main}}

## 1. 证据

| 时间 (UTC) | Pod | 指标 / 日志 | 数值 | 依据 | 查询 |
|---|---|---|---|---|---|
{{#evidence}}
| {{when}} | {{pod}} | {{what}} | {{value}} | {{basis}} | `{{query}}` |
{{/evidence}}

{{#requests.items.length}}
大请求（只列 request_id 与组织前缀）：

| request_id | 组织 | 路径 | 请求体 | 时长 |
|---|---|---|---|---|
{{#requests.items}}
| `{{request_id}}` | `{{org}}…` | `{{path}}` | {{body}} | {{duration}} |
{{/requests.items}}
{{/requests.items.length}}

## 2. 机制与代码位置

{{#ranked}}
{{index}}. **{{title}}**（{{verdict_text}}）：{{mechanism}}（推断，领域包声明的机制）
{{#locations}}
   - [`{{path}}:{{start}}-{{end}}`]({{url}}){{#note}}：{{note}}{{/note}}
{{/locations}}
{{/ranked}}

## 3. 排除项与反例

{{#ruled_out}}
- **{{title}}**：48 小时内它处于高位的 {{x_high}} 个样本中 {{counter_pct}} 内存不高（反例）；{{#reverse}}它的变化落后于内存（lag {{lag}} > lead {{lead}}），更像是内存高带来的结果；{{/reverse}}{{#aggravating}}发生之前最后 2 分钟仍在上升，可能是压垮的最后一下（推断）。{{/aggravating}}
{{/ruled_out}}
{{^ruled_out}}
- 没有被反例排除的嫌疑项。
{{/ruled_out}}

## 4. 修复方向与运维侧选项

业务代码：

{{#fixes}}
- [ ] {{text}}
{{/fixes}}

运维侧选项（只列出，不执行，由人决定）：

| 选项 | 作用领域 | 影响范围 | 收益 | 风险 |
|---|---|---|---|---|
{{#options}}
| {{title}} | {{domain}} | {{impact}} | {{benefit}} | {{risk}} |
{{/options}}

## 5. 未验证

{{#inferred}}
- {{text}}
{{/inferred}}
{{#stale_hints}}
- 代码提示失效：`{{path}}` 中找不到 `{{pattern}}`。
{{/stale_hints}}
{{#unexplained}}
- 未解释的发生：{{pod}} {{at}}。
{{/unexplained}}
{{#profiles.length}}
- 堆里具体是哪些对象需要堆画像。保留的画像：
{{#profiles}}
  - {{pod}}：`{{path}}`，取出：`{{fetch}}`，分析：`{{analyze}}`
{{/profiles}}
{{/profiles.length}}

{{#related.length}}
相关：{{#related}}#{{number}} {{/related}}
{{/related.length}}

---
由 SreNautix 技能 oom-rootcause {{skill_version}}（摘要 `{{skill_digest}}`，运行 [{{run_id}}]({{run_url}})）只读生成；同一根因再次出现时在这里评论。
```

证据表的"依据"列：

| 写法 | 含义 |
|---|---|
| 观测 | 查询结果、日志字段、Pod 状态的原值 |
| 推断（统计） | 相关系数、反例比例、先后、分组与置信度 |
| 推断（领域包声明） | 绑定中写的机制说明 |
| 推断（代替） | 缺少指标时用其他指标代替的判断，例如用容器 CPU 代替 GC CPU |

每一行的"查询"列是渲染之后、实际发出的 PromQL 或 LogQL；Kubernetes 读取写作 `kube_pod_status <Pod>`、`kube_logs --previous <Pod>/<容器>`。

## 7. 测试

`skills/oom-rootcause/tests/` 的用例都使用虚构的工作负载 `shop/api-gateway` 与上面的示例绑定：

| 用例 | 夹具 | 期望 |
|---|---|---|
| `live-heap-body-buffering` | 3 次 `OOMKilled`：两次发生之前 `body_bytes_rate` 与 heap_inuse 同步上涨，另一次由 `archive_backlog_bytes` 与 `attempts_exhausted` 主导；`export_deferred_rate` 在内存低的时段同样处于高位 | 分类 `container_limit` + `live_heap_at_limit`；主因 `body-buffering`（中高）；另一种触发 `retry-backlog`（中）；`export-watchdog` 被反例排除并标为次要加重因素（高）；正文与期望文件逐字一致 |
| `node-pressure` | 驱逐，节点内存使用率 0.96 | 分类 `node_pressure`；结论写明节点压力，嫌疑项照常检验 |
| `non-heap` | RSS 贴着 limit，heap_inuse 只有 GOMEMLIMIT 的 40% | 分类 `non_heap` |
| `recurrence` | 同一指纹的第二次运行 | 只评论，不开新 issue |
| `stale-hint` | 代码提示的模式不在文件里 | "未验证"一节列出失效的提示 |
| `insufficient-history` | 48 小时只有 6 小时数据 | 嫌疑项为 `insufficient`，置信度不高于中 |
| `no-request-bodies` | 日志行带请求体字段 | 运行记录、步骤输出与 issue 中都没有请求体 |

部署方在自己的领域包测试里用真实事件的序列与日志行作为夹具，期望输出是人工确认过的 issue。

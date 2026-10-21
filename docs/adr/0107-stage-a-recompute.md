# 0107 阶段 A 按当前领域包重算

## 背景

影子环境升级加载新的领域包之后，已有事件的证据卡一直是 0：证据卡的实时重跑只重跑报告里已经声明过的卡，研判读取的是已经存下的阶段 A 报告，要等事件出新版本或有新事件才会用新领域包出卡。

## 决定

1. **报告记录 pack.lock**：每份阶段 A 报告记下计算时加载的领域包摘要（`stage_a_reports.pack_lock`）。
2. **人工入口**：`POST /v1/incidents/{ref}/stage-a/recompute`（`research.request` 权限，契约 openapi.yaml）按当前领域包与当前拓扑重算事件当前版本的阶段 A：证据卡、规则提议（按幂等键，不会重复）与处置判断，替换该版本的报告并发布 `stage_a.reported`；写入治理审计 `stage_a.recompute`。
3. **领域包变化后自动重算**：主实例每分钟找出仍在触发、报告的 pack.lock 与当前不同的事件（领域包增加、减少或升级），按首次触发时间最多重算 `stage_a.recompute_per_minute` 个（默认 10，0 关闭）。只算阶段 A，不触发模型研判。
4. **研判前刷新**：worker 取研判输入时，研判所用版本的报告不是用当前 pack.lock 算出的，先重算该版本的阶段 A，再返回输入。
5. **重算前重新解析成员告警，并回写存储**：升级前接入的告警按当时的规则存储（kind 是标签原样的 `node`、`application`，没有告警目录条目，组件是旧格式），阶段 A 读存储的告警，新领域包的卡与目录都对不上。三种重算（manual、pack_change、before_research）都先用当前的解析器（kind 规范化、告警目录、拓扑查找、属主折叠、拓扑覆盖）重新解析事件的在场成员告警，有变化的行回写 `alert_state` 的分类、实体、解析方式与组件，不改状态与时间；组件有变化时通知事件流水线重算事件（新的组件可能改变事件的键与根因）。选择回写而不是只在重算时生效：收敛、覆盖页、检测器的去重与之后的每次阶段 A 都读存储，只在重算时生效会让它们与证据卡不一致。指标 `srenautix_alerts_reresolved_total`。
6. **kind 的比较不区分大小写、忽略 API 组**：领域包按不带组的 kind 声明（组件类型的 `match.kind`、卡片的 `applies_to.kinds`），解析后的实体带拓扑的写法（`Application.argoproj.io`、`Cluster.postgresql.cnpg.io`）。卡片选择与按名称匹配组件类型都按 `sameKind` 比较（声明了 `api_group` 时组仍须一致）；拓扑查找不区分大小写，没有点的 kind 也匹配 `<kind>.<组>`；告警没有命名空间（规则聚合掉了 namespace）时也接受按名称唯一的命名空间级对象，同名对象在多个命名空间时不解析。CNPG 的三种告警（没有命名空间的集群级告警、带命名空间的集群级告警、Pod 告警沿 owned_by）因此落在同一个组件上。
7. 指标 `srenautix_stage_a_recomputes_total{reason}`（manual、pack_change、before_research）。

## 结果

- 升级领域包后，仍在触发的事件在几分钟内用新领域包出卡；研判总是基于当前领域包的证据卡。
- 已恢复的事件不自动重算，需要时用人工入口。

# 0107 阶段 A 按当前领域包重算

## 背景

影子环境升级加载新的领域包之后，已有事件的证据卡一直是 0：证据卡的实时重跑只重跑报告里已经声明过的卡，研判读取的是已经存下的阶段 A 报告，要等事件出新版本或有新事件才会用新领域包出卡。

## 决定

1. **报告记录 pack.lock**：每份阶段 A 报告记下计算时加载的领域包摘要（`stage_a_reports.pack_lock`）。
2. **人工入口**：`POST /v1/incidents/{ref}/stage-a/recompute`（`research.request` 权限，契约 openapi.yaml）按当前领域包与当前拓扑重算事件当前版本的阶段 A：证据卡、规则提议（按幂等键，不会重复）与处置判断，替换该版本的报告并发布 `stage_a.reported`；写入治理审计 `stage_a.recompute`。
3. **领域包变化后自动重算**：主实例每分钟找出仍在触发、报告的 pack.lock 与当前不同的事件（领域包增加、减少或升级），按首次触发时间最多重算 `stage_a.recompute_per_minute` 个（默认 10，0 关闭）。只算阶段 A，不触发模型研判。
4. **研判前刷新**：worker 取研判输入时，研判所用版本的报告不是用当前 pack.lock 算出的，先重算该版本的阶段 A，再返回输入。
5. 指标 `srenautix_stage_a_recomputes_total{reason}`（manual、pack_change、before_research）。

## 结果

- 升级领域包后，仍在触发的事件在几分钟内用新领域包出卡；研判总是基于当前领域包的证据卡。
- 已恢复的事件不自动重算，需要时用人工入口。

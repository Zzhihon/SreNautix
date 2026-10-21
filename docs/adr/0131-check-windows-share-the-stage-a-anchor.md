# 0131 阶段 B 的检查与阶段 A 用同一个锚点

## 背景

阶段 A 的卡片窗口以事件首次触发为锚点；某个实体（或告警归属的组件）上最晚开始的在场成员告警落在窗口终点之后时，这个实体上的卡改以那条告警为锚点（ADR 0107 §7）。阶段 B 把卡片当作区分性检查执行时（ADR 0116），窗口一律相对事件首次触发，没有按之后升级的成员告警重新锚定。

持续较长、症状在首次触发之后才出现的事件里，检查与阶段 A 的卡看到的是不同的时间段。2026-10-20 的发布事故（重建包 release-rollback-acme）中，事件在发布时首次触发，16:24:25 回退，worker 的副本不可用等告警在回退之后才开始；阶段 A 在 worker 上的卡已经按这些告警重新锚定，同一张卡作为检查执行时仍看发布时那一段，看不到回退阶段的症状（Zzhihon/SreNautix#6）。

## 决定

1. **一个锚点函数**（`memberLatest`）：每个实体（与告警归属的组件）上最晚开始的在场成员告警，阶段 A 的证据卡、阶段 B 的卡片检查与查询模板都用它；锚点是事件首次触发，最晚的告警落在这张卡的窗口终点之后时改为那条告警的开始时间。终点不晚于研判时刻。
2. **成员告警取研判所用的事件版本**：server 的 `/v1/research/tasks/{run_id}/query` 读研判任务对应版本里在场的成员告警；评测的 `ReconstructedQueryRunner` 用快照里的成员告警（`context.alerts`）。两者调用 `PackEvidence.runCardCheck` 与 `runTemplate` 时传入这些告警。
3. **`window_before`、`window_after` 相对这个锚点**：检查参数的 schema 与说明按此写，模型看到的说明是"锚点是事件首次触发，或这个组件上之后才升级的告警的开始时间"。

## 结果

- 实现在 `apps/srenautix/src/stage-a/pack-evidence.ts`（`memberLatest`、`runCardCheck`、`runTemplate`）、`api/routes-research.ts`、`eval/reconstruct.ts`、`eval/phase2.ts` 与 `packages/packs-sdk/src/judge/check-args.ts`；契约不变。
- 集成测试（重建包 release-rollback-acme、真实 Prometheus）：worker 上最晚的在场成员告警在回退之后；阶段 A 在 worker 上重新锚定过的卡，作为检查执行时窗口与阶段 A 的卡完全相同，终点不早于这条告警。原有的卡片检查用例按同一个锚点断言窗口起点。单元测试覆盖按实体与按告警组件取最晚告警。

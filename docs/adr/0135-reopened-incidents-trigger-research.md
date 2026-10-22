# 0135 重开的事件触发研判

## 背景

ADR 0132 让超出回看窗口的 resolved 事件在检测器以原来的告警重新触发时重开：incident_id 与标签不变，版本加一，版本原因记为 `reopened`，阶段 A 按新版本重新出报告。

CCHP 影子 daeb169 上重开了 7 个 PodDisruptionBudget 事件（Zzhihon/SreNautix#9），它们都没有进入阶段 B。流水线按 `reasonFor(上一版本, 新版本, 指纹是否变化)` 决定研判原因：有上一版本时只认根因变化、级别升高与指纹变化。重开的事件根因与级别都不变，阶段 A 的指纹带迟滞、通常也不变，于是没有任何原因，长期存在的 PDB 阻塞驱逐一直没有研判结论。事件上一次研判（如果有）发生在重开之前，结论针对的是已经结束的那一段。

## 决定

1. **研判原因新增 `reopened`**（契约 `ResearchReason`，2.24.0，新增枚举值）。新版本的版本原因是 `reopened`（从 resolved 回到 firing，引擎在写入 `incident_versions` 时判定）时，流水线以 `reopened` 申请阶段 B；判定先于根因变化、级别升高与指纹变化。窗口外重开与窗口内"回到 firing 且成员或根因变化"两种情况都记 `reopened`，版本不变的窗口内抖动不产生新版本，也不触发。
2. **与新事件同等对待**：队列优先级里 `reopened` 与 `new_incident` 一样计为新事件（`is_new`）。准入规则不变也不放宽：严重度（只有 warning、critical）、抑制、模型路由、预算（≥80% warning 只出阶段 A，≥100% 只有 critical）、风暴（只有排名前 N 的根因）、每事件 6 小时最多 3 次模型研判，都按原样执行；排队中的旧触发被这次取代。
3. 用新原因而不是复用 `new_incident`：事件不是新的（同一个 id、标签与历史），研判记录、控制台与审计需要能区分"新事件"和"旧问题又出现"。

## 结果

- 实现：`apps/srenautix/src/incident/engine.ts`（`RecomputeResult.reopened`）、`incident/pipeline.ts`（`reasonFor`）、`scheduler/admission.ts`；契约 `contract/schemas/events.schema.json`，控制台文案"事件重开"。
- 集成测试（`test/integration/incident-engine.test.ts`）：三个 PDB 事件新建 → resolved → 超出回看窗口 → 检测器重新触发而重开；两个事件以 `reopened` 入队（`is_new`，排队中的 `new_incident` 被取代），6 小时内已研判 3 次的那个事件记为 skipped（capped）。

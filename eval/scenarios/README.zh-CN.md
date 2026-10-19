# Kind 级联故障场景的标准答案

每个文件对应 `deploy/kind/scenarios/<id>/` 中的一个场景（DESIGN §14.1 的 `scenario` 用例）。注入、校验与恢复由 `deploy/kind/scenario.sh` 执行，注入与恢复时间写入 `$SCENARIO_STATE_DIR/<id>.json`（字段 `injected_at`、`verified_at`、`recovered_at`、`cluster`）。

场景由维护者编写（`authored_by: maintainer`），存在作者偏差，成绩单独报告（DESIGN §14.3）。

## 格式

文件中与 `contract/schemas/eval-case.schema.json` 同名的字段含义相同：`case_id`、`version`、`suite`（`scenarios-kind`）、`type`（`scenario`）、`cluster_id`、`authored_by`、`truth_source`（`kind: injected`）、`truth`（EvalTruth）。评测运行器在场景注入后补齐运行时字段，生成完整的 EvalCase：

| 字段 | 来源 |
|---|---|
| `incident_id`、`label` | 注入后 SreNautix 归并出的、根因在 `truth.root_components` 中或成员与注入时间窗重叠的事件 |
| `started_at` | 该事件的首次触发时间 |
| `as_of`、`snapshot_id` | 固化查询邻域的时刻与快照 |
| `leakage`、`pack_timing` | 按运行器的防泄漏规则填写 |
| `created_at` | 生成时间 |

`scenario` 段只用于场景本身：

| 字段 | 含义 |
|---|---|
| `summary` | 场景说明 |
| `expected_alerts` | 注入后一定会出现的告警（`scenario.sh verify` 等待它们出现） |
| `silent_root` | 根因上没有任何告警，需要探测卡发现 |
| `distractors` | 干扰项：同时发生但与故障无关的变更或异常，不能成为 top-1 |
| `background_noise` | 所有场景期间都存在的背景噪声，见 `_background.yaml` |
| `window` | 评测时间窗相对 `injected_at` 的范围 |

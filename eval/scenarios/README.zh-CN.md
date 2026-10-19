# Kind 级联故障场景的标准答案

每个文件对应 `deploy/kind/scenarios/<id>/` 中的一个场景（DESIGN §14.1 的 `scenario` 用例）。注入、校验与恢复由 `deploy/kind/scenario.sh` 执行，注入与恢复时间写入 `$SCENARIO_STATE_DIR/<id>.json`（字段 `injected_at`、`verified_at`、`recovered_at`、`cluster`），评测按它截取时间窗。

场景由维护者编写，存在作者偏差，成绩单独报告（DESIGN §14.3）。

## 字段

| 字段 | 含义 |
|---|---|
| `id` | 场景名，与 `deploy/kind/scenarios/<id>/` 相同 |
| `kind` | 固定为 `scenario` |
| `cluster_id` | Kind 安装中 SreNautix 的 `clusterId`（`kind`） |
| `summary` | 场景说明 |
| `expected_alerts` | 注入后一定会出现的告警（`scenario.sh verify` 等待它们出现） |
| `truth.root_components` | 根因集合（ComponentKey）；top-1 落在集合内即为命中 |
| `truth.granularity` | 根因粒度：`pod`、`workload`、`component`、`node` |
| `truth.mechanism` | 机制，自由文本，用于人工比对 |
| `truth.disposition` | 期望的处置判断：`act`、`ignore`、`escalate`、`undetermined` |
| `truth.silent_root` | 根因上没有任何告警（需要探测卡发现） |
| `distractors` | 干扰项：同时发生但与故障无关的变更或异常，不能成为 top-1 |
| `background_noise` | 所有场景期间都存在的背景噪声 |
| `window` | 评测时间窗相对 `injected_at` 的范围 |

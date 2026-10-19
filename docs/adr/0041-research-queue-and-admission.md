# 0041 阶段 B 的队列与准入由 server 持有

## 背景

DESIGN §7.5 要求阶段 B 的队列使用 `FOR UPDATE SKIP LOCKED`、任务租约为阶段超时的 2 倍、默认 4 个槽位并保留 1 个给 critical，并在入队时执行"每个事件每 6 小时最多 3 次模型研判"的绝对上限、风暴模式与预算截停。§2.1 又要求 worker 对 server 的 schema 没有任何权限。

## 决定

1. 队列表 `server.research_queue` 在 server 的 schema 中，唯一键为 `(incident_id, incident_version, reason)`。
2. **入队（准入）在 server**，按顺序判断：
   - 严重度不是 critical/warning、事件被抑制或已合并：不研判；
   - 同一触发已存在：返回已有的 run_id；
   - 人工请求以外：当日预算 ≥100% 时只放行 critical，≥80% 时 warning 只出阶段 A；风暴模式下只有排名前 N 的根因入队；
   - 6 小时内已认领或完成的研判达到上限：只出阶段 A；
   - 同一事件排队中的旧触发被新触发取代（superseded），以最新一次为准。
   被拒绝的触发也记一行（`state=skipped` 与原因），消息据此标注"只出确定性报告"。
3. **认领经 API**：`POST /v1/research/claim` 由 server 代 worker 执行 `SKIP LOCKED`，按严重度 → 吸收的症状数 → 新事件优先 → 等待时长排序；非 critical 任务不能占用保留槽位。续租与结束分别是 `heartbeat` 与 `finish`；租约过期的任务回到队列，同一任务最多恢复 2 次。
4. worker 通过 `POST /v1/research/budget` 上报当日用量比例，server 用它做截停。
5. 风暴判定只数首次触发也在窗口内的新事件，中心恢复后补推的积压不计入。

## 结果

- 准入规则与队列状态只有一个写入方，worker 可以水平扩容而不需要 server schema 的权限。
- 认领多一次 HTTP 往返；与研判本身的分钟级耗时相比可以忽略。

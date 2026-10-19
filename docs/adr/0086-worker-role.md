# 0086 worker 角色：认领、状态与事件流

## 背景

DESIGN §1.1 与 §2.1 规定 worker 是唯一持有模型密钥的角色，拥有 `research_runs`、`hypotheses`、`llm_calls`、`tool_calls`、`evidence_snapshots`、`research_manifests` 与自己的 outbox，对 server 的 schema 没有任何权限；队列与准入由 server 持有（ADR 0041）。

## 决定

1. **认领**：worker 用自己的服务 token 长轮询 `POST /v1/research/claim`，每次处理一个任务（多副本横向扩展）；研判期间每 60 秒续租，续租返回 409（租约丢失）时中止；结束后调用 `finish`。研判输入来自 `GET /v1/research/tasks/{run_id}/context`：事件、成员告警、阶段 A 报告、两跳拓扑邻域、反馈与动作目录。动作只保留目标类型出现在研判子图中的。
2. **worker schema**（迁移轨道 `research`）：`research_runs`（状态、停止原因、输出、错误、预算、各步骤起止时间）、`evidence_snapshots`（区分性检查产生的卡，阶段 A 的卡由 server 保存）、`llm_calls`（只保存脱敏后的请求与输出）、`tool_calls`、`research_manifests`、`route_state`（方言档案、估算校准、服务方指纹）、`daily_usage`、`outbox`。假设账本随输出保存在 `research_runs.output`。同一任务因租约过期被重新认领时，从头开始并清除上一次尝试的调用记录。
3. **结果发布**：结束研判时，状态、检查卡、研判清单、当日用量与 outbox 事件（`research.concluded` 或 `research.failed`）在同一个事务里写入。worker 在 8080 提供 `GET /v1/events`（游标 `worker:<seq>`）与 `/v1/runs/{id}`、`/v1/runs/{id}/manifest`，调用方只有 server（inbound token 的 sha256 挂载在 `inbound.token_sha256_file`）；server 消费事件并按原 `event_id` 重新发布到自己的 outbox，控制台与渠道只读 server。
4. **提议中转**：研判产出的提议经 `POST /v1/proposals` 提交，幂等键为 `sha256(incident_id, run_id, action, 规范化参数)`，绑定事件版本、根因与证据指纹；被拒绝时原因写入 `validation_notes`，被接受时把 `proposal_id` 填回输出。
5. **失败隔离**：一个任务内的任何错误只影响这一个研判：记为 failed 并发布 `research.failed`（kind 为契约枚举之一），阶段 A 的消息依然有效。预算截停、故障域与蜜标停止记为 `stage_a_only`。
6. **启动**：执行扩展迁移；按配置探测各路由能力；全部路由都在被管拓扑内时置状态条件。停止时不再认领新任务，等待进行中的研判结束。

## 结果

- 端到端测试用真实 PostgreSQL（server 与 worker 各用自己的库角色，并检查互相没有对方 schema 的权限）、真实 HTTP 与本地 llama.cpp 录制的模型响应，走完 webhook → 阶段 A → 入队 → 认领 → 研判 → 事件 → server 镜像的全过程，并按契约校验研判输出与研判清单。
- 研判清单的 `pack_lock` 在中心提供领域包锁之前，使用动作目录与 runbook 列表的规范 JSON 摘要。

# 0021 中心与 gateway 之间的工单协议

## 背景

多集群安装时，中心不持有任何成员集群的凭证，分支只向中心发起出站连接（DESIGN §1.1）。gateway 需要取得已批准的工单、在执行前复核提议的绑定、把执行进度推回中心，并在中心不可用时继续完成已开始的执行（DESIGN §15.1）。网络会断开、请求会重试、gateway 会重启，同一个工单可能被下发不止一次。

## 决定

1. **接口**（`contract/gateway/v1/openapi.yaml`，由中心提供，gateway 调用）：

   | 接口 | 用途 |
   |---|---|
   | `GET /v1/spoke/tickets?wait=&max=` | 长轮询拉取本集群已批准、尚未被确认拉取的工单；没有工单时最长等待 `wait` 秒 |
   | `POST /v1/spoke/events` | 推送执行事件，一次最多 500 条 |
   | `GET /v1/spoke/proposals/{id}/binding` | 执行前复核提议当前的事件版本、根因与证据指纹 |
   | `POST /v1/spoke/heartbeat` | 上报状态条件、冲突域排队、时钟偏差，以及是否处于"仅提议" |

   每个响应都带中心时间 `server_time` 与恢复标记 `restored_at`。
2. **鉴权**：每个分支一个 bearer token（挂载文件，每次请求重新读取，以便轮换）。请求头 `X-SreNautix-Cluster` 必须等于 token 对应的集群。客户端不跟随重定向。
3. **工单**：`{ticket_id, cluster, proposal, envelope, delivered_at}`。`proposal.params` 与 `envelope` 保留原文，gateway 按原文计算 `params_hash` 与断言哈希。
4. **幂等**：
   - gateway 用确定性的 `execution_id`（ADR 0020）作为 `ActionExecution` 的名称。重复下发的工单在创建时遇到同名对象，不会产生第二次执行。
   - 中心收到某工单 `phase=pulled` 的事件后不再下发它。
   - 事件的 `event_id` 取 `sha256("srenautix-event-v1\n" + execution_id + "\n" + seq)` 十六进制的前 32 位，中心按它去重；同一执行的事件按 `seq` 排序。
5. **事件来源**：每次阶段迁移都追加到 `ActionExecution.status.history`（带 `seq`），并写入执行审计链。推送器把 `seq` 大于 `status.pushedSeq` 的记录推给中心，中心确认后更新 `pushedSeq`。中心不可用时事件留在 CRD 中，恢复后补推。
6. **执行前复核**：gateway 在执行前调用 binding 接口。`state` 不是 `current`，或三个绑定字段与断言不一致，执行进入 `stale`。中心不可用时，排队中的工单留在 `pulled`，直到中心恢复或审批过期；已经开始的执行不受影响。
7. **仅提议**：准入自检失败、熔断开关处于冻结、审计汇不可用、时钟偏差超过 5 秒、apiserver 返回 429 时，gateway 不再拉取新工单，在心跳中上报 `propose_only=true` 与对应的状态条件；中心在所有页面上显示该集群"仅提议"，并让对它的执行请求返回 409。已拉取但未开始的工单进入 `rejected`，原因码 `propose_only`。
8. **恢复标记**：gateway 记住各响应中最新的 `restored_at`，拒绝 `issued_at` 不晚于它的断言（DESIGN §15.3 第 5 步）。

## 结果

- 中心与分支之间只有出站的 HTTPS，分支不开放任何入站端口。
- 重复下发、重复推送、gateway 重启都不会产生第二次写入；中心看到的执行进度最终与集群中的 `ActionExecution` 一致。
- 软暂停由中心扣住工单实现；硬停止只能修改 `srenautix-freeze`，不依赖本协议。

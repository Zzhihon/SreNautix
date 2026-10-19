# 0031 reader 与中心之间的协议

## 背景

多集群安装时，中心不持有成员集群的凭证，分支只发起出站连接（DESIGN §1.1）。reader 需要把拓扑事件推给中心（§4.1）、每 60 秒提供告警对账数据（§3.1）、替中心执行声明过的证据查询与历史重建（§6.1、§14.5），并提供 apiserver 时间作为 PG 不可用时的时间参考（§3.1）。网络会断开，中心会重启或从备份恢复，reader 也会重启，进程内的事件序号随之从头开始。

## 决定

1. **接口**（`contract/gateway/v1/reader.openapi.yaml`，由中心提供，reader 调用；鉴权、`X-SreNautix-Cluster` 请求头与工单协议 ADR 0021 相同，客户端复用 `internal/spoke/tunnel`）：

   | 接口 | 用途 |
   |---|---|
   | `POST /v1/spoke/reader/hello` | 建立会话，取回中心已连续接受的拓扑序号 `topology_seq` |
   | `PUT /v1/spoke/reader/topology/snapshot` | 分段上传完整拓扑快照，全部分段到齐后中心一次应用 |
   | `POST /v1/spoke/reader/topology/events` | 推送增量拓扑事件，一次最多 1000 条 |
   | `POST /v1/spoke/reader/alerts` | 推送告警对账快照 |
   | `GET /v1/spoke/reader/requests` | 长轮询领取读取请求（声明式查询、历史重建、实体解析） |
   | `POST /v1/spoke/reader/results` | 回传读取结果 |
   | `POST /v1/spoke/reader/heartbeat` | 上报状态条件、apiserver 时钟参考、拓扑序号、查询模板清单 |

2. **每次连接都以快照开始**：reader 先调用 `hello`，把本地序号下限提高到中心返回的 `topology_seq`，然后上传完整快照（快照序号不小于 `topology_seq`），再推送序号更大的事件。这样 reader 重启、中心重启、断线期间丢失的变化，都由快照补齐，中心不需要保存每个 reader 进程的历史。
3. **序号连续**：中心只接受 `topology_seq + 1` 开始的事件；出现缺口返回 409 `topology_seq_gap`，中心状态被重置时返回 409 `resync_required`，reader 收到后重新上传快照。序号不大于 `topology_seq` 的事件已被快照或之前的推送覆盖，中心忽略它们；事件按 `event_id` 去重。中心应用后响应丢失时，reader 重试同一批，不会产生第二次变更。
4. **缓冲有上限**：等待推送的事件超过 20 万条时，reader 丢弃缓冲并在下一次推送前重新上传快照。断线时间再长，内存也有上限。
5. **断线检测**：拓扑同步、心跳、请求领取任一失败，都结束当前会话，按 5 秒退避重新连接；重新连接后以快照开始。`TunnelConnected` 条件与 `srenautix_reader_tunnel_connected` 指标反映会话状态。中心不可达时 reader 保持就绪（`/readyz` 只看 informer 新鲜度），继续维护本地拓扑。
6. **读取请求**：中心只下发模板 ID、内容哈希和参数（ADR 0032）。每个请求带截止时间，过期的请求不再执行；结果按 `request_id` 去重，reader 重试回传直到中心确认，中心返回 4xx 时放弃并记录日志。同时执行的请求数有上限（默认 16）。
7. **告警对账**：每 60 秒读取本集群 Alertmanager v2 的 `GET /api/v2/alerts`（包含静默、抑制和未处理的告警）与本地指标后端的 `ALERTS`、`ALERTS_FOR_STATE`，原样转发。某一部分读取失败或条目被截断时，该部分标为 `error` 或 `truncated=true`，中心不据此判断告警已经消失。
8. **apiserver 时钟参考**：reader 在约 1.1 秒内向 apiserver 的 `/version` 发出 9 次请求，每次得到一个 HTTP `Date`（精度 1 秒）。一次请求在本地时间 `[t0, t1]` 内完成、`Date` 为 D，说明偏移量（apiserver − 本地）落在 `[D − t1, D + 1s − t0]`；各样本的区间取交集，误差约为采样间隔（125 毫秒）加往返时延。心跳带上 `apiserver_time`、偏移量与误差；中心在 PG 不可用时用 `apiserver_time` 加上收到心跳后经过的单调时长作为当前时间。偏差超过 2 秒时 `ClockSkew` 条件为 False，并导出 `srenautix_clock_skew_seconds{peer="apiserver"}`（DESIGN §15.5）。

## 结果

- 分支只有出站 HTTPS，不开放入站端口；reader 与 gateway 共用同一个 token 与客户端。
- 中心看到的拓扑最终与 reader 本地一致：进程内测试中心（`internal/spoke/reader/hub/hubtest`）按契约校验每个请求与响应，端到端测试覆盖首次快照、增量事件、响应丢失后的重试、中心不可达、中心状态重置。
- 每次重连都上传一次快照，大集群（数万节点与边）重连的流量与快照大小成正比，按 5000 条一段分段上传。

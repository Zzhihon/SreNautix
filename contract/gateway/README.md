# contract/gateway

中心与分支 gateway 之间、以及 gateway 自身配置的契约（Apache-2.0）。全部文件与语言无关；Go 侧经 `embed.go` 嵌入，TypeScript 侧直接读取。

| 文件 | 内容 |
|---|---|
| `v1/approval-assertion.schema.json` | 审批断言 v1 的 15 个字段（DESIGN §9.2） |
| `v1/approval-envelope.schema.json` | 断言加签名证明：服务签名 `service_ed25519`（H 档带重新认证凭据）或通行密钥签名 `webauthn_ed25519` |
| `v1/approver-keys.schema.json` | gateway 信任的服务签名公钥与审批人通行密钥公钥 |
| `v1/action-catalog.schema.json`、`v1/action-catalog.yaml` | 动作目录：等级、档位、目标、参数、冲突域、预检、校验、撤销、爆炸半径、写入 |
| `v1/gateway-policy.schema.json` | gateway 策略：启用的动作与命名空间、自动执行、自身依赖、审批人作用域、工作流模板白名单、GitOps 仓库白名单 |
| `v1/openapi.yaml` | 工单协议：长轮询拉取工单、推送执行事件、复核绑定、心跳 |
| `v1/reader.openapi.yaml` | reader 协议：会话、拓扑快照与事件、告警对账快照、长轮询领取读取请求并回传结果、心跳 |
| `v1/crd/srenautix.io_actionexecutions.yaml` | `ActionExecution` CRD（执行状态与阶段） |
| `v1/audit-record.schema.json` | 执行审计链的一行记录 |
| `v1/testvectors/approval-vectors.json` | 规范化、哈希、签名与每个校验原因码的黄金向量，Go 与 TS 必须给出相同结果 |

规范化、签名输入与校验顺序见 [ADR 0020](../../docs/adr/0020-approval-assertion-format.md)，工单协议见 [ADR 0021](../../docs/adr/0021-ticket-protocol.md)，`ActionExecution` 的状态见 [ADR 0022](../../docs/adr/0022-action-execution-state.md)。

重新生成测试向量：`go run ./hack/gen-gateway-vectors`；`make go-test` 会检查生成结果与仓库一致。

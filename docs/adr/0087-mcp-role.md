# 0087 mcp 角色：只能提议的对外 MCP 服务

## 背景

DESIGN §9.3 与 §16.4：MCP 服务默认关闭、只在集群内可达；作为 OAuth 2.1 资源服务器，令牌按受众绑定（RFC 8707），不透传，校验 Origin；外部调用方只能提议，不能审批或修改策略；每个调用方有独立的速率限制与成本配额，行为异常的调用方被熔断；输出中的日志、告警、事件文本放在 `untrusted_text` 字段；工具描述带版本号并且固定。

## 决定

1. **默认关闭**：mcp 角色的配置必须写 `enabled: true` 才能启动；Helm 默认不部署。它没有数据库，没有审批能力。
2. **令牌**：只接受授权服务器签发的 JWT 访问令牌（`typ: at+jwt`），按发行方元数据（RFC 8414，失败时 OpenID Connect Discovery）中的 JWKS 验签，`iss` 必须是配置的授权服务器，`aud` 必须等于本服务的资源标识，`client_id` 必须是登记的客户端。没有令牌或令牌无效时返回 401 与 `WWW-Authenticate: Bearer resource_metadata="…"`，受保护资源元数据（RFC 9728）列出授权服务器与作用域 `srenautix:read`、`srenautix:propose`。浏览器请求的 Origin 必须在允许列表中。
3. **不透传**：每个 OAuth 客户端映射到中心登记的一个外部调用方（`kind: external, channel: mcp`），本服务用该调用方自己的服务 token 调用中心 API；访问令牌从不离开本服务。中心按该调用方的动作 × 命名空间授权，并执行提议中转的全部校验（目录、参数 schema、目标、绑定）。
4. **工具**（名称带版本后缀 `_v1`，描述固定）：`list_incidents_v1`、`get_incident_v1`、`list_actions_v1` 需要 `srenautix:read`；`propose_action_v1` 需要 `srenautix:propose`，提议绑定事件的当前版本、根因与证据指纹，幂等键为 `sha256(client_id, incident_id, action, 规范化参数)`。没有审批、拒绝、撤销、反馈或策略类工具。
5. **不可信文本**：工具结果中的文本字段（摘要、描述、时间线文字、理由、日志行、标签与注解的值等）移入 `untrusted_text`（带 JSON Pointer），原位置替换为 `{"untrusted_ref": n}`。
6. **配额与熔断**：每个客户端的读取与提议各有令牌桶（`reads_per_minute`、`proposals_per_hour`）；10 分钟内被中心拒绝（策略检查不通过或 HTTP 4xx）达到阈值的客户端熔断 30 分钟。调用按工具与结果计数（`srenautix_mcp_tool_calls_total`）。

## 结果

- 集成测试用真实的 OAuth 授权服务器（node-oidc-provider，client_credentials 加 Resource Indicators，ES256 JWT 访问令牌）、真实的 server 与 PostgreSQL、MCP SDK 客户端，覆盖：无令牌 401 与元数据、签给其他资源的令牌、未登记客户端、Origin、工具清单只有读取与提议、只读作用域不能提议、提议进入审批与去重、中心按命名空间拒绝、限速与熔断。
- MCP 调用的治理审计由中心记录外部调用方的请求；本服务只输出结构化日志。

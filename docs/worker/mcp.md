# mcp 角色

对外的 MCP 服务，让其他 Agent（例如 HolmesGPT、kagent，或用户自己的 Agent）读取事件并通过 SreNautix 的审批与执行链路提议修复动作。默认关闭，只在集群内可达。取舍见 ADR 0087。

## 启动

```
node apps/srenautix/dist/main.js --role=mcp --config=/etc/srenautix/mcp.yaml
```

```yaml
enabled: true
log_level: info
listen: { api: ":8080", metrics: ":9090" }
public_url: http://srenautix-mcp.srenautix.svc:8080/mcp      # 资源标识：访问令牌的 aud 必须等于它
authorization_server: https://idp.example.com             # 发行方（issuer），需要支持 RFC 8707 与 JWT 访问令牌
allowed_origins: []                                       # 浏览器发起的请求的 Origin 白名单
hub_url: http://srenautix-server:8080
clients:
  - client_id: holmes
    hub_token_file: /etc/srenautix/secrets/mcp/holmes     # server 调用方文件中对应条目的 token 原文
    reads_per_minute: 60
    proposals_per_hour: 20
    rejection_threshold: 5                                # 10 分钟内被拒绝这么多次后熔断 30 分钟
```

server 的调用方文件中为每个客户端登记一条外部调用方，限定动作与命名空间：

```yaml
callers:
  - id: holmes
    kind: external
    channel: mcp
    actions: [workload_scale, rollout_pause]
    namespaces: [shop]
    proposals_per_hour: 20
    token_sha256: <hub_token 的 sha256>
```

## 授权

1. Agent 访问 `public_url` 得到 401 与 `WWW-Authenticate: Bearer resource_metadata="<public_url 对应的 /.well-known/oauth-protected-resource/…>"`。
2. 读取受保护资源元数据，向其中的授权服务器申请访问令牌，`resource` 参数为 `public_url`，作用域 `srenautix:read` 或 `srenautix:read srenautix:propose`。
3. 带 `Authorization: Bearer <令牌>` 调用 MCP（Streamable HTTP，无会话）。

## 工具

| 工具 | 作用域 | 内容 |
|---|---|---|
| `list_incidents_v1` | `srenautix:read` | 事件摘要 |
| `get_incident_v1` | `srenautix:read` | 事件、阶段 A 报告、研判列表 |
| `list_actions_v1` | `srenautix:read` | 动作目录与启用状态 |
| `propose_action_v1` | `srenautix:propose` | 为事件提议一个目录中的动作；进入审批流程，不能审批 |

结果的 `structuredContent` 为 `{data, untrusted_text}`：文本字段移入 `untrusted_text`（`ref`、`path`、`text`），`data` 中原位置为 `{"untrusted_ref": n}`。工具名的版本后缀在描述或参数变化时递增，旧版本工具在一个版本周期内保留。

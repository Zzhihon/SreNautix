# 0092 集成清单与一致性测试

## 背景

DESIGN §10 要求每个集成有清单，能力声明加 `verify()` 通过才算可用，按方向分级，并且所有适配器遵守回放时钟窗口。集成数量会持续增长，等级、验证方式与密钥处理需要机器检查；模型路由的能力（严格 JSON Schema、原生工具、推理通道）因服务方而异，只能测量。

## 决定

1. **清单检查**：`loadIntegrationManifest` 在契约 schema 之外检查：`approve`、`authenticate` 只能是 `core`、`official`、`official_candidate`，`execute` 只能是 `core`；`official` 必须有部署报告；能力名属于实现的契约；日志集成必须实现 `logs.match`；`core` 的自托管后端以 `kind_e2e` 或 `testcontainers` 验证，SaaS 后端同时有 `recorded_fixtures` 与 `live_smoke`；密钥字段只能是标注 `x-srenautix-secret-ref` 的 `*_file` 引用。`integrations/` 下全部清单由测试加载。
2. **可用能力**：`availableCapabilities` 只把声明过且 `verify()` 通过的能力算作可用，其余给出原因，控制台的集成页由此生成。
3. **一致性测试**：每类契约一个套件（metrics、logs、traces、changes、approve、identity、model、clock），输出逐项检查的报告。读取类套件在 CI 中对真实后端进程运行：Prometheus、VictoriaMetrics、Loki、Tempo 的上游二进制，版本与 sha256 固定在 `backends.json`；变更套件对真实的 git 仓库运行。
4. **审批渠道**：approve 套件检查签名测试向量、来源校验、过期回调、重放、未绑定账号、编辑幂等。来源校验按渠道声明的 `authenticity` 进行：`body_signature`（飞书）要求篡改过请求体的回调被拒绝；`transport_secret`（Telegram webhook 只有 `X-Telegram-Bot-Api-Secret-Token` 头，请求体没有签名）要求共享密钥错误的回调被拒绝。套件由渠道实现方（server）在自己的集成测试中用真实的状态库运行。签名测试向量用 openssl 与 shasum 生成，放在 `integrations/<id>/fixtures/`。
5. **模型方言**：model 套件用 OpenAI 官方 SDK 对路由发请求，测得的结果写成 `DialectProfile`；能力不可用是测量结果，不算失败。CI 用 llama.cpp 的 `llama-server` 加载 Qwen2.5-0.5B-Instruct（GGUF，sha256 固定）测量 Chat Completions 与 Responses 两种方言。
6. **回放时钟窗口**：读取类适配器在发出请求之前检查时刻、区间与查询回看量（由官方解析器算出，含 offset 与子查询）都在事件时钟窗口内，越界时抛 `ClockWindowViolation`，不发请求；clock 套件对每个读取适配器检查这一点。

## 结果

- 等级与验证方式的约束由测试强制，新集成提交时就会暴露不合规的清单。
- 真实后端让一致性测试能发现版本差异；CI 需要缓存后端二进制。
- llama.cpp 与 vLLM、云服务方的实现不同，CI 的方言测量只证明套件与客户端正确，部署时由启动探测在真实路由上重新测量。

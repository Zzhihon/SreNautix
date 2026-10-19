# 集成

每个集成在 `integrations/<id>/` 下有一份 `integration.yaml`，录制夹具放在同目录的 `fixtures/`。SDK 在 `packages/integration-sdk`（Apache-2.0），提供清单校验、适配器、`verify()` 探测、一致性测试套件和测试用的真实后端。

## 清单

结构见 `contract/schemas/integration-manifest.schema.json`：

```yaml
api_version: srenautix.io/integration/v1
id: loki
display_name: Grafana Loki
category: logs
direction: read
tier: core
contract: logs/v1
capabilities:
  - { name: logs.match, stability: stable }
  - { name: logs.query, stability: stable }
tested_versions:
  - { backend: loki, versions: ['3.7.8'], verification: testcontainers }
  - { backend: loki-chart, versions: ['7.3.0'], verification: kind_e2e }
config_schema:
  type: object
  required: [url, labels]
  properties:
    url: { type: string, format: uri }
    bearer_token_file: { type: string, x-srenautix-secret-ref: true }
required_scopes:
  - loki:GET /loki/api/v1/query_range
owner: srenautix-maintainers
```

`loadIntegrationManifest` 按契约校验之后，再检查以下规则，任何一条不满足都拒绝加载：

| 规则 | 说明 |
|---|---|
| 按方向分级 | `approve`、`authenticate` 只能是 `core`、`official` 或 `official_candidate`；`execute` 只能是 `core` |
| 官方级 | `official` 至少有一份 `deployment_reports`；没有报告时写成 `official_candidate`，不称为"支持" |
| 能力属于契约 | 能力名的前缀必须是契约类别，例如 `metrics/v1` 只能声明 `metrics.*`，`approve/v1` 可以声明 `approve.*` 与 `notify.*` |
| 日志 | 实现 `logs/v1` 的集成必须声明 `logs.match` |
| 版本矩阵 | 至少一项；`core` 的自托管后端以 `kind_e2e` 或 `testcontainers` 验证，SaaS 后端同时有 `recorded_fixtures` 与 `live_smoke` |
| 密钥 | 配置里的密钥字段只能是挂载文件的引用：名字以 `_file` 结尾、`string` 类型、标注 `x-srenautix-secret-ref: true`；名字像密钥（token、password、secret、private_key、api_key、credential、encrypt_key）的普通字符串字段被拒绝 |
| 目录名 | 目录名等于集成 id，id 不重复 |

一项能力只有在清单里声明过、并且 `verify()` 通过，才算可用：`availableCapabilities(manifest, verified)` 返回可用能力与每项不可用能力的原因。`verifyMetrics`、`verifyLogs`、`verifyTraces` 对真实数据源逐项探测。

## 验证方式

| `verification` | 含义 |
|---|---|
| `kind_e2e` | 在 Kind 环境（`deploy/kind`）中端到端运行 |
| `testcontainers` | 一致性测试启动真实后端进程：上游发布的二进制，版本与 sha256 固定在 `packages/integration-sdk/backends.json`，下载到 `.scratch/backends`（或 `SRENAUTIX_BACKENDS_DIR`） |
| `recorded_fixtures` | 每个 PR 用 `fixtures/` 下录制的真实响应与签名测试向量运行 |
| `live_smoke` | 每周在真实账号上冒烟 |

徽章上注明验证方式。夜间一致性测试连续 14 天失败，或者一个版本周期内没有 owner 的集成降级。

`backends.json` 当前固定的后端：Prometheus 3.15.0、VictoriaMetrics 1.154.0、Loki 3.7.8、Tempo 3.1.0、Helm 3.19.0、llama.cpp b11742（加载 Qwen2.5-0.5B-Instruct Q4_K_M）、cosign 3.1.3、oras 1.3.5、zot 2.1.22。

## 一致性测试套件

每个套件返回 `ConformanceReport{kind, subject, checks[], passed}`，每项检查独立记录通过或失败的原因。

| 套件 | 被测对象 | 检查 |
|---|---|---|
| `runMetricsConformance` | `PrometheusApiAdapter` | 瞬时查询、rate、区间查询的步长与时间单位、序列数截断、series、标签值、空结果、语法错误在本地拒绝、后端错误映射为 `DatasourceError`；在 Prometheus 与 VictoriaMetrics 上各跑一遍 |
| `runLogsConformance` | `logs.match` 实现 | 子串匹配只在指定命名空间内且新的在前、RE2 正则、按 Pod 与容器过滤、行数上限与截断标记、时间窗口（含终点）、没有匹配时为空 |
| `runTracesConformance` | `TempoAdapter` | 按状态与属性搜索、按 trace id 读取完整链路（父子关系与状态）、条数上限 |
| `runChangesConformance` | `changes.list` 实现 | 契约形状与排序、窗口边界、`change_id` 唯一、按组件过滤、条数上限、空窗口、回放时钟窗口 |
| `runApproveConformance` | 渠道适配器 | 签名测试向量；未绑定账号被拒绝；篡改的回调在签名校验处被拒绝；过期回调被拒绝；审批成功后重放同一回调被拒绝；同一内容编辑两次是幂等的 |
| `runIdentityConformance` | 身份集成 | 认证结果符合契约；同一用户两次登录得到同一主体 id，不同用户不同；组映射；重新认证更新 `auth_time` |
| `runModelConformance` | 模型路由 | 方言档案：基本调用与 usage、严格 JSON Schema、原生工具调用、推理通道、中文、上下文长度；结果写成 `DialectProfile` |
| `runClockConformance` | 任意读取适配器 | 回放时钟窗口：窗口之外的时刻、区间与回看都被拒绝（`ClockWindowViolation`） |

**回放时钟窗口**：回放与评测时，适配器只能读取事件时钟窗口内的数据。`assertInstantInClock`、`assertWindowInClock`、`assertLookbackInClock` 在发出请求之前检查，回看窗口由官方解析器从查询中算出（含 offset 与子查询）。所有读取适配器都要通过 `runClockConformance`。

**模型方言**：`runModelConformance` 用 OpenAI 官方 SDK 发请求，测量结果是档案的内容，某项能力不可用不算失败；只有请求格式错误或响应无法解析才失败。CI 用 llama.cpp 加载 Qwen2.5-0.5B 测量 Chat Completions 与 Responses 两种方言。

**审批渠道**：`runApproveConformance` 由渠道实现方在自己的集成测试中用真实的状态库运行。飞书的签名测试向量在 `integrations/feishu/fixtures/signature-vectors.json`，用 openssl 与 shasum 生成，不经过 SreNautix 的代码。

## 集成清单

**核心级**

| 类别 | 集成 |
|---|---|
| 告警 | `alertmanager`、`generic-webhook` |
| 指标 | `prometheus-api`（Prometheus 与 VictoriaMetrics） |
| 日志与链路 | `loki`、`tempo` |
| 变更 | `kubernetes`（发布与事件）、`argocd`、`git` |
| 通知与审批 | `telegram`、`feishu`、`console` |
| 模型 | `openai-compatible-responses`、`openai-compatible-chat`、`deepseek`、`qwen-vllm` |
| 身份 | `oidc`、`local-admin` |

拓扑由 reader 内置的 informer 维护，不经过集成契约。执行器在动作目录（`contract/gateway/v1/action-catalog.yaml`）中定义。

**官方候选**

| 类别 | 集成 |
|---|---|
| 告警 | `grafana-alerting`、`nightingale` |
| 指标 | `mimir`、`thanos` |
| 日志与链路 | `victorialogs`、`elasticsearch`（含 OpenSearch）、`skywalking`、`jaeger` |
| 变更 | `flux`、`gitlab`、`jenkins` |
| 通知 | `dingtalk`、`wecom`、`slack`、`email`（只通知） |
| 身份 | `dex`（LDAP，以及飞书、钉钉、企业微信 SSO） |

## 新增集成

1. 在 `integrations/<id>/` 写 `integration.yaml`，能力名取自对应契约（`contract/integrations/<类别>/v1`）。
2. 实现适配器，读取类适配器在发请求前做回放时钟窗口检查。
3. 写 `verify()`：每项声明的能力一个探测，失败时给出原因。
4. 用对应的一致性测试套件对真实后端运行；后端二进制加入 `backends.json`（版本、下载地址、每个平台的 sha256）。
5. SaaS 后端录制真实响应放进 `fixtures/`，录制时去掉账号、令牌与内部地址。
6. `packages/integration-sdk/test/manifests.test.ts` 加载全部清单，新集成随之校验。

第三方代码只能经带类型的 MCP 配置档（读数据）或 HTTP 渠道桥（只通知）接入，永远不在 SreNautix 自己的进程里运行。

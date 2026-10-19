# 契约

`contract/` 是 SreNautix 各组件之间数据结构的唯一来源（Apache-2.0），版本见 `contract/VERSION`，版本规则见 [ADR 0010](../adr/0010-contract-versioning.md)。

| 文件 | 内容 |
|---|---|
| `openapi.yaml` | 中心 HTTP API：健康与状态条件、认证与会话、事件、阶段 A 报告、研判运行与清单、证据重跑（只限声明过的卡）、反馈、提议中转与审批断言签发、事件流（长轮询与 SSE）、评测成绩单 |
| `schemas/common.schema.json` | 共用定义：时间、集群、组件键、角色、处置判断、结论阶梯、证据结论、出境控制、渠道、证据引用 |
| `schemas/alert.schema.json` | 归一化的告警实例与角色分类 |
| `schemas/alert-catalog-entry.schema.json` | 告警目录条目 |
| `schemas/topology-event.schema.json` | 拓扑事件（`valid_from`/`valid_to`、边的来源、置信度、作用范围） |
| `schemas/incident.schema.json` | 事件、根因候选与得分项、成员、别名 |
| `schemas/evidence-card.schema.json`、`evidence-result.schema.json` | 证据卡定义与结果 |
| `schemas/stage-a-report.schema.json` | 阶段 A 报告 |
| `schemas/research-output.schema.json`、`research-manifest.schema.json` | 校验后的研判输出、研判清单与出境清单 |
| `schemas/feedback.schema.json` | 反馈 |
| `schemas/proposal.schema.json` | 提议 |
| `schemas/events.schema.json` | outbox 事件与事件类型 |
| `schemas/condition.schema.json` | 状态条件 |
| `schemas/pack.schema.json` | 领域包的各个文件、用户层与 `pack.lock` |
| `schemas/integration-manifest.schema.json` | 集成清单 |
| `schemas/eval-report.schema.json` | 评测成绩单 |
| `model/*.schema.json` | 阶段 B 模型直接输出的结构（可移植子集） |
| `integrations/<kind>/v1/` | alerts、metrics、logs、traces、changes、notify、approve、identity、model 的集成契约 |
| `gateway/` | 审批断言、工单、`ActionExecution`、动作目录（由 spoke 维护） |

## 使用

```ts
import { assertValid, type Incident } from '@srenautix/contract';

const incident = assertValid<Incident>('schemas/incident.schema.json', body);
```

- `validatorFor(ref)` 返回 Ajv 校验函数，`ref` 是相对 `contract/` 的路径，可带 `#/$defs/<名字>`。
- `createHubClient({ baseUrl })` 返回中心 API 的 openapi-fetch 客户端。

## 修改契约

1. 修改 `contract/` 下的文件，按 ADR 0010 更新 `contract/VERSION`。
2. 运行 `pnpm contract:gen`，提交生成结果。
3. `pnpm contract:check` 在 CI 中检查生成结果与仓库一致。
4. 通知依赖方（server、worker、控制台、spoke）。

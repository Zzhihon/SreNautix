# 0010 契约的版本与生成

## 背景

SreNautix 的 server、worker、控制台、Grafana 插件、Go 写的 spoke 与外部调用方都依赖同一组数据结构：事件、证据卡、研判输出、反馈、提议、事件流、领域包与集成。参考集群上的 Ops-Agent 契约 1.5.0 只覆盖了三个组件之间的 HTTP 接口，事件的身份还是 `<组件>:<时间>` 字符串键，反馈只有根因一个维度。

## 决定

1. **唯一来源**：`contract/` 下与语言无关的 JSON Schema（draft 2020-12）与 OpenAPI 3.1 是唯一来源，使用 Apache-2.0。TS 类型、内嵌 schema 与校验器由 `packages/contract` 生成；Go 侧（spoke）用同一批 schema 与黄金夹具。
2. **版本**：整个目录一个语义化版本号，写在 `contract/VERSION`，起始为 2.0.0。
   - 主版本：删除字段、收紧取值、改变字段含义。API 与事件兼容上一个主版本（DESIGN §19）。
   - 次版本：新增可选字段、新增枚举值、新增事件类型或接口。
   - 修订号：只改描述。
   - SreNautix 第一个正式版本发布之前，没有需要兼容的已部署版本：这期间不兼容的修改也只升次版本号，提交说明用 Conventional Commits 的 `!` 标出，并通知所有依赖方。
   - outbox 事件的 `schema_version` 取 `contract/VERSION`；集成契约在目录名里带自己的版本（`contract/integrations/<kind>/v1`），和整体版本号相互独立。
3. **`$id`**：每个文件的 `$id` 是 `https://srenautix.io/contract/<相对 contract/ 的路径>`，生成器校验这一点；跨文件一律用相对路径引用。
4. **2.0.0 相对 1.5.0 的变化**：
   - 事件主键改为 `incident_id`（UUID），原来的键保留为稳定标签 `label`，旧标签与被合并事件的 id 通过 `aliases` 解析；成员带 `joined_version`/`left_version`，所有键带 `cluster_id`。
   - 反馈保留 1.5.0 的 `verdict`、可为 null 的 `root_component`、`channel`，增加处置判断维度 `disposition_verdict`/`disposition`、`linked`（已绑定账号）与隐式反馈来源 `implicit`；`channel` 扩展到全部渠道。
   - 研判输出加入 `disposition`、由代码判定的结论阶梯 `conclusion.level` 与四项一致性检查、假设账本状态、带结果的 `next_checks`。证据引用改为运行内编号 `card:<n>`、`alert:<n>`、`change:<n>`，由研判清单映射到卡片定义与实体。
   - 模型直接输出的部分单独放在 `contract/model/`，遵守可移植 schema 子集（DESIGN §8.2），测试逐项检查；`x-srenautix-dynamic-enum` 标出每次运行时替换为动态枚举的字段。
   - 提议绑定 `{incident_version, root_component, evidence_fingerprint}` 并带幂等键；`level`、`tier`、`canon_version` 的取值与 `contract/gateway/v1/approval-assertion.schema.json` 一致。
5. **生成与检查**：`pnpm contract:gen` 用 json-schema-to-typescript 生成 `types.ts`，用 openapi-typescript 生成 `openapi.ts`，并把全部 schema 内嵌到 `schemas.ts`（运行时校验不依赖仓库目录）。`pnpm contract:check` 重新生成并与仓库比较，不一致时 CI 失败。
6. **授权分类**：OpenAPI 的每个操作都声明 `x-srenautix-roles` 与 `x-srenautix-external`；没有分类的操作、或外部调用方可以审批、拒绝、撤销、反馈的操作，都让 `packages/contract` 的测试失败（不变量 6）。

## 结果

- 所有组件按同一份 schema 读写，类型不一致在 CI 的生成检查和类型检查中暴露。
- 生成的 TS 类型中，带描述的 `$ref` 会生成编号后缀的同构类型（例如 `Timestamp1`），代码中使用无后缀的名字。

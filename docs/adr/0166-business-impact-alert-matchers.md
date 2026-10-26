# 0166 业务影响告警的统一匹配器

## 背景

"业务影响告警"在 server 里有两处配置，语义相近，写法和用途不同：

| 配置 | 写法 | 用途 |
|---|---|---|
| `notify.digest.external_roots.business_impact.alert_labels`（ADR 0150、0163） | 一个标签条件（标签名 → 取值之一，每个标签都要满足） | 外部上游汇总的业务影响与即时推送；处置推导中"业务影响告警在触发、证据卡异常时不给 ignore"，这一处另外在代码里要求 critical |
| `notify.business_impact_alerts`（ADR 0159） | 标签条件的列表，满足任一项即可，默认 `[{severity: [critical]}]` | 首条消息时延的 `business_impact` 标签 |

部署方的口径是"L0–L2 的 critical，排除 provider 组件"，并要求外部上游汇总的"波及业务"、处置推导的"不判 ignore"与首条消息时延都用这一个口径。两处写法都只能列出允许的取值，表达不了"排除某个标签值"：外部上游（provider）自己的告警也带 L1、L2 与 critical，按标签条件匹配时，provider 的 critical 告警会让它所在的上游事件"已影响业务"并即时推送，汇总失去作用。

## 决定

### 1. 一个配置：`notify.business_impact_alerts`

```yaml
notify:
  business_impact_alerts:
    - labels: { layer: [L0, L1, L2], severity: [critical] }
      exclude_labels: { component: [provider] }
```

- 每项是一个匹配器：`labels` 的每个标签都取列出的值之一，并且 `exclude_labels` 中任何一个标签都不取列出的值。告警满足任一项即为业务影响告警。
- 只看告警的标签。严重度也按 `severity` 标签写进 `labels`，代码里不再另外要求 critical：口径的全部条件都在配置里，三处用途看到的是同一组告警。
- `labels` 至少一个标签；`exclude_labels` 默认为空。
- 不配置时没有业务影响告警（默认 `[]`）：外部上游汇总与处置推导的行为与之前不配置 `alert_labels` 时相同，首条消息时延的 `business_impact` 都是 `false`。

使用它的地方（`apps/srenautix/src/alerts/business-impact.ts` 的 `isBusinessImpact`）：

1. 外部上游汇总的业务告警与"上游故障已影响业务"（`notify/external.ts`）。状态库先按每项 `labels` 的键预先筛选（`labels ?& keys`，任一项），取值与排除在内存里判断。汇总消息"业务影响：无"后面写的条件是匹配器的文字形式，例如 `layer=L0|L1|L2,severity=critical,component!=provider`。
2. 处置推导：阶段 A 与阶段 B 的"有触发中的业务影响告警、并且有异常卡时不给 ignore"（ADR 0163），处置依据的 `business_impact`（契约 2.36.0 起描述为"满足 notify.business_impact_alerts 的触发中告警"）。
3. 计划内退役判为 ignore 的前提（ADR 0167）。
4. 首条消息时延的 `business_impact` 标签（ADR 0159、0165）。

重建评测用同样写法的 `reconstruct.business_impact_alerts`。

### 2. 旧写法保留一个版本

server 与评测配置在解析之前转换旧写法，每一处转换在日志里记一条警告（`server 配置使用了弃用的写法`），下一个版本不再接受：

| 旧写法 | 转换为 |
|---|---|
| 只给出 `notify.digest.external_roots.business_impact.alert_labels: X`（非空） | `notify.business_impact_alerts: [{labels: X}]` |
| `alert_labels` 与 `notify.business_impact_alerts` 都给出 | 旧键不生效 |
| `notify.business_impact_alerts` 中标签条件本身的项 `{severity: [critical]}` | `{labels: {severity: [critical]}}` |
| 评测配置的 `reconstruct.business_impact_labels` | `reconstruct.business_impact_alerts`，规则同上 |

转换后的匹配器不再隐含 critical：旧的 `alert_labels` 在处置推导里另外要求 critical，在外部上游汇总里不要求，两处原本就不一致，转换取汇总的语义。部署方的 `alert_labels` 里已经写了 `severity: [critical]` 时，结果与之前相同；没有写时，处置推导会把 warning 也算作业务影响告警，警告里写明需要时在 `labels` 里加上 `severity`。

`alert_labels` 在转换之后从配置里去掉，代码只读 `notify.business_impact_alerts`。chart 的 `notifyDigest.externalRoots.businessImpact.alertLabels` 仍然渲染这个键，默认为空，空的旧键不转换、不警告。

## 不采用的做法

- **标签名前加 `!` 表示排除**（`{"!component": [provider]}`）：把规则写进键名，标签名本身含 `!` 时有歧义；匹配器分开写 `labels` 与 `exclude_labels`，校验与文字形式都直接。
- **两处配置各自加排除写法**：语义已经是同一个口径，分开写只会让两处再次不一致。

## 结果

- 实现：`apps/srenautix/src/alerts/business-impact.ts`（匹配器、文字形式、旧写法转换）、`config/server.ts`（`upgradeRaw` 返回弃用说明，`parseServerConfig` 记录警告）、`notify/{external,source}.ts`、`stage-a/{report,service}.ts`、`remediation/facts.ts`、`api/routes-research.ts`、`eval/{config,reconstruct,phase2}.ts`、`roles/server.ts`；契约 2.36.0 的 `eval-snapshot.schema.json` 中 `DispositionFacts.business_impact` 的说明。
- 测试：
  - `test/unit/business-impact-matchers.test.ts`：L0–L2 critical 排除 provider 的匹配；多个排除标签任一命中即排除；任一项满足；文字形式；默认为空；三种旧写法的转换与弃用说明；空的旧键不警告；`labels` 为空与未知键不合法；评测配置的转换；
  - `test/unit/business-impact-disposition.test.ts`：阶段 A、阶段 B 的业务影响约束按匹配器判定，严重度写在 `labels` 里，被排除的告警不算；
  - `test/integration/notify-external-digest.test.ts`（真实 PostgreSQL）：provider 组件的 L1 critical 告警在上游事件开始后开始，不即时推送，汇总写明"无"与条件；
  - `test/integration/notify-first-message.test.ts`：provider 组件的 L2 critical 事件 `business_impact="false"`。

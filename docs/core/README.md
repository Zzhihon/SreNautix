# packages/core

SreNautix 的确定性核心（AGPL-3.0-or-later），纯 TypeScript，不依赖框架与网络，server 的接入、阶段 A 与回放共用。设计取舍见 [ADR 0011](../adr/0011-topology-component-model.md) 与 [ADR 0012](../adr/0012-convergence-and-root-ranking.md)。

## 模块

| 模块 | 入口 | 作用 |
|---|---|---|
| 告警目录与分类 | `AlertCatalog`、`classifyAlert`、`classifyExpression` | 按标签契约、目录条目、规则表达式确定角色；forecast 一律按表达式中的 `predict_linear` 判断 |
| 接入归一化 | `normalizeAlert`、`normalizeWebhook`、`labelsFingerprint` | Alertmanager webhook 与 API v2 的告警 → 契约中的 `Alert`；丢弃 Watchdog 与 `severity=none` |
| 实体解析 | `alertEntityCandidate`、`EntityResolver`、`ksmPodFacts` | 标签 → 实体候选；按 informer、24 小时墓碑、kube-state-metrics 历史的顺序解析出 uid 与组件 |
| 拓扑 | `buildKubeTopology`、`TopologyStore`、`TopologyGraph`、`ksmTopologyIntervals` | 由 Kubernetes 对象构建快照；事件溯源与按时刻查询；可达、组件、深度、子图；从 kube-state-metrics 历史重建 |
| 收敛 | `converge`、`prepareAlerts` | 告警与变更 → 分组 |
| 变更关联分级 | `changeLinks`、`gradeChange`、`isRollback`、`CHANGE_GRADE_WEIGHT` | 分组里每个变更的分级（high、medium、low）、依据、支撑 high 的成员告警与回退（[ADR 0169](../adr/0169-change-link-grades.md)） |
| 根因排序 | `rankRoot`、`silentRootTargets` | 候选、得分、分层、歧义；近期变更按分级取值（high 1、medium 0.5、low 0.2）；沉默根因的探测目标 |
| 事件 | `computeIncidents`、`reconcileIncidents`、`resolveIncidentRef`、`incidentLabel` | 确定性重算（分组、分级、排序）；与已持久化的事件对账（合并、拆分、别名、版本），分级写进 `Incident.change_links`；按 id、标签或别名解析 |
| 规范化与指纹 | `jcs`、`paramsHash`、`proposalIdempotencyKey`、`evidenceFingerprint`、`observeFingerprint` | jcs-sha256-v1（与审批断言一致）；提议幂等键；带迟滞的证据指纹 |
| 参数 | `DEFAULT_RCA_PARAMS`、`resolveRcaParams` | `rca-params` 的默认值与按层叠加 |

## 一次对账的调用顺序

```ts
const graph = store.asOf(now);
const alerts = await normalizeWebhook(body, { clusterId, source: 'alertmanager', receivedAt: now, catalog, resolver, ruleExprs, chronic, now });
let computed = computeIncidents({ alerts: activeAndRecent, changes, graph, params, now });
// 只有症状的分组：执行 silentRootTargets(group, graph) 给出的探测卡，带上结果再算一次
computed = computeIncidents({ alerts: activeAndRecent, changes, graph, params, now, probes });
const { incidents, changes: events } = reconcileIncidents({ clusterId, previous, computed, topologyVersion: graph.version, now });
// incidents 写库，events 写 outbox（incident.created/updated/resolved/merged/split）
```

- `previous` 传入未合并的已持久化事件；对账结果只包含新建或有变化的事件。
- 证据指纹：每次阶段 A 对账后调用 `observeFingerprint(state, evidenceFingerprint(cards))`，`changed=true` 时才按 `fingerprint_changed` 触发重研。

## 参数

| 参数 | 默认值 | 含义 |
|---|---|---|
| `weights` | 覆盖率 0.40、先于症状 0.15、角色先验 0.20、近期变更 0.15、长期告警惩罚 0.10 | 根因得分 |
| `role_priors` | change 1.0、cause 0.8、symptom 0.3、forecast 0、meta 0 | 角色先验 |
| `merge_threshold` | 0.6 | τ：低于它的边只参与候选排序 |
| `ambiguity_margin` | 0.1 | δ |
| `adjacency`、`change_window` | 30m | 时间相邻、变更窗口 |
| `chronic_window`、`chronic_rate` | 7d、0.5 | 长期告警判断（由调用方经 `chronic` 回调提供） |
| `hub_min_dependents` | 3 | 枢纽吸收告警需要的独立依赖方数 |
| `top_k` | 3 | 输出的候选数 |

## 测试

```sh
pnpm --filter @srenautix/core test
```

- 黄金测试：`test/testdata/cluster.yaml`（kubectl 导出）→ `test/testdata/topology.golden.txt`；Alertmanager webhook 与 API v2 载荷 → 告警映射；CNPG 主库 OOM 加一次无关发布的级联 → 根因排序。
- `test/ksm.test.ts` 用真实的 Prometheus：`promtool tsdb create-blocks-from openmetrics` 回填 kube-state-metrics 序列，再启动 `prometheus` 查询。需要 PATH 中有 `prometheus` 与 `promtool`；临时数据放在仓库根目录的 `.work/`。
- 规范化与 gateway 共用 `contract/gateway/v1/testvectors/approval-vectors.json`。

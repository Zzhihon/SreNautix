# 0134 有相反证据时结论档位最高为 inconclusive

## 背景

CCHP 重建评测 aq-full3 的 pg-lock 用例中，primary 有 2 次（共 3 次）选中 h3"SeaweedFS master 不稳定/重启，先造成 WAL 归档失败"，档位是 likely。正确根因是 PostgreSQL Cluster。h3 同时有三类相反证据：

- 有相反的正常卡；
- `onset_precedes_symptom=false`；
- 它自己的重启检查 `cardcheck:workload/pod-restarts/restarts@Pod:cchp-data/seaweedfs-master-2` 判定为正常。

检查卡落在 StatefulSet 拥有的 Pod 上。按 ADR 0121 第 5 条，成员上的正常检查卡只算相反的正常卡，假设还有支持证据时不推翻。于是 h3 仍处于支持状态，阶梯在四个条件都不满足的情况下照常给出 likely。likely 是自愈 PR 的触发档位，一个被自己的检查否定过的假设不应到达这一档。

## 决定

1. **档位上限**：结论选中的假设满足以下任一项时，档位最高为 `inconclusive`，无论它由模型选中还是由代码按账本代选（ADR 0120）：
   - **自己的检查给出推翻结果**：有一张针对它的检查卡判定为正常，实体在它的范围内（或未知），并且测的信号属于它的机制（ADR 0133 的 `refutingChecks`）。成员上的这类卡仍然不改变账本状态（ADR 0121），但会限制档位。测的信号与机制对不上的"无关"检查不算。
   - **异常出现时间晚于症状**：事件有 symptom 角色的成员告警；规则判定的支持卡中，有异常起始时间的那些，最早的一张也晚于最早的症状告警加容差（2 分钟）。
2. **不限制的情况**：
   - 支持卡的异常起始时间都未知时不限制，仍由 `onset_precedes_symptom=false` 记录；
   - 事件没有症状告警时不限制。此时 `symptomOnset` 退回事件首次触发时间，那可能是更早一段的 cause 或 change 告警。例如 onboarding 用例首次触发的是 05:02 的发布熔断告警，worker 的异常起始于 05:39:30，两者不能构成"异常晚于症状"。
3. **留痕**：撞上这条时，`validation_notes` 写"模型选中的（或：代码按账本选中的）假设 hN <原因>，档位由 likely 退回 inconclusive（ADR 0134）"。`conclusion.hypothesis_id` 与 `root_component` 保留选中的假设，`consistency` 与 `consistency_detail` 如实记录四个条件。
4. **其余不变**：处置判断、修复建议与提议的校验规则不变。

## 结果

- 实现在 `apps/srenautix/src/research/ladder.ts`（`contraryLimits`，`judgeLadder` 的各个出口都经过它）。单元测试覆盖：pg-lock 场景（模型选中与代码代选都退回 inconclusive；没有这张检查卡时为 likely）、支持卡异常起始晚于症状告警、起始时间未知、事件没有症状告警。
- 离线重算 aq-full3 的 47 次运行，pg-lock primary 的两次 seaweedfs-master likely 都退回 inconclusive，不再出现错误的 likely。
  - 选择性准确率：primary 从 14/19 升到 16/19（其中 metrics-scrape 的两次来自 ADR 0133），fallback 保持 16/19。
  - 这批运行没有 evidence_consistent，良性误报为 0。

# 0137 模型没有给出检查时由控制器补选

## 背景

CCHP 影子 daeb169 上的研判 `32b99d76`（事件 `component:release`，Zzhihon/SreNautix#9）：hypothesize 输出的 `next_checks` 为空，修复级别为 validate，说明模型确实没有给出任何检查，不是挽救时删掉的。没有任何 cardcheck 执行，输出校验提示"假设 h1 没有检验并排除任何竞争假设"。

排查结果：

- 提示词的目录段（`catalogSegment`）列出了全部可用查询模板，其中包括卡片检查（ADR 0116），这一段不参与预算裁剪。hypothesize 的任务要求"为排名前 3 的、仍待检验的假设各设计一项区分性检查"。所以提示词与候选清单都给出了检查，是模型一项都没有选。
- 这次运行在第 1 步就以 `leader_supported` 停止：假设都落在同一个根因组件上，没有竞争假设，停止条件一开始就成立，discriminate 循环不会排任何检查。即使模型给出检查，这次也不会执行。
- 一般情况下，模型给出空的 `next_checks` 而停止条件不成立时，循环在第 1 步以 `no_change` 结束，待检验的假设一直没有检验，结论档位只能停在 likely 或 inconclusive。

## 决定

一轮 hypothesize 的 `next_checks` 为空时，控制器在这一步补选检查：

1. **候选**：只取卡片检查（`cardcheck:`），并且检查的组件按组件粒度（`componentOf`）是事件的组件：根因、候选根因或成员告警的组件。候选清单由 server 按相关性排列（ADR 0116：根因与候选在前，同一组件上组件自身类型的证据链在前），补选沿用这个顺序。
2. **分配**：依次为这一步待检验的假设（open：按账本排名，未固定、未推翻、还没有检验过，最多 checksPerStep 个）各取一项。条件是：检查的组件就是假设的根因组件；测的信号与假设机制对应（ADR 0133，对不上的检查不算检验，补选它没有意义）；这次运行没有以同样参数执行过。满足条件的检查中取清单里的第一项。假设的根因不是事件的组件、或者没有满足条件的检查时，这个假设不补。
3. **上限 3 项**（`SUPPLEMENT_LIMIT`）。参数全部取卡片默认值（`args_json` 为 `{}`，窗口取卡片定义），refutes_if 与 purpose 写明是控制器补选。补选写入 `validation_notes`：`第 N 轮 hypothesize 没有给出 next_checks，控制器按相关性补选 K 项卡片检查：…`。
4. 只在模型一项都没有给出时补选。给出的检查全部不合格或已执行过时不补，仍按原来的规则结束。查询模板（非卡片检查）与只读工具不补选：它们的参数要按事件填写，没有安全的默认值。

## 结果

- 实现：`apps/srenautix/src/research/checks.ts`（`supplementChecks`、`SUPPLEMENT_LIMIT`）、`research/controller.ts`（discriminate 每一步在 `next_checks` 为空时调用）；`docs/worker/stage-b.md` 已同步。提示词不变。
- 单元测试（`test/unit/research-logic.test.ts`）：
  - 只取事件组件上的卡片检查；
  - 机制是内存时跳过重启卡；
  - 根因是 Node（不是事件组件）的假设不补；
  - 最多 3 项；
  - 已执行过的检查不再补；
  - 没有卡片检查时不补。
- 集成测试（`test/integration/card-checks.test.ts`）：在两个真实事故的重建包上，用 next_checks 为空的录制运行阶段 B。控制器补选根因上清单第一项卡片检查并执行，产生新的证据卡。修复前这两个用例没有任何检查。
- `32b99d76` 这一类没有竞争假设、第 1 步就满足停止条件的运行不受影响：停止条件先于检查判断，这条规则不改变它。

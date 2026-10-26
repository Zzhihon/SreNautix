# 0168 ignore 的确定性依据成立时模型的提议不生效

## 背景

ADR 0138 规定 ignore 不带修复：有效提议、规则提议、修复模板使用的根因上适用的修复模板，三者有任何一项时不给 ignore。部署方的良性用例"业务高峰 HPA 停在上限"里，证据全部正常（CPU 节流 0、各阶段延迟低于前一天），ignore 的依据"得出结论的卡全部正常"成立，但 fallback 路由的模型仍提议放宽 HPA 上限（`hpa_bounds_set`）。这条提议通过了校验（动作在目录内、目标在拓扑中、依据的假设没有被推翻），于是 ignore 不成立，处置保持模型给出的 escalate（ADR 0162）。

规则提议与修复模板是领域包按卡片结论给出的修复，模型的提议只来自模型自己的判断。确定性依据已经说明这个事件不需要处理时，模型的提议与依据矛盾；保留它会让良性事件进入审批，处置也不是 ignore。部署方决定：良性 ignore 的依据成立时丢掉模型给出的提议，只记在研判备注里。

## 决定

处置推导（`research/disposition.ts`）中，ignore 的确定性依据（阶段 A 已判为 ignore、计划内退役、likely 以上的根因是集群外部组件、得出结论的卡全部正常、影响卡全部正常）的前提改为：

- 没有规则提议、修复模板使用的根因上没有适用的修复模板（不变）；
- 没有不能 ignore 的业务影响：有触发中的业务影响告警、并且有规则判定的异常卡时（ADR 0163、0166），依据都不成立，模型的提议照常有效；
- 最低取证集合没有缺口（阶段 A 已判为 ignore 的除外，不变）。

模型给出的有效提议不再是前提。依据成立而模型带了提议时：

- 处置为 ignore，`DispositionResult.dropProposals` 为真；
- 研判输出的 `proposals` 为空，这些提议不进入审批，也不出现在消息里；
- `validation_notes` 写两行：处置的依据与"模型给出的 N 条提议不生效（ignore 的依据成立，ignore 不带修复）"，以及每条提议的动作与依据的假设（"不生效的提议：hpa_bounds_set（h1）"）。

这条规则只在 ignore 的依据成立时生效；依据不成立时模型的提议照常校验与保留，处置按 ADR 0138、0162 推导。

## 结果

- 实现：`research/disposition.ts`（`ignoreBasis` 不再看有效提议数，`DispositionResult.dropProposals`）、`research/controller.ts`（丢掉提议并写研判备注）。
- 测试：
  - `test/unit/research-disposition.test.ts`：没有异常卡、阶段 A 已判为 ignore、外部组件为根因时，模型带了提议仍为 ignore，`dropProposals` 为真并写明；有规则提议或适用的修复模板时仍不给 ignore；业务影响告警在触发、有异常卡时模型的提议照常有效，处置不是 ignore；依据不成立时提议保留；
  - `test/integration/research-replay.test.ts`：录制的模型响应带一条提议、证据全部正常时，研判输出的处置为 ignore、`proposals` 为空、`validation_notes` 列出不生效的提议。

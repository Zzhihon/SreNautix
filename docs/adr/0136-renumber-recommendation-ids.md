# 0136 修复建议的 id 不合规时重新编号

## 背景

CCHP 影子 daeb169 上有一次研判（Zzhihon/SreNautix#9），conclude 输出的 recommendations 里，有两条的 id 不符合 `^r[0-9]{1,2}$`。修复阶梯按字段挽救（ADR 0080）时，`id` 是必填、不可空的字段，两条建议因此整条被删除。

建议的 id 只用来区分 recommendations 数组里的条目：conclude 输出里没有其他字段引用它，validateConclusion 只在 validation_notes 里用它指代建议。

## 决定

conclude 输出在解析之后、校验之前做一次补全（与 ADR 0127 中 next_checks 补 template 是同一个 `prepare` 钩子）：只要有一条建议的 id 不合规、缺失，或与前面的建议重复，就把全部建议按数组顺序重新编号为 r1、r2……；id 都合规且不重复时原样保留。每处改动写入 `validation_notes`（`/recommendations[i]：id "…"，按顺序重新编号为 rN`），这次输出的修复级别记为 field_salvage。

选择全部重新编号，而不是只给不合规的条目补号：只补号可能与已有的 id 冲突，全部重排能保证 id 唯一，而且顺序与数组一致。建议条数上限是 12，编号不会超出两位数。

## 结果

- 实现：`apps/srenautix/src/research/validate.ts`（`renumberRecommendations`）、`research/controller.ts`（conclude 的 prepare）。
- 单元测试（`test/unit/research-context-budget.test.ts`）覆盖以下情况：
  - 走修复阶梯，id 为 `rec-1` 与缺失的两条建议被保留，并重新编号为 r1、r3（没有这个补全时只剩 1 条）；
  - id 重复时重新编号；
  - id 合规时原样保留，修复级别为 validate。

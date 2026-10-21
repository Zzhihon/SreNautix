# 0127 大事件的研判上下文，与缺少 template 的检查

## 背景

CCHP 影子（11ce9d8）观察到阶段 B 的卡片检查一次都没有执行（Zzhihon/SreNautix#6）：

- primary 路由全部以上下文超限（`context`）失败，切到 fallback。2026-10-20 发布事故的阶段 A 有 133 张卡（66 张异常、54 张正常、13 张无法判定），研判子图有几百个节点；
- fallback 的 hypothesize 输出里，next_checks 的条目没有 `template` 字段，卡片检查 id 写在别的字段里。按字段挽救时 `template` 是必填、不可空的字段，这些条目全部被删除，研判没有任何检查。

上下文的大小有两处没有受控：

1. **证据卡**：路由上下文不小于 64k 时全部卡完整放入（每张带表格的前 8 行），超出时靠逐步裁剪（ADR 0099）减到放得下。133 张卡时第一次估算远超单次上限，裁剪要走很多步，裁掉的顺序也不区分"与假设相关"。
2. **输出 schema 的组件枚举**：`hypotheses[].root_component` 的枚举是研判子图的全部节点。重建评测的一次请求（trace-7ff3e72，release-false-rollback）里，880 个组件的枚举有 46,536 个字符，占整个请求的四分之三，而且不可裁剪。子图里绝大部分是 Pod 与 ReplicaSet，按组件粒度（ADR 0121）它们不会是根因。

## 决定

1. **卡多时只完整放入结论相关的卡**（`selectCards`）：阶段 A 的卡超过 40 张（`MANY_CARDS`），或路由上下文小于 64k 时：
   - 结论相关的卡（异常卡、检查产生的卡、候选根因上的卡）按相关性排序（候选根因上的异常卡、其他异常卡、检查卡、候选根因上的其他卡），前 40 张（`MAX_FULL_CARDS`）完整放入；
   - 其余结论相关的卡只列判定（ref、卡片、组件、判定）；
   - 与结论无关的卡（正常或无法判定、不在候选根因上）只写摘要：总数、各判定的张数，每条证据链各判定的张数与前 6 个组件。

   卡不多、上下文足够时与之前相同，全部完整放入。逐步裁剪（ADR 0099）照常作用在这些片段上，摘要与判定列表在裁剪顺序上与"其余证据卡的判定列表"同级。
2. **账本片段补上与假设相关的卡**（`hypothesisCards`）：第二轮 hypothesize 与 conclude 的账本片段之后，加入上文没有完整放入、但与假设相关的阶段 A 卡：假设引用的支持与相反卡在前，其次是假设范围（ADR 0121 `scopeOf`）内的卡，异常的在前；最多 16 张，表格保留前 3 行。这一段在裁剪顺序上与结论相关卡同级。
3. **组件枚举不含由控制器拥有的对象**（`componentChoices`）：子图里有 owned_by 出边的对象（Pod、ReplicaSet 等）不进入 `components` 枚举，事件根因与候选根因除外；超过 300 个（`MAX_COMPONENT_CHOICES`）时按角色（根因、候选、成员、邻居）与跳数取前面的。提示词仍要求根因写顶层属主，账本照常把 Pod 改写为属主（ADR 0121）。
4. **next_checks 缺少 template 时按检查 id 补全**（`inferCheckTemplates`）：修复阶梯在解析之后、校验之前执行输出专用的补全（`repairLocally` 的 `prepare`）。hypothesize 的每个条目，`template` 缺失或不是可用的模板与工具时：
   - 条目任何字段（包括多余字段）的字符串就是一个可用的模板名或工具名时，直接用它；
   - 字符串里有 `cardcheck:<包>/<链>/<卡>@<组件>` 时，完全相同的可用检查优先；组件不在列表中或没有写组件时，取同一张卡在假设根因上的检查，再取这张卡唯一的检查；
   - 推断出卡片检查、或 type 缺失时，type 补为 query（vetCheck 会把指向只读工具的 query 改为 tool）。

   补全写入 `validation_notes`，这次输出的修复级别记为 field_salvage。推断不出的条目保持原样，按字段挽救时只删除这一条，其余条目照常执行。

## 结果

- 实现在 `apps/srenautix/src/research/prompt.ts`（`selectCards`、`summaryView`、`hypothesisCards`、`componentChoices`）、`research/checks.ts`（`inferCheckTemplates`）、`llm/repair.ts`（`Prepare`）与 `research/controller.ts`；契约不变。
- 单元测试：133 张卡（CCHP 发布事故的规模）的事件只完整放入 40 张异常卡，其余 26 张异常卡只列判定，67 张无关卡写成摘要，hypothesize 的提示词连同输出 schema 不到单次输入上限的一半；账本片段带上被假设引用、只在摘要里的卡；组件枚举不含 Pod 与 ReplicaSet，超过上限时保留根因与候选；四种缺少 template 的条目形态。
- 集成测试（重建包、真实 Prometheus、录制回放的模型）：next_checks 只在多余字段里写了卡片检查 id 时，检查照常执行并产生新的证据卡；没有检查 id 的条目只删除它自己。

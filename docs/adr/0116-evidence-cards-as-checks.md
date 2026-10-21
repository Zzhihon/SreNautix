# 0116 卡片即检查：证据链的卡作为阶段 B 的区分性检查

## 背景

阶段 B 用区分性检查检验竞争假设：模型在 `next_checks` 里选一个查询模板或只读工具，server 执行后判定成证据卡，记入假设账本。analysis-quality 的 trace 显示阶段 B 从来没有执行过检查：

- 所有领域包的 `signals.yaml` 都没有 `templates`，可用的查询模板是空列表；
- 重建评测没有只读工具，生产环境也只有 Kubernetes 只读检查（ADR 0106）；
- `check_templates` 动态枚举为空时，`next_checks` 的 `maxItems` 被设为 0，模型写的检查全部被删掉。

结果每次研判都是 `stop_reason=no_change`、0 次检查。竞争假设无法检验，`evidence_consistent` 永远达不到。

另一方面，领域包里已经有大量判定规则明确的证据卡（阶段 A 只在告警实体上执行它们）。为检查再写一遍查询模板是重复劳动。

## 决定

1. **卡片即检查**：已加载领域包中证据链的卡，只要 `applies_to.kinds` 与研判子图中某个组件的 kind 相同（`sameKind`：不区分大小写、忽略 API 组），就可以作为区分性检查，在那个组件上执行。
   - **id**：`cardcheck:<包>/<链>/<卡>@<组件键>`。
   - **参数全部可选**，不允许其他字段：
     - `window_before`、`window_after`：相对检查锚点的时长，覆盖卡片定义的窗口；只给一端时，另一端取卡片定义；终点不晚于研判时刻。锚点与阶段 A 相同（ADR 0131）。
     - 卡片 `params` 的键：覆盖卡片的默认参数。卡片有 `check.args`（契约 2.17.0）时，取值范围按它约束；没有时，类型取默认值的类型。
     - schema 与合并规则由 packs-sdk 的 `checkArgsSchema`、`applyCheckArgs` 提供，server 与评测共用。
   - **执行方**：server 的 `POST /v1/research/tasks/{run_id}/query`（`PackEvidence.runCardCheck`）与评测的 `ReconstructedQueryRunner` 走同一个执行器。按 id 里的组件执行，不按假设的根因。结果按卡片的 CEL 判定成新的证据卡。
   - **拒绝**：未知参数、不适用的组件、不在子图中的组件，返回 400；没有这张卡返回 404。worker 把拒绝转成无法判定的卡，研判照常继续。
   - **packs-sdk**：`runCard` 增加 `window` 覆盖，这是增量改动，不影响已有调用。
2. **列表与截断**：`check_templates` 由"子图组件 × 适用的卡"生成，接在领域包的显式查询模板之后，进入研判输入的 `templates`。server 的研判上下文与重建的快照用同一个函数（`stage-a/card-checks.ts` 的 `cardChecks`）生成。
   - **组件顺序**：先是根因与候选根因（按得分），其次事件的成员组件，最后其余子图节点。属主已在列表里的对象不再列出（Deployment 的 Pod、ReplicaSet），因为研判按属主粒度提出假设（ADR 0121）。
   - **同一组件上的卡的顺序**：
     1. 组件自身类型的证据链；
     2. 这个 kind 的通用证据链（没有名称、标签、命名空间约束的组件类型）；
     3. 阶段 A 在本事件中执行过的证据链；
     4. 其余只按 kind 适用的卡。
     阶段 A 已在这个组件上执行过的卡，排在同一档的后面。同一档内各条证据链轮流取，不让一条链占满名额。
   - **上限**：每个组件最多 4 张，合计最多 20 张，控制在提示的目录片段之内（这一段不参与裁剪）。
   - **描述**：卡片有 `check.description` 时写成"<卡标题>，在 <组件> 上：<检查说明>"；没有时写成"<卡标题>，在 <组件> 上；异常表示 <卡片说明>"。
3. 领域包的显式 `templates` 保留，用于卡片表达不了的查询。它们由 packs-sdk 的 `compilePackSet` 编译（`PackSet.templates`，附带的卡在 `set.cards` 中，键为 `<包>/templates/<id>`），server 不再自己编译。
4. 契约不变：研判输入的 `templates` 与评测快照的 `context.templates` 本来就是 `{id, description, args}`，id 与 args 的取值不受 schema 约束。
5. **录制回放**：`llm-replay` 增加 `{{match:<正则>}}` 占位符，取 schema 枚举中第一个匹配的值，用于运行时才确定的检查 id。
6. **前缀**：选 `cardcheck:` 而不是 `card:`，因为证据卡的引用是 `card:N`。两者共用前缀会让录制与模型都混淆。

## 结果

- 用两次真实事故的重建包（`pg-sync-restart`、`metrics-scrape-blind`，脱敏后放在 `apps/srenautix/test/fixtures/eval/`）与内置领域包：
  - 研判输入里有卡片检查，根因组件在前；
  - 阶段 B 选中卡片检查后，在 id 里的组件上执行它，产生新的证据卡并记入假设的检查（`test/integration/card-checks.test.ts`）。
  - 之前同样的输入下，检查列表为空，0 次检查。
- server 接口的拒绝与 worker 执行器的行为见 `server-e2e`。
- 检查卡判定为正常时，只推翻实体在假设范围内的假设（analysis-quality 在 `research/ledger.ts` 中处理）。
- 证据卡在没有数据的环境里是无法判定的。卡片检查不会凭空让结论更强，只是让账本有机会拿到区分性的证据。

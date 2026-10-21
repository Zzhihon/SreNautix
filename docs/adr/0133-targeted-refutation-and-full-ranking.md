# 0133 推翻要有针对性，账本输出保留全部假设

## 背景

CCHP 重建评测 aq-full3（SreNautix e551886，b1、b2 共 47 次有结论的运行）里，召回@3 与 top-1 完全相等：primary 14/25 对 14/25，fallback 16/24 对 16/24。答错的运行中，标注根因都不在前 3。原因有两层：

- **被推翻的假设退出排序**：评测的 `topComponents` 只取未被推翻的假设，账本输出又按 id 排列。模型常把几个假设放在同一组件上，推翻几个之后，前 3 往往只剩 1–2 项。
- **推翻没有针对性**：metrics-scrape 的 primary 有两次运行，正确假设 h1 是"gateway 初始化阻塞，主容器停在 PodInitializing，Pod 未就绪"，它被 `cardcheck:workload/pod-restarts/restarts@StatefulSet:cchp-prod/gateway` 推翻。主容器从未启动，重启次数为零本来就在这个机制的预期之内，"没有重启"否定不了"初始化等待"。模型自己在 refutes_if 里也写了"仅重启次数为零不足以推翻"。账本的规则是"针对它的检查结果为正常即推翻"，不看检查测的是什么。召回@3 因此从 3/3 降到 1/3，两次运行都只能弃权。

## 决定

1. **输出的账本是完整排序**：`ResearchOutput.hypotheses` 按账本排名排列：支持、待检验、检验后仍无法判定、推翻；同一档内依次按支持证据数、阶段 A 候选得分、模型给出的顺序。被推翻的假设排在最后，不从排序里删除。评测的 `topComponents` 先取结论选中的根因，其余按这个完整排序取，召回@3 据此计算。契约不变，只是数组顺序有了含义。
2. **检查与机制的对应关系**：针对假设的检查卡只有在它测的信号属于假设机制所预示的症状时，才算检验了这个假设。信号与机制都归到同一组症状类型：crash、memory、cpu、startup、readiness、node、network、storage、clock、archive、failover、connections、sync、release、service、scrape。
   - 检查的类型取检查 id 中的名字：先看卡名（`<包>/<链>/<卡>` 的最后一段），卡名归不出类型、或只是 errors、condition、status、usage 这类通用词时看证据链名，再看包名。例如 `workload/pod-restarts/restarts` 是 crash，`workload/pod-restarts/memory` 是 memory，`node/node-network/errors` 是 network，`cchp-alerts/cnpg-instance-restarted/condition` 是 crash。查询模板按模板 id 判断，例如 `workload/memory-by-pod` 是 memory。
   - 机制的类型取假设机制文字中的中英文关键词，例如"初始化""PodInitializing"是 startup，"重启""崩溃""不稳定""OOM"是 crash，"未就绪"是 readiness，"spec 变更""发布""迁移"是 release。
   - 两边的类型有交集，就是对应的。检查测的卡片定义与假设的某张支持卡相同时，也是对应的：机制的症状已经在这个信号上出现过。
   - 以下情况视为对应，保持原来的判定：任一边归不出类型；由小模型对照 refutes_if 判定的工具结果；不知道执行了什么检查的卡。
3. **对应不上的检查记为"无关"**：
   - 不推翻假设，也不算相反的正常卡（evidence_consistent 的第 3 个条件）；
   - 不计入 `checks_run`，所以不算"检验后仍无法判定"，也不算 ADR 0124 中"检验并排除过的竞争假设"。这个假设下一轮可以换一项检查。
   - 检查异常时照常按范围计入支持，与阶段 A 的卡相同。
   - 每张无关的检查卡写一条 `validation_notes` 和假设的 `status_reasons`，格式为"检查 card:n（<检查 id>）测的信号不属于假设 hN 的机制，记为无关，不计入推翻：检查测的是 …，机制预示的症状是 …"。
   - 机制在下一轮 hypothesize 中改写后，每次评估都重新判断对应关系。
4. **范围规则不变**（ADR 0121 第 5 条）：对应的检查卡仍按实体所在的范围决定是直接推翻、只算相反的正常卡，还是不起作用。这里补充的是"对应"这一前提。
5. **提示词**：hypothesize 要求 mechanism 点明会出现哪些症状，检查测的信号必须是机制预示的症状；系统提示中的"推翻"定义同步修改。

## 结果

- 实现在 `apps/srenautix/src/research/targeting.ts`（`signalTypes`、`mechanismTypes`、`targets`）、`ledger.ts`（`targeting`、`refutingChecks`、`noteCheckRun`、`toContract` 的排序）、`evidence.ts`（检查卡带检查 id）与 `eval/score.ts`（`topComponents`）。单元测试在 `test/unit/research-targeting.test.ts`。
- 离线重算 aq-full3 的 47 次运行：复用 trace 里的模型输出与检查结果，按新代码重算账本、结论阶梯与排序，不调用模型。
  - 召回@3：primary 从 14/25 升到 18/25，fallback 从 16/24 升到 17/24。剩下没有召回的只有 bypassrls-1、bypassrls-2：假设里从来没有标注根因，属于发现环节的问题。
  - metrics-scrape primary 的两次弃权都变为由账本选中 gateway，档位 likely。
  - 无关的检查卡共 8 张，其中 6 张是在初始化等待类机制上执行的重启检查。
- 局限：类型来自关键词与检查 id 中的名字，只是近似。机制文字里的否定说法（例如"重启计数为 0"）同样会命中关键词，这时判为对应，等于保留原来的判定。领域包可以在以后为卡片声明信号类型，取代按名字推断。

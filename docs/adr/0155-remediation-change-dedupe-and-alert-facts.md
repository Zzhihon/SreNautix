# 0155 自愈 PR 按修改去重并记住被拒绝的修改，目录条目与告警调优模板只用告警能确认的事实

## 背景

影子部署运行一天后，自愈 PR 出现了三类质量问题。

1. **同一个修改开出多个 PR**。一条没有命中告警目录的告警在三个事件里各触发了一次 `alert-catalog-entry`，开出三个 PR，增加的行完全相同，只有 index 行、hunk 头与上下文不同（两次触发之间目录文件里多了别的条目）。另有一个告警调优的修改在已有打开的 PR 时又开了一次，后开的 PR 被合并，先开的那个被人关闭。原因：
   - 去重键是（研判运行，模板），每次研判各处理一次。同一条告警反复触发、事件恢复后再次触发都会产生新的事件和新的研判，等同于新的触发；
   - 分支名带事件 id 前 8 位，gateway 的 `branch_free` 预检拦不住；提议的幂等键包含 PR 描述（研判运行、事件链接），也各不相同；
   - 没有检查同一仓库里是否已有打开的 PR 或未结束的提议，也没有"人关闭了这个 PR"的记录，被拒绝的修改会被再次提出；
   - 主实例的 30 秒循环没有防重入，上一轮没有结束时下一轮会处理同一批研判。
2. **目录条目的实体与角色没有依据**。模板把第一条未覆盖告警的分类原样写进条目，并按 deployment、statefulset、daemonset、pod、component、service 的顺序取第一个出现的标签作为实体名：
   - 告警只带分组用的 component 标签（例如表示"工作负载层"的 `component: workload`）时，条目的实体是逻辑组件 `component:workload`。这个逻辑组件在拓扑里没有对应的对象，没有条目时告警本来就归入同一个逻辑组件（ADR 0104 §6），条目不改变任何归属，只把覆盖缺口藏起来；
   - 规则用标签契约声明了没有实体（`entity_kind: none`）时，模板照样生成逻辑组件实体；规则带 `entity` 与 `entity_kind` 时，模板反而不用它们；
   - 角色没有依据（默认的 symptom，置信度 0.3）或只按表达式特征分类时，条目把它写成置信度为 1 的确定角色，`srenautix doctor` 不再列出待确认。
3. **对外部上游的告警提议降级**。两个"降低误报告警的严重度"的 PR 针对上游模型服务方的首字延迟与故障率告警，证据卡里故障率本身是异常的（告警是对的）。它们由早于 ADR 0139 的版本开出：研判"集群内没有可处置的对象"给出 ignore，模板把 ignore 等同于误报。ADR 0139 之后模板只在根因的组件类型声明为 external 时不适用，仍有缺口：
   - 判断的对象是根因，被降级的是告警。根因是按主题聚合的逻辑组件（它同时匹配业务组件，不能整体声明为外部，ADR 0147）、或者事件根因是集群内的组件而成员里有外部上游的告警时，模板仍会降级外部上游的告警；
   - 外部上游的事件已经改为按周期汇总（ADR 0147），这类告警的噪声由汇总处理，不需要改告警规则。

## 决定

### 1. 去重键：仓库与变更哈希

变更哈希由规范化补丁与修改定位一起计算（`changeHash(patch, locations)`，`dedupe.ts`）：

- 规范化补丁：解析补丁（`diff` 的 `parsePatch`），每个文件取路径（新文件取新路径）与 hunk 中以 `+`、`-` 开头的行，按路径排序。index 行、hunk 头与上下文行不参与，基准提交前进、行号移动后同一个修改的规范化补丁不变；
- 修改定位：计划给出的 `locations`（packs-sdk 的 `RemediationLocation`），每条真正改动了文件的 edits 一项，取模板声明的目标在变量替换之后的值：匹配到的文件路径、`document` 选择的 kind 与 name、`locate`（没有声明时取第一个 set 路径的父路径或第一个 append 路径）。例如 `noisy-alert-relax` 的定位是 `spec.groups[*].rules[alert=<告警名>]`，`hpa-max-replicas-raise` 的定位是 HPA 资源与 `spec`。定位用模板的选择器写法，不用解析出的数组下标：前面插入别的规则时下标会变，同一条规则的修改哈希仍然不变；
- 定位去重排序后取哈希（`locationHash`），与规范化补丁一起取 sha256。

同一个规则文件里两条严重度与持续时间相同的规则，放宽它们的补丁增删的行完全相同，定位不同，哈希因此不同：一条告警的 PR 打开期间，另一条告警照常提出自己的 PR；一条被拒绝之后，另一条照常提出。

每个自愈 PR 提议在 `server.remediation_changes` 记一行（remediation 迁移 3、4）：仓库、哈希与哈希版本、修改定位与定位哈希、模板、文件列表、事件、状态与 PR。状态：

| 状态 | 含义 |
|---|---|
| `pending` | 提议还没有开出 PR |
| `open` | PR 打开 |
| `merged` | PR 已合并 |
| `rejected` | PR 关闭且没有合并，或提议在审批时被人拒绝 |
| `abandoned` | 提议被策略拒绝、过期、绑定过时或执行失败，没有开出 PR |

状态在需要判断时刷新：先按 `gitops_pulls` 找 PR，找不到时看提议的状态与执行阶段；有 PR 时读 GitHub 上 PR 的当前状态（`GET pulls/{n}`，在 server 的请求白名单内）。`merged` 与 `abandoned` 不再变化；`rejected` 每次判断都刷新，人重新打开 PR 后回到 `open`。

### 2. 计划校验之后、提议之前判断

| 已有的记录 | 原因码 | 处理 |
|---|---|---|
| 同一个修改有 `open` 的 PR | `duplicate_open` | 不提议 |
| 同一个修改有 `pending` 的提议 | `duplicate_pending` | 不提议 |
| 同一个修改是 `rejected` | `rejected_before` | 不再自动提出 |
| 同一模板对同一组文件的另一个修改在 `remediation.rejected_cooldown`（默认 7 天）内被拒绝 | `rejected_cooldown` | 冷却期内不提出 |

都记在 `remediation_attempts`（outcome 为 skipped），原因里写 PR 地址与关闭时间。冷却期为 `0s` 时只记住被拒绝的那一个修改。冷却期按（模板，文件）计，与定位无关：它表达的是"这个模板对这些文件的修改刚被人拒绝过"，冷却期内同一模板对同一文件的其他修改先不提。

### 2a. 加入定位之前的记录：过渡规则

加入定位之前的记录按旧算法保留（`hash_version` 为 1，`change_hash` 只含规范化补丁，`legacyChangeHash`）；升级期间仍在运行的旧版本写入的行与补登记的行（提议参数里没有定位，§4）也是旧算法。新记录的 `hash_version` 为 2。判断时新修改同时算出变更哈希与旧哈希（`classify`）：

| 判断 | hash_version 2 的行 | hash_version 1 的行 |
|---|---|---|
| `duplicate_open`、`duplicate_pending` | 变更哈希相同 | 旧哈希相同 |
| `rejected_before` | 变更哈希相同 | 旧哈希相同，并且定位相同 |

- 重复的判断对旧算法的行只看旧哈希：误判的代价是触发写在一个只差规则名的 PR 上，那个 PR 结束后自然不再参与；
- 被拒绝的判断对旧算法的行要求定位相同：误判会让另一条规则的修改永远不再提出。旧算法的行没有记下定位，定位相同按"旧补丁改动了新修改的每个定位"确认：取提议的补丁与尝试记录的基准提交，读基准提交上的文件（`contents?ref=<提交>`，在 server 的请求白名单内），把补丁应用上去，比较每个定位上的值在应用前后是否变化（packs-sdk 的 `locationChanged`，文档按 kind 与 name 选择，与计划相同）。确认相同时在这一行记下 `locations` 与 `location_hash`，之后直接比较定位哈希；不相同时不记，另一组定位以后照常确认；
- 补丁在基准内容上不能应用、基准提交或补丁缺失说明记录不一致，抛出，这次研判记为 `internal_error`；读取 GitHub 失败时推迟到下一轮。

迁移 4 只增加列（`hash_version` 默认 1、`locations`、`location_hash`），不改写已有的行；N-1 版本照常写入旧算法的行。

### 3. 重复触发写在已有的 PR 上

`duplicate_open` 与 `duplicate_pending` 时登记一次触发（`server.remediation_triggers`，同一个修改的同一个事件只记一次）：

- 先确保新事件有 issue（`issues.ensure`，受同样的限速）；
- PR 开出后，在 PR 上评论：事件与研判运行的控制台链接、结论等级、`Refs <新事件的 issue>`，带 `<!-- srenautix:trigger=<事件> -->` 标记。请求结果未知时，重试先按标记在 PR 的评论里找回，不重复发；
- 新事件的 issue 关联到 PR（`IssueService.link`）：issue 里回链 PR，PR 描述补上新 issue 的 `Refs`；
- 评论失败时退避重试（30 秒起翻倍，最长 30 分钟），最多 8 次，写治理审计 `remediation.trigger_comment`。

### 4. 重启与补登记

记录都在 PostgreSQL 里，server 重启、主实例切换后照常去重。每轮开始时，`remediation_attempts` 中 proposed、还没有修改记录的提议按提议参数里的补丁补登记（旧算法，§2a），升级之前已经开出的 PR 也参与去重。`RemediationService.runOnce` 防重入：上一轮没有结束时这一轮跳过。

### 5. 模板上下文里告警的拓扑事实

模板上下文的每条成员告警增加（`RemediationAlert`，packs-sdk）：

- `confidence`：分类的置信度；
- `component`：告警归属的拓扑组件；
- `component_object`：归属组件对应的具体对象（`ComponentExpander.concrete`）。组件本身是对象时就是它，逻辑组件只映射出一个工作负载（ADR 0130）时是这个工作负载；逻辑组件没有映射出对象、或只归入命名空间伪组件时为 null；
- `external`：归属组件或实体的组件类型声明在集群之外，或命中 `notify.digest.external_roots` 开启时的 `components`、`alert_labels`。

server 的自愈 PR、研判输入的处置依据与重建评测都用 `alertFacts`（`remediation/facts.ts`）计算；处置依据与评测没有部署的汇总配置，只按组件类型判断外部上游。

### 6. `alert-catalog-entry` 只写告警能确认的实体与角色

- 只为能给出实体的未覆盖告警加条目，按顺序取：标签契约的 `entity` 与 `entity_kind`（`entity_kind` 不是 none）；`params.object_labels` 中第一个出现的对象标签（deployment、statefulset、daemonset、pod、persistentvolumeclaim、horizontalpodautoscaler、poddisruptionbudget、job_name、cronjob、node）；归属的逻辑组件（component、service 标签）在拓扑里对应到具体对象时取逻辑组件；
- 一个事件里有多条未覆盖告警时，取第一条能给出实体的；
- 都给不出实体时跳过，原因说明是规则声明了没有实体、还是分组标签对应的逻辑组件在拓扑里没有对象，以及要在告警规则上加 `entity` 与 `entity_kind` 标签；
- 角色取告警当前的分类，置信度低于 1（按表达式分类或没有依据）时写上 `role_confidence`；改动说明写明角色的依据。

### 7. `noisy-alert-relax` 不降级外部上游的告警

研判一支与长期告警一支都只考虑 `external` 为 false 的告警。根因是外部组件时仍然整体不适用（ADR 0139）。降级的告警按适用的那一支取：研判一支有候选时取研判一支的第一条，否则取长期告警一支的第一条。

## 考虑过的方案

- **按分支名去重**：分支名带事件 id，用同一个分支名会让不同事件的同一个修改共用一个分支，但 gateway 不能移动已有分支（ADR 0025），基准提交前进后无法更新补丁，PR 关闭之后也无法记住拒绝。
- **在 gateway 去重**：gateway 只看到工单与补丁，不知道 PR 与事件 issue 的关系，也不能写 issue（ADR 0095）；去重需要的提议状态、PR 状态与事件关联都在 server。
- **用（模板，目标对象）作为去重键**：同一模板对同一个对象的不同修改（例如 limit 调到不同的值）会被当成重复，旧 PR 上看不到新值；修改的内容才是审阅的对象，定位只把内容相同、对象不同的修改区分开。（模板，文件）只用于被拒绝之后的冷却期。
- **定位取解析出的具体路径（数组下标）**：前面插入一条规则后下标变化，同一条规则的同一个修改哈希会变，基准提交前进时去重失效；模板选择器写法的定位按规则名、资源名区分，与位置无关。
- **旧算法的行按旧哈希判断被拒绝**：同一文件里只差规则名的另一条规则的修改会永远不再提出，这正是加入定位要解决的问题。
- **迁移时改写旧算法的行**：旧行的定位只能从旧补丁与基准提交的内容得到，需要读取 GitHub，schema 迁移里做不到；按需确认只发生在旧哈希相同、被拒绝的行上。
- **目录条目的实体取研判根因**：研判根因是这次事件的根因，与未覆盖的那条告警不一定相关（未覆盖的告警可能只是被并进了这个事件）；按告警自己的标签与拓扑取实体，条目对以后每一次触发都成立。

## 测试

- 单元（`remediation-dedupe.test.ts`）：基准提交前进后的两个补丁哈希相同；增加的行或路径不同时哈希不同；多文件补丁与顺序无关；新文件按新路径计；同文件不同规则的补丁旧哈希相同、变更哈希不同，同一规则同一改动的变更哈希相同；过渡规则（旧算法的行按旧哈希判重复，被拒绝时只有定位确认相同才 `rejected_before`，冷却期按模板与文件）；PR 评论的标记、链接与 Refs。
- packs-sdk（真实 Prometheus 与 git 仓库）：`noisy-alert-relax` 的定位是替换了告警名的 locate，`hpa-max-replicas-raise` 的定位是 HPA 资源与 `spec`；`locationChanged` 对同一文件里另一条规则、另一个 HPA 文档的改动为 false；只带 service 标签、逻辑组件对应到对象时条目为逻辑组件并带 `role_confidence`；`entity_kind: none` 与 `component: workload` 时跳过，原因逐字核对；同一事件里另有带对象标签的未覆盖告警时为它加条目；标签契约的 entity 取为实体；外部上游的告警在根因不是外部组件、研判为 ignore 或长期告警时都不降级，同一事件里集群内的 critical 告警照常降级。
- 集成（真实 PostgreSQL，内存中的 GitHub REST API）：
  - 同一条告警三次触发，中间基准提交前进：第二次 `duplicate_pending`，PR 开出后第三次 `duplicate_open`；只有一个提议与一个 PR；PR 上两条评论，各带新事件的标记与 Refs；事件 issue 的循环在新 issue 里回链 PR、PR 描述补上两个 Refs；之后的轮次不重复评论；
  - 清掉修改与触发的记录、换一个服务实例（相当于升级与重启）：补登记的行是旧算法，第四次触发按旧哈希仍是 `duplicate_open`，PR 上多一条评论；
  - 人关闭 PR 且没有合并：旧算法的行经基准提交上的内容确认定位相同，同一个修改 `rejected_before`，这一行记下定位；被拒绝的 PR 上不再评论；同一规则文件里只差规则名的另一条告警在冷却期内 `rejected_cooldown`；冷却期为 0 时它照常提议（旧哈希相同、定位不同），被拒绝的修改仍然不提；
  - 同一规则文件里只差规则名的告警：一条告警的 PR 打开时另一条告警提出自己的 PR，两者旧哈希相同、变更哈希不同，各自的重复触发只评论在各自的 PR 上；一个 PR 被关闭且没有合并后它 `rejected_before`，另一个仍是 `duplicate_open`；
  - 只带 `component: workload` 的告警按真实的拓扑存储得出没有对应对象，目录条目跳过；同名 Service 选中一个 Deployment 时条目写逻辑组件，PR 描述写明对应的对象；
  - 外部上游汇总配置（组件或标签）里的告警，研判为 ignore 时不降级；配置为空时同一事件照常降级。

## 结果

- 实现：`apps/srenautix/src/remediation/{dedupe,service,facts,render,migrations,github-repo}.ts`、`config/server.ts`（`remediation.rejected_cooldown`）、`roles/server.ts`；`packages/packs-sdk/src/remediation/plan.ts`（`RemediationAlert`、`RemediationLocation` 与计划的 `locations`）、`location.ts`（`locationChanged`）；`packs/gitops/remediations.yaml`；契约 `pack.schema.json` 只补充 `when` 变量的说明，版本不变。
- 新开的自愈 PR 每个修改只有一个；同一个修改反复触发时，审阅者在一个 PR 上看到全部触发与关联的事件 issue。
- 人关闭未合并的修改不会再自动出现；需要重新提出时，重新打开那个 PR 即可。
- 只带分组标签的告警不再得到目录条目 PR，跳过原因指向告警规则上缺少的实体标签。

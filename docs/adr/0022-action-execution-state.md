# 0022 gateway 的执行状态：ActionExecution

## 背景

gateway 在被管集群中执行已批准的动作。执行状态必须在中心不可用时继续推进，必须在进程崩溃、换主之后能接上，并且不能因为重启产生第二次写入（不变量 8）。DESIGN §2.1 规定 gateway 在所在集群只拥有 `ActionExecution` CRD、Lease 与本地审计暂存卷。

## 决定

1. **对象**：`ActionExecution`（`srenautix.io/v1`，命名空间级），CRD 由 controller-gen 从 `internal/spoke/gateway/execution` 生成。
   - 名称等于 `spec.executionId`（ADR 0020 的派生规则）。同一工单重复下发时创建遇到同名对象，不产生第二次执行。
   - `spec` 是工单内容（提议、断言信封原文、参数原文、目标、绑定、两个过期时间），由 CEL 规则保证创建后不可修改。
   - `status` 只由持有 Lease 的 gateway 写入，每次写入带 `resourceVersion`。
2. **阶段**（DESIGN §9.4）：

   | 阶段 | 含义 |
   |---|---|
   | `pulled` | 工单已接收，签名、绑定、策略与审批人作用域已核对，进入冲突域队列 |
   | `prechecked` | 轮到执行时重新核对通过；写入执行前的快照（含目标 `resourceVersion` 与撤销所需的原值）与最终等级 |
   | `executing` | 写入 `attemptId` 与持有者之后才产生副作用 |
   | `verifying` | 副作用已生效；`verifyDueAt` 持久化，重启后按原截止时间继续 |
   | `verified` | 执行器的检查与参数中声明的 PromQL 条件全部通过 |
   | `verify_failed` | 校验失败，随后按等级处理 |
   | `reverted` | reversible 动作已恢复原状态 |
   | `awaiting_compensation_approval` | compensable 动作给出补偿建议，需要再次审批 |
   | `needs_human` | 不可逆动作校验失败、撤销失败、或副作用部分生效 |
   | `failed` | 副作用没有发生（PDB 拒绝、执行出错且观察确认未生效、中断时未生效） |
   | `stale` | 目标 UID、`resourceVersion` 或中心绑定发生变化 |
   | `expired` | 审批或提议过期 |
   | `rejected` | 签名、绑定、策略、作用域、等级、档位、预检或只提议条件不满足 |
   | `indeterminate` | 分步动作中断时只完成了一部分，或无法观察结果，由人判断 |

   每次迁移先追加到执行审计链（本地暂存 fsync），再写入 `status.phase` 并在 `status.history` 追加一条，带审计记录的 `seq` 与哈希。history 是推回中心的执行事件的唯一来源（ADR 0021）。
3. **先写记录，再产生副作用**：`executing` 与 `attemptId` 写入成功之后才调用执行器；执行器的每次写入带 `resourceVersion` 前置条件（JSON Patch 的 `test` 操作或 merge patch 的 `metadata.resourceVersion`）与 `srenautix.io/execution-id` 注解。分步动作（逐个驱逐）在每一步的副作用之前把步骤写入 `status.progress`。
4. **崩溃恢复**：成为主实例时列出全部 ActionExecution，`pulled` 与 `prechecked` 重新入队；`executing` 只观察目标：已生效进入 `verifying`，未生效记为 `failed`，部分生效记为 `indeterminate`，从不重新执行；`verifying` 按持久化的截止时间继续校验；撤销已开始但没有结束的记为 `needs_human`。
5. **冲突域队列**：队列与执行槽位在主实例内存中，同一冲突域串行、不同冲突域并行；切换主实例时从 ActionExecution 重建。排队位置随 `pulled` 事件推回中心，并在心跳中上报。
6. **选主与隔离**：单副本、Recreate；Lease 身份是 Pod 名。写入 `executing` 之前重新读取 Lease，确认持有者仍是自己。失去 Lease 时进程退出，由 Kubernetes 重启。
7. **停机**：收到 SIGTERM 后停止拉取与派发，等进行中的执行与校验完成，补写审计汇、补推事件后退出。

## 结果

- 执行状态与业务对象在同一个 apiserver 中，中心不可用时执行、校验、撤销照常推进，恢复后补推。
- 以 apiserver 审计日志为准，每次执行对目标的写入不超过一次（`test/invariants` 的不变量 8 测试在三个故障点 `kill -9` 验证）。
- 已结束的 ActionExecution 不自动删除，保留期由运维按集群的审计要求清理。

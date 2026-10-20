# 0106 阶段 B 的 Kubernetes 只读检查与相关变更

## 背景

2026-10-20 的发布事故里，决定性的证据是 initContainer 的日志："等待迁移"。阶段 B 的区分性检查只有领域包的查询模板（指标）与 MCP 工具，看不到 Pod 的状态、事件与容器日志；研判输入里的变更也只有收敛进事件的那几条。

## 决定

1. **server 提供的只读工具**：server 用自己的集群只读凭证（chart 的 `roles.server.clusterRead`，含 `pods/log`）执行四个工具，worker 把它们和 MCP 工具一起交给区分性检查（工具来源 `hub`，只能看到当前状态，回放时不可用）：
   - `kube_pod_status`：phase、条件、init 容器与容器的状态（等待或终止的原因、消息、退出码、重启次数、镜像）、节点与属主；
   - `kube_workload_pods`：Deployment、StatefulSet、DaemonSet、Job 当前的 Pod，带停住的 init 容器与等待原因；
   - `kube_events`：对象最近 20 条事件；
   - `kube_logs`：容器或 init 容器日志的最后若干行（`tail_lines` 默认 100、最多 500，`previous` 读上一次退出的容器）。
   参数按工具的 JSON schema 校验；只允许事件涉及的命名空间（组件、候选根因、事件变更的目标与研判子图中的对象）；只对 server 所在集群的事件提供，其他集群返回 409 `kube_unavailable`。不读 Secret、ConfigMap 的值与容器的环境变量。结果脱敏后按 `max_bytes`（默认 16 KiB）截断，属于不可信数据，由小模型判定支持、推翻或无法判定。配置 `kube_reads`（默认关闭）。
2. **相关变更**：研判输入在事件自己的变更之外，再列出事件首次触发前 2 小时到现在、触及研判子图对象或事件命名空间的变更（变更源的提交与从拓扑推导的发布），最多 20 条，接在事件的变更后面编号，提示词里以 `in_incident: false` 标出。
3. worker 与 server 之间的研判输入接口（`/v1/research/tasks/{run_id}/context`）是内部接口，新增的 `hub_tools`、`related_changes` 两个字段对旧版 worker 无影响。

## 结果

- 发布类事故可以直接看到 initContainer 停在哪里、日志说了什么，区分"迁移等待"与镜像、调度、配置问题。
- 跨集群（reader）的只读检查需要 reader 支持读取请求，留待 reader 协议扩展；在那之前只对 server 所在集群可用。

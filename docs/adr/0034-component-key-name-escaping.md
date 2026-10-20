# 0034 组件键名称段的转义与非法对象的跳过

## 背景

组件键（`ComponentKey`，ADR 0011）写作 `<kind>:<namespace>/<name>`，集群级对象写作 `<kind>:<name>`。`:` 分隔 kind，`/` 分隔命名空间。Kubernetes 的大多数对象名是 DNS 名称，不含这两个字符，但不是全部：

- RBAC 对象（Role、ClusterRole、RoleBinding、ClusterRoleBinding）的名称只要求是合法的路径段，可以含 `:`、`@`、空格和非 ASCII 字符。`system:` 前缀的对象在每个集群里都有，cert-manager 安装 `cert-manager-controller-approve:cert-manager-io`。
- 自定义资源的名称同样只按路径段校验。
- reader 从外部数据中读到的引用（Argo CD `status.resources`、Flux inventory、kube-state-metrics 标签）不经过 apiserver 的名称校验。

reader 遇到这样的名称时生成不出合法的键。原先的做法是 panic，informer 回调把它重新抛出，整个进程退出并持续重启。

## 决定

1. **名称段按字节转义**：键中的名称段由对象名编码得到。名称的 UTF-8 字节中，`A–Z`、`a–z`、`0–9`、`-`、`.`、`_` 原样保留，其余每个字节写成 `%` 加两位大写十六进制。例如 `ClusterRole:cert-manager-controller-approve%3Acert-manager-io`、`RoleBinding:kube-system/system%3A%3Aleader-locking-kube-controller-manager`、`ClusterRole:caf%C3%A9`。
   - DNS 名称只含保留字符，编码后不变，已有的键全部保持原样。
   - `%` 自身也被转义，所以 `a%3Ab` 写作 `a%253Ab`，不会与 `a:b` 混淆。
   - `/` 被转义，名称不能伪造出命名空间段。
2. **规范编码，双向唯一**：解析只接受这种编码。`%` 后必须是两位大写十六进制；解出的字节不能是保留字符（`%41` 不合法，`A` 必须原样出现）；解码结果必须是合法的 UTF-8。每个名称恰好对应一个名称段，每个合法的键恰好解析出一个名称。
3. **其余部分不转义**：kind 必须匹配 `^[A-Za-z][A-Za-z0-9.-]*$`，命名空间必须是 DNS 标签，名称不能为空，也不能含非法 UTF-8 或孤立代理项。不满足时生成失败，不做截断或替换。键的长度上限 400 按编码后的字节计算。
4. **契约**：`contract/schemas/common.schema.json` 的 `ComponentKey` 模式把名称段改为 `([A-Za-z0-9._-]|%[0-9A-F]{2})+`，原先合法的键在新模式下仍然合法。拓扑节点的 `name` 字段保存对象的原始名称，只有 `key`、边的 `from`/`to` 使用编码后的形式。
5. **黄金向量**：`contract/testvectors/component-keys.json` 由 `hack/gen-component-key-vectors` 生成，期望值在生成器中手写，不调用实现。文件包含三类用例：
   - `keys`：编码结果必须逐字节等于给定的键，解析后必须还原出原来的三元组。
   - `rejected_objects`：编码必须失败。
   - `rejected_keys`：解析必须失败。

   Go 实现（`internal/spoke/reader/topology`）与 TypeScript 实现（`packages/core`）都用这个文件做单元测试；`make gateway-generate-check` 检查文件与生成器一致。
6. **生成失败时跳过，不退出**：reader 中生成键的函数返回错误，不 panic。
   - 对象自己的键生成失败时，跳过整个对象，也不留墓碑。
   - 引用的键生成失败时（某个受管资源、owner、配置引用），只跳过这个节点和以它为端点的边，同一对象的其余贡献照常写入。
   - 字段类型与预期不符（`status.resources` 不是列表、inventory 条目无法解析、选择器无效）时，按字段缺失处理。
   - 提取函数是只读的纯函数；如果它因某个对象的异常内容 panic，这个对象保留上一次的贡献，错误连同调用栈记录下来，其余对象照常处理。
   - kube-state-metrics 历史重建与按 IP 回查使用同样的规则。
7. **可观测**：跳过的对象计入两个指标，同时打印警告日志。日志按（来源、kind、类别）限速为每分钟一条，被抑制的次数写在下一条日志里。
   - `srenautix_topology_invalid_keys_total{source,kind}`：`source` 是 informer 的资源名（如 `applications.argoproj.io`）或 kube-state-metrics 指标名；`kind` 只取合法的 kind 名称，其余记为 `invalid`，标签基数有界。
   - `srenautix_topology_extract_errors_total{source}`：字段无法解析或提取函数出错的次数。

## 结果

- RBAC 对象可以进入拓扑。被 Argo CD 或 Flux 管理的 ClusterRole 有自己的 `managed_by` 边，根因与变更关联能够指向它们。
- 外部数据中的单个异常对象不再让 reader 退出；它只表现为指标上升和限速的警告日志，其余拓扑完整。
- 中心与 reader 必须使用同一种编码。TypeScript 一侧在构造键（`nodeKey`）时编码名称，在解析键（`parseKey`）时解码；告警标签中的原始对象名经编码后才能与 reader 上报的键匹配。

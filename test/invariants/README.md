# 不变量测试（spoke 部分）

本目录的 Go 测试覆盖 DESIGN §16.1 中由 gateway 承担的不变量。每个测试启动一套完整的运行环境（`internal/spoke/gateway/gwtest`）：

- kube-apiserver 与 etcd（envtest 1.37，开启审计日志），安装 `test/crds/` 中固定版本的 CRD 与 `ActionExecution` CRD；
- 按动作目录生成的准入策略、Binding（`paramRef` 指向 `srenautix-freeze`）与 RBAC，与 chart 渲染的内容相同；
- 工单协议的中心实现（`internal/spoke/testenv/hub.go`）与服务签名审批；
- MinIO（审计汇，对象锁定）、Prometheus（执行后校验）；
- 以 gateway ServiceAccount 身份运行的引擎（进程内，或以子进程运行以便 `kill -9`）。

| 不变量 | 测试 | 内容 |
|---|---|---|
| 2 写操作只能是类型化动作 | `TestInvariant02TypedWritesOnly` | 执行器注册表等于目录；gateway 代码不导入 `os/exec`；以 gateway 身份修改镜像、创建 ConfigMap 与 Secret、删除 Pod 与 Deployment 都返回 403 |
| 3 没有经过自检的准入策略就只提议 | `TestInvariant03NoSelfCheckNoExecution`、`TestInvariant03SelfCheckCadence` | 删除一个 Binding、或把它改成 Warn，60 秒内转为只提议：不再拉取工单，心跳上报 `propose_only`；恢复后被扣住的工单得到执行。周期自检间隔为 1 小时时，周期之间不发探针，执行前的自检拒绝策略失效后的工单，恢复后立即继续，停用动作时立即重新探测（ADR 0024） |
| 4 gateway 的 SA 没有特权 | `TestInvariant04NoPrivilegedPermissions` | 启用全部动作后，对 Secret、准入配置、RBAC、token、证书、模拟身份与 `srenautix-freeze` 的写入逐项 SelfSubjectAccessReview，全部不允许；生成的规则不含这些资源与通配符 |
| 5 审批签名并绑定 | `TestInvariant05SignedAndBound` | 签名后逐个篡改断言字段、签名有效但绑定不一致、伪造签名、早于恢复标记的审批，都被拒绝且目标不变 |
| 7 可补偿与不可逆动作一律人工审批 | `TestInvariant07HumanApprovalForIrreversible` | 对不可撤销动作配置自动执行，策略加载失败；对裸 Pod、单副本、PDB 无余量的 Pod 自动重启，转为人工审批；满足条件时自动执行 |
| 8 最多执行一次 | `TestInvariant08AtMostOnce` | 子进程 gateway 在 `executing` 写入后、副作用之后、`verifying` 写入后被 `kill -9`；接管的 gateway 只观察不重跑；以 apiserver 审计日志为准，写入次数为 0 或 1 且与结局一致 |
| 10 每次写入都可追溯 | `TestInvariant10TraceableWrites` | apiserver 审计日志中 gateway 的每次写入，在审计汇中都有对应的写入记录与审批人，哈希链与检查点签名校验通过；审计汇停止后不认领新执行，恢复后继续 |
| 11 熔断开关不依赖 gateway | `TestInvariant11FreezeWithoutGateway` | gateway 子进程被 `SIGSTOP` 后切换 `srenautix-freeze`：写入被拒；删除该 ConfigMap，写入同样被拒 |
| 12 `gitops_pr` 从不合并 | `TestInvariant12GitOpsNeverMerges` | 请求白名单拒绝合并、删除与改写分支；base 分支没有分支保护时启动探测为 False、预检拒绝；有保护时只推送 `srenautix/<执行 ID>` 分支并开 PR，main 不变，没有任何合并请求 |

不变量 1、6、9 由 TypeScript 部分负责（`test/invariants` 中的 TS 测试）。

## 本地运行（envtest）

```bash
make envtest-assets
export SRENAUTIX_TEST_BIN=<含 prometheus 的目录> SRENAUTIX_MINIO_BIN=<minio 可执行文件>
make go-test
```

不变量 8 在 envtest 上每个故障点运行 1 轮；`SRENAUTIX_INVARIANT8_ROUNDS` 可以调大。

## Kind

`make invariants-kind`（或 `test/invariants/kind/run.sh 08 10`）在 Kind 上运行同一组测试，每个不变量使用一个新集群：

- 节点镜像与 Kind 版本取自 `deploy/kind/versions.env`；kube-apiserver 开启审计日志并挂载到宿主机；
- 删除 kube-controller-manager 与 kube-scheduler 的静态 Pod，测试夹具按控制器的方式写入 status，不被真实控制器覆盖；
- 以 `USE_EXISTING_CLUSTER=true` 连接集群，不变量 8 默认运行 1000 轮。

需要在 Kind 上运行的部分：

| 不变量 | 原因 |
|---|---|
| 8 | DESIGN §16.1 要求随机 1000 次 `kill -9`；envtest 上只做每个故障点 1 轮 |
| 2、3、4、10、11 | 在发行版的 kube-apiserver（kubeadm 配置、审计后端）上复核准入、RBAC 与审计日志的行为 |
| 3（中心一侧） | 只提议时中心对执行请求返回 409，由 TS 的不变量测试在 Kind 上与 gateway 一起验证 |

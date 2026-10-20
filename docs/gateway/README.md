# gateway 运维说明

gateway 是被管集群中唯一的写身份（`srenautix-spoke --role=gateway`）。它从中心拉取已批准的工单，校验审批断言、策略、绑定与预检，先写 `ActionExecution` 再执行，执行后按声明的条件校验，必要时撤销或转人工，并把每一步写入执行审计链。设计见 DESIGN §9.4，相关决定见 ADR 0020（审批断言）、0021（工单协议）、0022（执行状态）、0023（准入策略生成）。

## 部署形态

| 项 | 要求 |
|---|---|
| 副本 | 单副本，`strategy: Recreate`；Lease（`gateway.lease_name`）只用于选主隔离，身份为 Pod 名 |
| 环境变量 | `POD_NAME`、`NODE_NAME` 由 downward API 注入；缺少时启动失败 |
| 停机 | 收到 SIGTERM 后不再认领工单，等进行中的执行、校验与撤销完成；`terminationGracePeriodSeconds` 至少覆盖最长的校验时间窗（目录中为 1800 秒） |
| 卷 | 审计暂存卷（`audit.staging_dir`，PVC，卸载时保留） |
| Kubernetes | 1.30 及以上（ValidatingAdmissionPolicy GA） |
| 客户端限速 | QPS 10、Burst 20；收到 apiserver 的 429 后 1 分钟内只提议 |

## 配置文件

`/etc/srenautix/config.yaml`，未知字段使启动失败：

```yaml
cluster_id: prod-east
profile: standard                 # compliance 时 H 档审批必须是通行密钥签名
namespace: srenautix              # ActionExecution、Lease、srenautix-freeze 所在的命名空间
listen:
  metrics: ":9090"
  probes: ":8081"
hub:
  url: https://srenautix.example
  token_file: /etc/srenautix/secrets/hub-token/token
  ca_file: ""
audit:
  checkpoint_key_file: /etc/srenautix/secrets/audit-key/private.pem   # Ed25519，PKCS#8 PEM
  checkpoint_key_id: gateway
  staging_dir: /var/lib/srenautix/audit-staging
  s3:
    endpoint: http://srenautix-minio.srenautix.svc:9000
    region: us-east-1
    bucket: srenautix-audit
    access_key_file: /etc/srenautix/secrets/audit-store/accessKey
    secret_key_file: /etc/srenautix/secrets/audit-store/secretKey
    force_path_style: true
  object_lock:
    enabled: true
    mode: GOVERNANCE              # 合规配置为 COMPLIANCE
    retention_days: 180
gateway:
  lease_name: srenautix-gateway
  policy_file: /etc/srenautix/gateway-policy/policy.yaml
  approver_keys_file: /etc/srenautix/approver-keys/keys.yaml
  admission_policy_prefix: srenautix  # 与 chart 的 fullname 相同，自检据此识别拒绝来源
  metrics_url: http://prometheus-operated.monitoring.svc:9090
  github_app_dir: ""              # gitops_pr 使用的 GitHub App：app-id、installation-id、slug、private-key.pem
  max_concurrent: 4
  admission_self_check_interval: 1m  # 周期性准入自检的间隔，1s 到 1h（ADR 0024）
```

策略文件（`contract/gateway/v1/gateway-policy.schema.json`）与审批人公钥（`approver-keys.schema.json`）来自 Git，经 ConfigMap 挂载，每 15 秒重新读取；加载失败时保留上一次的内容，条件 `PolicyLoaded` 为 False。审批人的通行密钥只经 Git 登记在公钥文件中，每个凭据声明 `alg`：`EdDSA`（Ed25519 公钥 32 字节）或 `ES256`（P-256 未压缩点 65 字节，用于 iCloud 钥匙串、Windows Hello 等平台通行密钥）；签名算法只取自这里，见 ADR 0020。

```yaml
version: 1
webauthn:
  rp_id: console.srenautix.example
  origins: ["https://console.srenautix.example"]
keys:
  - {use: service, key_id: service-2026-10, public_key: <Ed25519 公钥 base64url>}
  - {use: webauthn, credential_id: <凭据 ID base64url>, principal: "oidc:alice@example.org", alg: ES256, public_key: <0x04‖X‖Y 的 base64url>}
```

## 只提议

以下任一条件成立时，gateway 不认领新工单，心跳上报 `propose_only=true`，中心在所有页面上显示该集群"仅提议"：

| 条件 | 判定 |
|---|---|
| `AdmissionSelfCheck` | 为每个启用的准入策略提交一次带 `srenautix.io/admission-probe=<短名>` 的 `dryRun=All` ActionExecution，必须被该策略拒绝。每次执行前、启动时、启用的策略集合变化时立即探测；其余时间每 `admission_self_check_interval`（默认 1 分钟）一次，上一次失败后每 15 秒一次（ADR 0024） |
| `Freeze` | `srenautix-freeze` 缺失，或 `data.frozen` 不是 `"false"` |
| `AuditSink` | 最近一次写入或探测审计汇失败 |
| `ClockSkew` | 与 apiserver 的偏差超过 5 秒 |
| `ApiserverThrottled` | 1 分钟内收到过 429 |
| `PolicyLoaded` | 策略或公钥加载失败 |

已开始的执行不受影响：校验、撤销与审计照常完成，审计记录留在本地暂存，审计汇恢复后补写。

## 熔断开关

硬停止只能修改 `srenautix-freeze`（kubectl 或 GitOps），它不依赖 gateway 进程：

```bash
kubectl -n srenautix patch configmap srenautix-freeze --type merge -p '{"data":{"frozen":"true"}}'
```

准入策略以 `paramRef` 引用该 ConfigMap，`parameterNotFoundAction: Deny`：ConfigMap 被删除时 gateway 的全部写入同样被拒绝。gateway 自己的 ActionExecution 在冻结时仍可写入。

## 执行状态

```bash
kubectl -n srenautix get actionexecutions
kubectl -n srenautix get ae <执行 ID> -o yaml
```

`status.history` 是每次阶段迁移，带审计链记录的 `seq` 与哈希；`status.pushedSeq` 是中心已确认的事件序号。阶段的含义见 ADR 0022。被 gateway 修改的对象带注解 `srenautix.io/execution-id`；SreNautix 做的 cordon 另带 `srenautix.io/cordoned-by`，`node_uncordon` 只解除带这个注解的 cordon。

需要人处理的情况：

| 阶段 | 处理 |
|---|---|
| `needs_human` | 不可逆动作校验失败、撤销失败、或副作用部分生效；按 `status.message` 与 `status.verification` 检查目标 |
| `indeterminate` | 分步动作中断时只完成一部分（例如逐个驱逐），或无法观察结果 |
| `awaiting_compensation_approval` | compensable 动作校验失败，`status.compensation` 是建议的补偿动作，在控制台重新审批 |

指标 `srenautix_gateway_needs_human` 是这两类执行的数量，由所在集群的 Alertmanager 告警，不依赖中心。

## 执行审计链

- 每条记录：`seq`、`prev_hash`、`hash = sha256(JCS(去掉 hash 的记录))`（`contract/gateway/v1/audit-record.schema.json`）。类型 `phase` 是阶段迁移，`write` 是一次 Kubernetes 或 Git 写入（带 `attempt_id`、目标与审批人，与 apiserver 审计日志关联），`checkpoint` 每 100 条一次，以 Ed25519 签名覆盖之前的链头。
- 先追加到本地暂存（每条 fsync），再以 JSONL 对象写入审计汇：`execution/<cluster_id>/<首条 seq>-<末条 seq>.jsonl`，对象锁定保留期为 `retention_days`。
- 启动时要求存储桶已开启对象锁定。暂存卷丢失时从审计汇最后一条记录继续。

## 指标

| 指标 | 说明 |
|---|---|
| `srenautix_build_info{role="gateway",version}` | 版本 |
| `srenautix_condition{role="gateway",type}` | 状态条件，1 表示该项正常；`ApiserverThrottled`、`Freeze` 为 1 表示正在限流、处于冻结。chart 的自身告警按 `deploy/helm/srenautix/files/conditions.yaml` 的方向判断 |
| `srenautix_admission_selfcheck_ok` | 全部探针被拒绝时为 1。探针在 `apiserver_request_total` 中带 `dry_run="All"`，准入拒绝类告警用 `dry_run=""` 排除它们 |
| `srenautix_gateway_frozen` | 处于冻结时为 1 |
| `srenautix_gateway_propose_only` | 只提议时为 1 |
| `srenautix_gateway_executions_total{action,phase}` | 进入各阶段的次数 |
| `srenautix_gateway_needs_human` | `needs_human` 与 `indeterminate` 的执行数 |
| `srenautix_gateway_tickets_rejected_total{reason}` | 入队前被拒绝的工单 |
| `srenautix_gateway_queue_depth` | 冲突域队列中等待的执行 |
| `srenautix_gateway_verify_checks_total{action,kind,result}` | 执行后校验的检查结果 |
| `srenautix_audit_export_lag_seconds{chain="execution"}` | 最早一条未写入审计汇的记录的时长 |
| `srenautix_clock_skew_seconds{peer="apiserver"}` | 本地时间减 apiserver 时间 |

## 准入策略与 RBAC

由动作目录生成（`make gateway-generate`，输出 `deploy/helm/srenautix/files/admission/`），chart 按启用的动作挑选并绑定。启用 `workflow_submit` 时，用 Git 中的 gateway 策略生成模板白名单策略：

```bash
srenautix-spoke admission workflow-allowlist --policy=policy.yaml > workflow-allowlist.yaml
```

## gitops_pr

- 只在启用了 GitHub App（`gateway.github_app_dir`）且策略列出仓库与路径白名单时可用；首次使用前核对 App 的 slug。
- 每 15 秒探测白名单中每个仓库 base 分支的分支保护，条件 `GitHubBranchProtection`；没有分支保护时预检 `branch_protection` 拒绝执行。
- 只推送 `srenautix/<执行 ID>` 分支并开 PR，从不合并；断言的 `target_uid` 是被批准时 base 分支的提交 SHA。

## 测试

```bash
make envtest-assets
export SRENAUTIX_TEST_BIN=<含 prometheus 的目录> SRENAUTIX_MINIO_BIN=<minio 可执行文件>
make go-test
```

不变量测试与 Kind 入口见 `test/invariants/README.md`。

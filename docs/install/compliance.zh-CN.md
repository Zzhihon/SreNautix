# 合规配置

合规配置在标准配置之上提高强度（DESIGN §1.3、§16.3、§16.5），面向等保与国内私有化部署。chart 在渲染时检查下列要求，任何一项不满足都直接失败。

| 要求 | values | chart 的检查 |
|---|---|---|
| 三权分立：admin 拆成 sys-admin 与 security-admin | `governance.separationOfDuties: true` | 不允许关闭 |
| H 档审批必须用通行密钥 | `governance.requirePasskey: true` | 不允许关闭 |
| 提议人不能审批自己的提议 | `governance.allowSelfApproval: false` | 不允许打开 |
| 审计写入 WORM | `audit.sink: minio` 或 `s3`，`audit.objectLock.mode: COMPLIANCE`，`retentionDays ≥ 180` | 不允许写入 PG，不允许 GOVERNANCE 模式 |
| 专用节点池 | `global.nodeSelector` 与 `global.tolerations` 非空 | 两项都必须设置 |
| 镜像签名校验 | `imagePolicy.enabled: true`（policy-controller 的 ClusterImagePolicy） | 不允许关闭 |
| gateway 与 PG 分开调度 | `roles.gateway.pgAntiAffinity: required` | 预设值 |

## 前提

- 标准配置的全部前提。
- 带污点的专用节点池，例如节点标签 `srenautix.io/pool=srenautix`、污点 `srenautix.io/pool=srenautix:NoSchedule`。PG 至少需要 2 个节点（实例之间 required 反亲和），gateway 与 PG 实例不在同一节点。
- [policy-controller](https://docs.sigstore.dev/policy-controller/overview/) 已安装，并对 `srenautix` 命名空间开启校验（命名空间标签 `policy.sigstore.dev/include=true`）。
- 控制台从外部可访问并配置 TLS，WebAuthn 依赖这一点（DESIGN §13）。

## 安装

```bash
kubectl create namespace srenautix
kubectl label namespace srenautix policy.sigstore.dev/include=true
helm install srenautix oci://ghcr.io/zzhihon/charts/srenautix --version <版本> -n srenautix \
  -f values-compliance.yaml -f my-values.yaml
```

`values-compliance.yaml` 中的节点池标签与污点按实际节点池修改。`my-values.yaml` 的内容同标准配置；`publicUrl` 必须是控制台的外部 https 地址。

## 镜像签名策略

ClusterImagePolicy 要求两个 SreNautix 镜像带有发布工作流的无密钥签名：

- 签发者：`https://token.actions.githubusercontent.com`
- 证书主体：`^https://github\.com/Zzhihon/SreNautix/\.github/workflows/image\.yml@refs/(heads/main|tags/v.+)$`

只允许 tag 上的发布时，把 `imagePolicy.subjectRegExp` 改成只匹配 `refs/tags/v.+`。隔离网络中使用私有 Sigstore 或离线信任根时，修改 ClusterImagePolicy 的 `authorities`，见 [offline.zh-CN.md](offline.zh-CN.md)。

## 审计保留

COMPLIANCE 模式的对象锁在保留期内任何账号都无法删除或覆盖对象，包括 MinIO 管理员。server 与 gateway 的写入账号只有写入与读取权限。`srenautix audit verify` 校验两条链，见 `docs/server/audit.md`。

## 国内环境

- 模型路由默认禁用出境路由（DESIGN §8.1），worker 的路由配置写明 `in_domain`。
- 麒麟（Kylin）基础镜像与 SM2/SM3 检查点签名属于合规配置的扩展项，按 DESIGN 附录 B 第 9 步提供。

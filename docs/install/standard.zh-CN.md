# 标准配置

标准配置在观察模式之上加入 reader、gateway 与审计用的 MinIO，适合 2–50 人的团队（DESIGN §1.3）。gateway 默认冻结：只提议、不执行。

## 部署内容

| 组件 | 说明 |
|---|---|
| server、worker | 同观察模式；server 另外签发 L 档审批断言 |
| reader | 本集群只读（不含 Secret），推送拓扑与对账结果 |
| gateway | 本集群唯一的写身份；单副本、Recreate；与 PG 实例默认 preferred 反亲和 |
| ValidatingAdmissionPolicy | 由动作目录生成（`files/admission/`，见 ADR 0023），每个策略一个 Binding，`paramRef` 指向 `srenautix-freeze`；另有一条兜底策略 |
| `srenautix-freeze` | 熔断开关 ConfigMap，`frozen: "true"` 时 gateway 的写入全部被准入拒绝 |
| MinIO | 单实例，存储桶开启对象锁，默认 GOVERNANCE 模式保留 180 天 |
| PostgreSQL | CNPG Cluster，2 个实例，同步复制 preferred |

## 前提

- Kubernetes ≥1.30（ValidatingAdmissionPolicy GA）。
- CNPG operator，或外部 PostgreSQL 16+。
- 服务签名密钥 Secret（键 `private.pem`、`public.pem`，生成方法见 [README.zh-CN.md](README.zh-CN.md)）。

## 安装

```bash
kubectl create namespace srenautix
helm install srenautix oci://ghcr.io/zzhihon/charts/srenautix --version <版本> -n srenautix \
  -f values-standard.yaml -f my-values.yaml
```

`values-standard.yaml` 随 chart 发布，可以用 `helm show values` 之外的方式取出：`helm pull oci://ghcr.io/zzhihon/charts/srenautix --version <版本> --untar`。`my-values.yaml` 至少包含：

```yaml
clusterId: prod
datasources:
  prometheus: {url: http://prometheus-operated.monitoring.svc:9090}
  alertmanager: {url: http://alertmanager-operated.monitoring.svc:9093}
secrets:
  llm: {existingSecret: srenautix-llm}
  serviceSigningKey: {existingSecret: srenautix-service-signing}
identity:
  localAdmin:
    existingSecret: srenautix-local-admin   # 键 password_hash、totp_secret
  oidc:
    enabled: true
    issuer: https://sso.example.com
    clientId: srenautix
    existingSecret: srenautix-oidc          # 键 client_secret
roles:
  gateway:
    actions: [node_cordon, node_uncordon, workload_scale, rollout_pause, rollout_resume, pod_restart]
```

## 启用的动作

`roles.gateway.actions` 决定 gateway 的 ClusterRole 规则与安装的准入策略，必须是动作目录（`contract/gateway/v1/action-catalog.yaml`）中的动作。chart 渲染时拒绝任何涉及 Secret、ServiceAccount token、RBAC、准入配置或通配符的规则。命名空间范围、自动执行与审批人作用域写在 Git 管理的 gateway 策略中。

## 解除冻结

熔断开关只能用 kubectl 或 GitOps 修改，控制台只显示状态：

```bash
kubectl -n srenautix patch configmap srenautix-freeze --type merge -p '{"data":{"frozen":"false"}}'
```

重新冻结时把值改回 `"true"`。删除这个 ConfigMap 同样让所有写入被拒绝（`parameterNotFoundAction: Deny`）。用 Helm 管理时设置 `freeze.frozen=false` 后升级。

## 网络策略

chart 为每个角色生成 NetworkPolicy：worker 只能访问模型端点、数据源、server 与 PG；server 只能访问 PG、数据源、聊天渠道与审计汇；gateway 只能访问 apiserver、server 与审计汇。地址范围用 `networkPolicy.*EgressTo` 收紧；Cilium 环境下设置 `networkPolicy.cilium.enabled=true` 与 `modelFQDNs`，worker 的模型出站按 FQDN 限制。

## 自身监控

```yaml
selfMonitoring:
  serviceMonitor: {enabled: true}
  prometheusRule: {enabled: true}
  dashboard: {enabled: true}
  receiver: platform-oncall        # SreNautix 以外的接收方
  routeLabels: {team: platform}
```

每条自身告警都带 `srenautix_self="true"` 与 `routeLabels`。chart 校验 `receiver` 不能是 SreNautix 自己的接收方，`alertmanagerConfig.selfReceiverSpec` 的 webhook 也不能指向 SreNautix server。看板 `SreNautix / 自身健康` 通过 Grafana sidecar 加载。

## 资源与调度

| 选项 | 说明 |
|---|---|
| `priorityClass.create`、`priorityClass.value` | 默认不设置 PriorityClass；取值不要高于集群中已有的运维组件 |
| `resourceQuota.enabled` | 为命名空间创建 ResourceQuota |
| `global.nodeSelector`、`global.tolerations` | 对所有角色、PG、MinIO 生效 |
| `roles.<角色>.affinity`、`topologySpreadConstraints` | 角色自己的调度设置 |
| `roles.gateway.pgAntiAffinity` | `preferred`（默认）、`required`、`none` |

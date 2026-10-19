# 观察模式：1 小时内拿到成绩单

观察模式只部署 server、worker 与 PostgreSQL，不部署 gateway，不做任何写操作。安装后 server 用 kube-state-metrics 重建过去 14 天的拓扑，回放 `ALERTS` 历史，按 `reconstructed` 模式给出成绩单（DESIGN §14.5），之后每个新事件都出阶段 A 与阶段 B。

## 前提

| 项 | 要求 |
|---|---|
| Kubernetes | ≥1.27 |
| PostgreSQL | 已安装 CNPG operator；或外部 PostgreSQL 16+（见下文"外部 PostgreSQL"） |
| 指标 | Prometheus 兼容的查询端点，保留期 ≥14 天，含 kube-state-metrics 与 `ALERTS` |
| 模型 | 一个 OpenAI 兼容的端点与密钥 |
| 资源 | server 200m/512Mi，worker 200m/1Gi，PostgreSQL 每实例 250m/1Gi（2 个实例） |

## 步骤

1. 创建命名空间与模型密钥：

   ```bash
   kubectl create namespace srenautix
   kubectl -n srenautix create secret generic srenautix-llm --from-literal=api_key=<模型密钥>
   ```

2. 写一份最小的 values（`my-values.yaml`）：

   ```yaml
   profile: observe
   clusterId: prod
   datasources:
     prometheus:
       url: http://prometheus-operated.monitoring.svc:9090
     alertmanager:
       url: http://alertmanager-operated.monitoring.svc:9093
   secrets:
     llm: {existingSecret: srenautix-llm}
   roles:
     worker:
       config:
         # worker 的模型路由，键见 docs/worker/
         llm:
           routes:
             - id: primary
               base_url: https://api.example.com/v1
               model: example-model
               api_key_file: /etc/srenautix/secrets/llm/api_key
   ```

3. 安装：

   ```bash
   helm install srenautix oci://ghcr.io/zzhihon/charts/srenautix \
     --version <版本> -n srenautix -f my-values.yaml
   ```

   等价的最短写法是 `--set profile=observe` 加上数据源与密钥；未设置的开关按 profile 取默认值。

4. 把 Alertmanager 的告警发给 SreNautix：在 Alertmanager 中加一个 webhook 接收方，地址与 token 见 `helm status srenautix` 的输出。使用 prometheus-operator 时设置 `alertmanagerConfig.enabled=true`（需要同时设置 `selfMonitoring.receiver` 与 `alertmanagerConfig.selfReceiverSpec`）。

5. 打开控制台：`kubectl -n srenautix port-forward svc/srenautix-server 8080:8080`，访问 `http://127.0.0.1:8080`。首次登录使用本地管理员（见 [README.zh-CN.md](README.zh-CN.md) 与 `docs/server/identity.md`）。成绩单在"回放与评测"页。

## 外部 PostgreSQL

```yaml
database:
  mode: external
  external:
    host: pg.example.internal
    sslmode: verify-full
    caSecret: srenautix-pg-ca            # 键 ca.crt
    passwordSecrets:
      server: srenautix-pg-server        # 键 password
      worker: srenautix-pg-worker
      mcp: srenautix-pg-mcp
    adminSecret: srenautix-pg-admin      # 键 username、password；chart 用它运行 db bootstrap Job
```

不提供 `adminSecret` 时，由数据库管理员手动执行一次初始化（可重复执行），之后 chart 只用三个库角色连接：

```bash
PGHOST=… PGDATABASE=srenautix PGUSER=postgres \
  node /app/apps/srenautix/dist/main.js db bootstrap --admin-password-file=<文件>
```

## 观察模式的审计

观察模式没有执行链，治理审计链写入 PG 的独立表，控制台持续显示这一风险。需要对象存储时设置 `audit.sink=minio` 或 `audit.sink=s3`。

## 升级到标准配置

`helm upgrade` 时改用 `values-standard.yaml` 的设置（或 `--set profile=standard`），并提供服务签名密钥，见 [standard.zh-CN.md](standard.zh-CN.md)。

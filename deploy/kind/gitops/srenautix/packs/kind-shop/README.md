# kind-shop 领域包

shop 的组件类型（`components.yaml`）、告警目录条目（`alerts.yaml`）与用户请求的影响卡（`signals.yaml`、`chains.yaml`、`tests/`），由 packs 维护。`install-srenautix.sh` 把本目录做成 ConfigMap `kind-shop`（键为文件名，子目录中的文件为 `<子目录>__<文件名>`），由 chart 的 `packs.userConfigMaps` 挂载。

影响卡 `traffic/client-errors` 读外部客户端 `traffic/loadgen`（`deploy/kind/workloads/background.yaml`）经 web 访问 api 的请求计数 `shop_client_requests_total`，挂在这条请求路径上的 web 与 api。shop 是 nginx，没有请求指标；没有影响卡时处置推导无法确认"用户没有受影响"，告警调优场景 alert-too-sensitive 得不出 ignore（ADR 0139）。`packages/packs-sdk/test/kind-shop-pack.test.ts` 把本包与内置包一起编译并在 Prometheus 与 VictoriaMetrics 上执行夹具。

# kind-shop 领域包

shop 的组件类型（`components.yaml`）与告警目录条目（`alerts.yaml`），由 packs 维护。`install-srenautix.sh` 把本目录做成 ConfigMap `kind-shop`（键为文件名），由 chart 的 `packs.userConfigMaps` 挂载。

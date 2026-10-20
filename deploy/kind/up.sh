#!/usr/bin/env bash
# 一条命令拉起 Kind 体验环境：Kind 集群（Kubernetes 1.35，1 控制面 + 3 工作节点）、kube-prometheus-stack、
# Loki、Tempo、Alloy、metrics-server、CNPG operator、演示业务 shop 与背景噪声，以及 SreNautix（standard 配置，gateway 冻结）。
#
# 用法：deploy/kind/up.sh [--no-srenautix]
# 环境变量：
#   CLUSTER_NAME          Kind 集群名，默认 srenautix
#   SRENAUTIX_CHART       chart 来源，默认本仓库的 deploy/helm/srenautix；也可以是 oci://ghcr.io/zzhihon/charts/srenautix
#   SRENAUTIX_VERSION     镜像标签（chart 的 appVersion 之外的版本，例如 sha-<提交>）；为空时用 chart 的 appVersion
#   SRENAUTIX_LLM_SECRET  已存在的模型密钥文件（键 api_key 的内容）；为空时 worker 不配置模型路由，只出阶段 A
# 依赖：docker、kind、kubectl、helm（≥3.8）、jq、yq
set -euo pipefail
# shellcheck source=deploy/kind/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

with_srenautix=true
[[ "${1:-}" == "--no-srenautix" ]] && with_srenautix=false

require docker kind kubectl helm jq yq

if kind get clusters | grep -qx "$CLUSTER_NAME"; then
  log "Kind 集群 $CLUSTER_NAME 已存在，沿用"
else
  log "创建 Kind 集群 ${CLUSTER_NAME}（${KIND_NODE_IMAGE}）"
  kind create cluster --name "$CLUSTER_NAME" --image "$KIND_NODE_IMAGE" --config "$KIND_DIR/kind-config.yaml" --wait 180s
fi

log "添加 Helm 仓库"
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts --force-update >/dev/null
helm repo add grafana https://grafana.github.io/helm-charts --force-update >/dev/null
helm repo add metrics-server https://kubernetes-sigs.github.io/metrics-server/ --force-update >/dev/null
helm repo add cnpg https://cloudnative-pg.github.io/charts --force-update >/dev/null
helm repo update >/dev/null

hi() {
  local release=$1 chart=$2 version=$3 ns=$4 values=$5
  log "安装 ${release}（${chart} ${version}）"
  helm --kube-context "$KUBE_CONTEXT" upgrade --install "$release" "$chart" --version "$version" \
    --namespace "$ns" --create-namespace -f "$KIND_DIR/values/$values" --wait --timeout 15m
}

hi kps prometheus-community/kube-prometheus-stack "$KPS_CHART_VERSION" monitoring kube-prometheus-stack.yaml
hi loki grafana/loki "$LOKI_CHART_VERSION" monitoring loki.yaml
hi tempo grafana/tempo "$TEMPO_CHART_VERSION" monitoring tempo.yaml
hi alloy grafana/alloy "$ALLOY_CHART_VERSION" monitoring alloy.yaml
hi metrics-server metrics-server/metrics-server "$METRICS_SERVER_CHART_VERSION" kube-system metrics-server.yaml
log "安装 CNPG operator（cloudnative-pg ${CNPG_CHART_VERSION}）"
helm --kube-context "$KUBE_CONTEXT" upgrade --install cnpg cnpg/cloudnative-pg --version "$CNPG_CHART_VERSION" \
  --namespace cnpg-system --create-namespace -f "$KIND_DIR/values/cloudnative-pg.yaml" --wait --timeout 10m

log "部署演示业务 shop 与背景噪声"
k apply -k "$KIND_DIR/workloads"
wait_namespace_ready shop 900
wait_namespace_ready traffic 300

if $with_srenautix; then
  "$KIND_DIR/install-srenautix.sh"
fi
check_platform_zone

log "完成。Grafana：kubectl --context $KUBE_CONTEXT -n monitoring port-forward svc/kps-grafana 3000:80（admin / srenautix-kind）"
log "故障场景：deploy/kind/scenario.sh list；deploy/kind/scenario.sh run <场景>"

# Kind 环境脚本共用的函数，由 up.sh、down.sh、scenario.sh 与各场景脚本 source。
# shellcheck shell=bash

KIND_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck disable=SC2034 # 由 source 本文件的脚本使用
REPO_ROOT=$(cd "$KIND_DIR/../.." && pwd)
CLUSTER_NAME=${CLUSTER_NAME:-srenautix}
KUBE_CONTEXT="kind-${CLUSTER_NAME}"
# shellcheck source=deploy/kind/versions.env
source "$KIND_DIR/versions.env"

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
die() { log "错误：$*"; exit 1; }

k() { kubectl --context "$KUBE_CONTEXT" "$@"; }

require() {
  local missing=()
  for tool in "$@"; do
    command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
  done
  ((${#missing[@]} == 0)) || die "缺少命令：${missing[*]}"
}

# images/kustomization.yaml 中某个短名对应的完整镜像引用（仓库@digest）
image_ref() {
  local name=$1
  yq -e ".images[] | select(.name == \"$name\") | .newName + \"@\" + .digest" "$KIND_DIR/images/kustomization.yaml"
}

# 经 apiserver 的 Service 代理执行 PromQL 即时查询，输出 JSON（不依赖集群 DNS）
prom_query() {
  local q=$1
  k get --raw "/api/v1/namespaces/monitoring/services/kps-prometheus:9090/proxy/api/v1/query?query=$(jq -rn --arg q "$q" '$q|@uri')"
}

# 等待指定告警出现在 ALERTS 中（pending 或 firing）；参数：超时秒数 告警名...
wait_alerts() {
  local timeout=$1
  shift
  local deadline=$((SECONDS + timeout)) name state
  for name in "$@"; do
    while true; do
      state=$(prom_query "ALERTS{alertname=\"$name\"}" | jq -r '[.data.result[].metric.alertstate] | unique | join(",")')
      if [[ -n "$state" ]]; then
        log "告警 ${name} 已出现（${state}）"
        break
      fi
      ((SECONDS < deadline)) || die "等待告警 $name 超时（${timeout}s）"
      sleep 10
    done
  done
}

# 等待命名空间内全部 Deployment 与 StatefulSet 就绪
wait_namespace_ready() {
  local ns=$1 timeout=${2:-600} obj
  for obj in $(k -n "$ns" get deployment,statefulset -o name); do
    k -n "$ns" rollout status "$obj" --timeout="${timeout}s"
  done
}

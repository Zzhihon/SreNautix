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

# 等待 Deployment 按当前 spec 完成发布：控制器已观察到最新 generation，全部副本已更新且可用，没有多余的旧副本。
# 不用 kubectl rollout status：发布超过 progressDeadlineSeconds 之后回退到已有的 ReplicaSet 时，Progressing 条件在
# 新的进展出现之前仍是 ProgressDeadlineExceeded，rollout status 会立即失败。参数：命名空间 名称 [超时秒数，默认 600]
wait_deployment_rolled_out() {
  local ns=$1 name=$2 timeout=${3:-600} deadline st
  deadline=$((SECONDS + timeout))
  while true; do
    st=$(k -n "$ns" get deployment "$name" -o json | jq -c '{gen: .metadata.generation, obs: (.status.observedGeneration // 0),
      want: (.spec.replicas // 1), replicas: (.status.replicas // 0), updated: (.status.updatedReplicas // 0),
      available: (.status.availableReplicas // 0)}')
    jq -e '.obs >= .gen and .updated == .want and .available == .want and .replicas == .want' <<<"$st" >/dev/null && break
    ((SECONDS < deadline)) || die "deployment ${ns}/${name} 在 ${timeout}s 内没有完成发布：${st}"
    sleep 5
  done
  log "deployment ${ns}/${name} 已完成发布"
}

# 等待命名空间内全部 Deployment 与 StatefulSet 就绪
wait_namespace_ready() {
  local ns=$1 timeout=${2:-600} obj
  for obj in $(k -n "$ns" get deployment,statefulset -o name); do
    k -n "$ns" rollout status "$obj" --timeout="${timeout}s"
  done
}

# 等待 Argo CD 应用同步完成且健康；参数：应用名 超时秒数
wait_argo_synced() {
  local app=$1 timeout=${2:-600} deadline=$((SECONDS + ${2:-600})) state
  until state=$(k -n argocd get application "$app" -o jsonpath='{.status.sync.status}/{.status.health.status}' 2>/dev/null) &&
    [[ "$state" == Synced/Healthy ]]; do
    ((SECONDS < deadline)) || die "Argo CD 应用 $app 在 ${timeout}s 内没有同步完成（${state:-无状态}）"
    sleep 5
  done
  log "Argo CD 应用 ${app}：${state}"
}

# 以人工身份（gitlocal 的管理员令牌）向 kind/gitops 的 main 提交文件，输出新提交；参数：提交说明 路径=本地文件...
# 场景中的发布、回退与人工修改都走这里，SreNautix 只能向 srenautix/* 分支推送
gitops_commit() {
  local message=$1
  shift
  local files='{}' spec path src
  for spec in "$@"; do
    path=${spec%%=*}
    src=${spec#*=}
    files=$(jq --arg p "$path" --rawfile c "$src" '.[$p] = $c' <<<"$files")
  done
  jq -n --arg m "$message" --argjson f "$files" '{branch: "main", files: $f, message: $m}' |
    gitlocal_api POST /_test/repos/kind/gitops/push | jq -r .sha
}

# 以人工身份修改 kind/gitops 的 main 上的一个 YAML 文件（yq 表达式作用于文件中的每个文档），等 Argo CD 同步完成；
# 参数：提交说明 路径 yq表达式 Argo应用名。shop 由 Argo CD 管理：直接 kubectl patch 会在下一次同步时被 Git 中的内容覆盖
gitops_edit() {
  local message=$1 path=$2 expr=$3 app=$4 tmp
  tmp=$(mktemp "${SCENARIO_STATE_DIR:-${TMPDIR:-/tmp}}/gitops-edit.XXXXXX")
  gitops_file main "$path" | yq "$expr" >"$tmp"
  gitops_commit "$message" "$path=$tmp" >/dev/null
  rm -f "$tmp"
  k -n argocd annotate application "$app" argocd.argoproj.io/refresh=normal --overwrite >/dev/null
  wait_argo_synced_to_main "$app" 300
}

# 等待 Argo CD 应用同步到 kind/gitops 的 main 的最新提交；参数：应用名 超时秒数
wait_argo_synced_to_main() {
  local app=$1 timeout=${2:-300} deadline=$((SECONDS + ${2:-300})) head synced
  head=$(gitlocal_api GET /_test/repos/kind/gitops/refs | jq -r .main)
  until synced=$(k -n argocd get application "$app" -o jsonpath='{.status.sync.revision}' 2>/dev/null) && [[ "$synced" == "$head" ]]; do
    ((SECONDS < deadline)) || die "Argo CD 应用 $app 在 ${timeout}s 内没有同步到 ${head}（当前 ${synced:-无}）"
    sleep 5
  done
  log "Argo CD 应用 $app 已同步到 ${head:0:7}"
}

# 调用 gitlocal 的接口（经 apiserver 的 Service 代理，不依赖集群 DNS）；参数：方法 路径，请求体从标准输入读取
gitlocal_api() {
  local method=$1 path=$2
  if [[ "$method" == GET ]]; then
    k get --raw "/api/v1/namespaces/gitlocal/services/gitlocal:3000/proxy${path}"
  else
    k create --raw "/api/v1/namespaces/gitlocal/services/gitlocal:3000/proxy${path}" -f - 2>/dev/null ||
      die "gitlocal ${method} ${path} 失败"
  fi
}

# 读取 kind/gitops 某个提交上的文件；参数：提交或分支 路径
gitops_file() {
  local ref=$1 path=$2 sha
  sha=$(gitlocal_api GET /_test/repos/kind/gitops/refs | jq -r --arg r "$ref" '.[$r] // $r')
  gitlocal_api GET "/_test/repos/kind/gitops/file?sha=${sha}&path=$(jq -rn --arg p "$path" '$p|@uri')"
}

# 监控、CNPG、Argo CD、gitlocal 与 SreNautix 的 Pod（DaemonSet 除外）必须都在 zone a；节点 NotReady 场景停止 zone b 的节点
check_platform_zone() {
  local zone_a stray
  zone_a=$(k get nodes -l srenautix.io/zone=a -o jsonpath='{.items[*].metadata.name}')
  [[ -n "$zone_a" ]] || die "没有 srenautix.io/zone=a 的节点"
  stray=$(k get pods -A -o json | jq -r --arg zone_a "$zone_a" '
    ($zone_a | split(" ")) as $a | .items[] |
    select(.metadata.namespace | IN("monitoring", "srenautix", "cnpg-system", "argocd", "gitlocal")) |
    select((.metadata.ownerReferences[0].kind // "") != "DaemonSet") |
    select(.spec.nodeName != null and (.spec.nodeName | IN($a[]) | not)) |
    "\(.metadata.namespace)/\(.metadata.name)@\(.spec.nodeName)"')
  [[ -z "$stray" ]] || die "以下监控或 SreNautix 的 Pod 不在 zone a，节点故障场景会让监控失明：$(echo "$stray" | paste -sd ' ' -)"
}

#!/usr/bin/env bash
# 用真实的 kube-apiserver 校验 chart：对每份 values 渲染后执行 kubectl apply --dry-run=server。
# 准入策略的 resourceRules、CEL 表达式等只有 apiserver 才会完整校验，kubeconform 只校验 schema。
# 集群里没有对应 API 的资源（CNPG Cluster、prometheus-operator、policy-controller、Cilium）跳过；chart 自带的 CRD 先安装。
#
# 用法：deploy/helm/server-dry-run.sh [chart 目录]；需要 helm、kubectl、yq、jq，当前 kubectl 上下文指向一个 ≥1.30 的集群。
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
chart_dir=${1:-"$repo_root/deploy/helm/srenautix"}
out_dir="$repo_root/.scratch/helm-dry-run"
mkdir -p "$out_dir"
ns=srenautix
kube_version=$(kubectl version -o json | jq -r '.serverVersion.gitVersion')

kubectl create namespace "$ns" --dry-run=client -o yaml | kubectl apply -f -
if [[ -d "$chart_dir/crds" ]]; then
  kubectl apply --server-side -f "$chart_dir/crds"
  kubectl wait --for=condition=Established -f "$chart_dir/crds" --timeout=60s
fi

# apiVersion 与 kind 是否由集群提供（读取发现文档）
declare -A discovery=()
served() {
  local api=$1 kind=$2 path
  if [[ "$api" == */* ]]; then path="/apis/$api"; else path="/api/$api"; fi
  if [[ -z "${discovery[$path]+x}" ]]; then
    discovery[$path]=$(kubectl get --raw "$path" 2>/dev/null || echo '{"resources":[]}')
  fi
  jq -e --arg k "$kind" '[.resources[] | select(.kind == $k and (.name | contains("/") | not))] | length > 0' \
    <<<"${discovery[$path]}" >/dev/null
}

values_files=(values-observe.yaml values-standard.yaml values-compliance.yaml)
while IFS= read -r f; do
  values_files+=("ci/$(basename "$f")")
done < <(find "$chart_dir/ci" -maxdepth 1 -name '*.yaml' | sort)

for f in "${values_files[@]}"; do
  name=$(basename "$f" .yaml)
  echo "==> $f"
  helm template ci "$chart_dir" --namespace "$ns" --kube-version "$kube_version" \
    -f "$chart_dir/ci/base/required.yaml" -f "$chart_dir/$f" >"$out_dir/$name.yaml"
  : >"$out_dir/$name.apply.yaml"
  skipped=()
  applied=0
  while IFS=$'\t' read -r idx api kind; do
    if served "$api" "$kind"; then
      yq "select(documentIndex == $idx)" "$out_dir/$name.yaml" >>"$out_dir/$name.apply.yaml"
      echo "---" >>"$out_dir/$name.apply.yaml"
      applied=$((applied + 1))
    else
      skipped+=("$kind")
    fi
  done < <(yq -r 'select(.kind != null) | [documentIndex, .apiVersion, .kind] | @tsv' "$out_dir/$name.yaml")
  if ((${#skipped[@]} > 0)); then
    echo "跳过集群中没有 API 的资源：$(printf '%s\n' "${skipped[@]}" | sort -u | tr '\n' ' ')"
  fi
  kubectl apply --dry-run=server -n "$ns" -f "$out_dir/$name.apply.yaml" >/dev/null
  echo "通过：${applied} 个资源"
done

#!/usr/bin/env bash
# chart 的离线检查：对每份 values 执行 helm lint、渲染并用 kubeconform 校验 schema，最后运行 helm-unittest。
# 用法：deploy/helm/check.sh [chart 目录]；需要 helm（含 unittest 插件）、kubeconform、yq 与 promtool。
#
# gateway 的准入策略与 RBAC 来自 internal/spoke/gateway/admission 生成器写入的 files/admission/。
# 生成结果存在时检查全部配置；不存在时只检查不含 gateway 的配置，并输出 GitHub Actions 警告。
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
chart_dir=${1:-"$repo_root/deploy/helm/srenautix"}
kube_version=${KUBE_VERSION:-1.34.12}
# CRD schema 目录按提交固定
crd_catalog=${CRD_CATALOG:-"https://raw.githubusercontent.com/datreeio/CRDs-catalog/501527ab9c40c827144c8f45945b25a023e344ce/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json"}
out_dir="$repo_root/.scratch/helm-check"
mkdir -p "$out_dir"

if [[ -f "$chart_dir/files/admission/index.yaml" ]]; then
  with_gateway=true
  values_files=(values-observe.yaml values-standard.yaml values-compliance.yaml)
  while IFS= read -r f; do
    values_files+=("ci/$(basename "$f")")
  done < <(find "$chart_dir/ci" -maxdepth 1 -name '*.yaml' | sort)
  test_globs=(-f 'tests/*_test.yaml' -f 'tests/gateway/*_test.yaml')
else
  with_gateway=false
  echo "::warning title=gateway admission catalog missing::files/admission/index.yaml 不存在，跳过含 gateway 的配置与 tests/gateway"
  values_files=(values-observe.yaml ci/observe-minimal-values.yaml)
  test_globs=(-f 'tests/*_test.yaml')
fi

for f in "${values_files[@]}"; do
  name=$(basename "$f" .yaml)
  echo "==> $f"
  helm lint --strict --kube-version "$kube_version" "$chart_dir" -f "$chart_dir/ci/base/required.yaml" -f "$chart_dir/$f"
  helm template ci "$chart_dir" --namespace srenautix --kube-version "$kube_version" \
    -f "$chart_dir/ci/base/required.yaml" -f "$chart_dir/$f" >"$out_dir/$name.yaml"
  kubeconform -strict -summary -kubernetes-version "$kube_version" \
    -schema-location default -schema-location "$crd_catalog" "$out_dir/$name.yaml"
done

echo "==> promtool check rules（自身告警规则）"
helm template ci "$chart_dir" --namespace srenautix --kube-version "$kube_version" \
  -f "$chart_dir/ci/base/required.yaml" -f "$chart_dir/values-observe.yaml" \
  --set selfMonitoring.prometheusRule.enabled=true --set selfMonitoring.receiver=oncall \
  --set selfMonitoring.routeLabels.team=platform --show-only templates/self-monitoring.yaml |
  yq 'select(.kind == "PrometheusRule") | .spec' >"$out_dir/self-rules.yaml"
promtool check rules "$out_dir/self-rules.yaml"
if $with_gateway; then
  # standard 配置有 server、worker、reader、gateway；状态条件告警按各角色的方向（files/conditions.yaml）
  helm template ci "$chart_dir" --namespace srenautix --kube-version "$kube_version" \
    -f "$chart_dir/ci/base/required.yaml" -f "$chart_dir/values-standard.yaml" \
    --set selfMonitoring.prometheusRule.enabled=true --set selfMonitoring.receiver=oncall \
    --set selfMonitoring.routeLabels.team=platform --show-only templates/self-monitoring.yaml |
    yq 'select(.kind == "PrometheusRule") | .spec' >"$out_dir/self-rules-standard.yaml"
  promtool check rules "$out_dir/self-rules-standard.yaml"
  cp "$chart_dir/ci/rules/condition-direction.test.yaml" "$out_dir/"
  promtool test rules "$out_dir/condition-direction.test.yaml"
fi

echo "==> helm unittest, gateway=${with_gateway}"
helm unittest --strict "${test_globs[@]}" "$chart_dir"

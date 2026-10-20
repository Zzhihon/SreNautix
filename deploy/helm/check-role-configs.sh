#!/usr/bin/env bash
# 用各角色自己的配置解析代码校验 chart 渲染出的 config.yaml：
#   server、worker、mcp：apps/srenautix 的 zod schema（deploy/helm/configcheck/check.ts）
#   reader、gateway：internal/spoke 的 LoadConfig（deploy/helm/configcheck/main.go）
# 对每份要检查的 values 渲染全部角色，任何一个角色的配置不能通过解析都失败。
# 用法：deploy/helm/check-role-configs.sh；需要 helm、yq、node（工作区依赖已安装）、go。
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
chart_dir="$repo_root/deploy/helm/srenautix"
out_root="$repo_root/.scratch/role-configs"
cd "$repo_root"

# 每份 values 都打开 mcp 与 reader，使五个角色的配置都被渲染
for f in values-standard.yaml values-compliance.yaml ci/external-values.yaml ci/standard-full-values.yaml ci/oci-packs-values.yaml; do
  name=$(basename "$f" .yaml)
  dir="$out_root/$name"
  rm -rf "$dir"
  mkdir -p "$dir"
  echo "==> $f"
  helm template ci "$chart_dir" --namespace srenautix \
    -f "$chart_dir/ci/base/required.yaml" -f "$chart_dir/$f" -f "$chart_dir/ci/fixtures/mcp-values.yaml" \
    --show-only templates/role-resources.yaml >"$dir/rendered.yaml"
  for role in server worker mcp reader gateway; do
    yq "select(.kind == \"ConfigMap\" and .metadata.name == \"ci-srenautix-$role-config\") | .data[\"config.yaml\"]" \
      "$dir/rendered.yaml" >"$dir/$role.yaml"
    [[ -s "$dir/$role.yaml" ]] || { echo "没有渲染出 $role 的配置" >&2; exit 1; }
    yq -o=json "$dir/$role.yaml" >"$dir/$role.json"
  done
  node --conditions=@srenautix/source --import tsx deploy/helm/configcheck/check.ts "$dir"
  go run ./deploy/helm/configcheck "$dir"
done

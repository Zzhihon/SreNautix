#!/usr/bin/env bash
# 检查 Kind 场景与标准答案一一对应，标准答案的 truth 满足 contract/schemas/eval-case.schema.json 的 EvalTruth：
# 字段齐全、没有多余字段、根因是合法的 ComponentKey、粒度与处置判断在枚举内。
# 依赖：yq、jq
set -euo pipefail
# shellcheck source=deploy/kind/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

schema="$REPO_ROOT/contract/schemas/eval-case.schema.json"
common="$REPO_ROOT/contract/schemas/common.schema.json"
key_re=$(jq -r '."$defs".ComponentKey.pattern' "$common")
granularities=$(jq -c '."$defs".Granularity.enum' "$schema")
dispositions=$(jq -c '."$defs".Disposition.enum' "$common")
truth_keys=$(jq -c '."$defs".Truth.required | sort' "$schema")
failed=0

for dir in "$KIND_DIR"/scenarios/*/; do
  id=$(basename "$dir")
  truth_file="$REPO_ROOT/eval/scenarios/$id.yaml"
  [[ -f "$dir/scenario.sh" ]] || { log "${id}：缺少 scenario.sh"; failed=1; continue; }
  [[ -f "$truth_file" ]] || { log "${id}：缺少 eval/scenarios/${id}.yaml"; failed=1; continue; }
  errors=$(yq -o=json "$truth_file" | jq -r \
    --arg id "$id" --arg re "$key_re" --argjson gran "$granularities" --argjson disp "$dispositions" \
    --argjson keys "$truth_keys" '
    [
      (if .case_id != "scenario:\($id)" then "case_id 应为 scenario:\($id)" else empty end),
      (if .type != "scenario" then "type 应为 scenario" else empty end),
      (if .truth_source.kind != "injected" then "truth_source.kind 应为 injected" else empty end),
      (if (.truth | keys | sort) != $keys then "truth 的字段应恰好是 \($keys)" else empty end),
      (.truth.root_components[] | select(test($re) | not) | "根因 \(.) 不是合法的 ComponentKey"),
      (if (.truth.root_components | length) == 0 then "root_components 不能为空" else empty end),
      (if (.truth.granularity as $g | $gran | index($g)) == null then "granularity 不在 \($gran) 中" else empty end),
      (if (.truth.disposition as $d | $disp | index($d)) == null then "disposition 不在 \($disp) 中" else empty end),
      (if (.scenario.expected_alerts | length) == 0 then "scenario.expected_alerts 不能为空" else empty end)
    ] | .[]')
  expected=$(yq -r '.scenario.expected_alerts | join(" ")' "$truth_file")
  declared=$(bash -c "CLUSTER_NAME=$CLUSTER_NAME; source '$KIND_DIR/lib.sh'; source '$dir/scenario.sh'; echo \"\${EXPECTED_ALERTS[*]}\"")
  if [[ "$expected" != "$declared" ]]; then
    errors+=$'\n'"scenario.expected_alerts（${expected}）与 scenario.sh 的 EXPECTED_ALERTS（${declared}）不一致"
  fi
  if [[ -n "${errors//$'\n'/}" ]]; then
    log "${id}："
    printf '%s\n' "$errors" | sed '/^$/d; s/^/  - /' >&2
    failed=1
  else
    log "${id}：通过"
  fi
done

# kind/gitops（Argo CD 同步的 shop）与场景脚本使用同一组镜像 digest
gitops_images=$(yq -o=json '.images' "$KIND_DIR/gitops/apps/shop/kustomization.yaml")
mismatch=$(yq -o=json '.images' "$KIND_DIR/images/kustomization.yaml" | jq -r --argjson g "$gitops_images" '
  .[] as $i | $g[] | select(.name == $i.name and (.newName != $i.newName or .digest != $i.digest)) | .name')
if [[ -n "$mismatch" ]]; then
  log "deploy/kind/gitops/apps/shop/kustomization.yaml 与 deploy/kind/images/kustomization.yaml 的镜像不一致：${mismatch//$'\n'/ }"
  failed=1
else
  log "kind/gitops 的镜像 digest 与 deploy/kind/images 一致"
fi
exit "$failed"

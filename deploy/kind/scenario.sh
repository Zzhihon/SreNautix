#!/usr/bin/env bash
# 级联故障场景（DESIGN §14.1）的注入、校验与恢复。
#
# 用法：
#   deploy/kind/scenario.sh list
#   deploy/kind/scenario.sh inject  <场景>     注入故障，记录注入时间
#   deploy/kind/scenario.sh verify  <场景>     等待场景的预期告警出现（pending 或 firing）
#   deploy/kind/scenario.sh recover <场景>     撤除故障并等待业务恢复
#   deploy/kind/scenario.sh run     <场景>     inject → verify → 保持 HOLD 秒 → recover
#
# 每个场景是 scenarios/<场景>/scenario.sh，定义 EXPECTED_ALERTS、VERIFY_TIMEOUT 与 inject、recover 两个函数；
# 标准答案在 eval/scenarios/<场景>.yaml。注入时间写入 $SCENARIO_STATE_DIR/<场景>.json，评测按它截取时间窗。
set -euo pipefail
# shellcheck source=deploy/kind/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

SCENARIO_STATE_DIR=${SCENARIO_STATE_DIR:-"$REPO_ROOT/.scratch/kind-scenarios"}
HOLD=${HOLD:-0}

usage() { sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2; exit 2; }

load() {
  local name=$1 file="$KIND_DIR/scenarios/$1/scenario.sh"
  [[ -f "$file" ]] || die "没有场景 $name（$file）"
  [[ -f "$REPO_ROOT/eval/scenarios/$name.yaml" ]] || die "场景 $name 缺少标准答案 eval/scenarios/$name.yaml"
  # shellcheck source=/dev/null
  source "$file"
}

record() {
  local name=$1 phase=$2
  mkdir -p "$SCENARIO_STATE_DIR"
  local f="$SCENARIO_STATE_DIR/$name.json"
  [[ -f "$f" ]] || echo '{}' >"$f"
  jq --arg p "$phase" --arg t "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg c "$CLUSTER_NAME" \
    '.[$p] = $t | .cluster = $c' "$f" >"$f.tmp"
  mv "$f.tmp" "$f"
}

cmd=${1:-}
case "$cmd" in
  list)
    for d in "$KIND_DIR"/scenarios/*/; do basename "$d"; done
    ;;
  inject | verify | recover | run)
    name=${2:-}
    [[ -n "$name" ]] || usage
    require kubectl jq yq docker
    load "$name"
    case "$cmd" in
      inject)
        log "注入 $name"
        record "$name" injected_at
        inject
        ;;
      verify)
        wait_alerts "$VERIFY_TIMEOUT" "${EXPECTED_ALERTS[@]}"
        ;;
      recover)
        log "恢复 $name"
        recover
        record "$name" recovered_at
        ;;
      run)
        log "注入 $name"
        record "$name" injected_at
        inject
        wait_alerts "$VERIFY_TIMEOUT" "${EXPECTED_ALERTS[@]}"
        record "$name" verified_at
        if ((HOLD > 0)); then
          log "保持故障 ${HOLD}s"
          sleep "$HOLD"
        fi
        log "恢复 $name"
        recover
        record "$name" recovered_at
        ;;
    esac
    ;;
  *)
    usage
    ;;
esac

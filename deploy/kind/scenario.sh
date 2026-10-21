#!/usr/bin/env bash
# 级联故障场景（DESIGN §14.1）的注入、校验与恢复。
#
# 用法：
#   deploy/kind/scenario.sh list
#   deploy/kind/scenario.sh known-gaps         输出声明了 KNOWN_GAP 的场景（每行"场景<TAB>说明"）
#   deploy/kind/scenario.sh inject  <场景>     注入故障，记录注入时间
#   deploy/kind/scenario.sh verify  <场景>     等待场景的预期告警出现（pending 或 firing）
#   deploy/kind/scenario.sh recover <场景>     撤除故障并等待业务恢复
#   deploy/kind/scenario.sh run     <场景>     inject → verify →（SRENAUTIX_CHECKS=1 时）SreNautix 三个环节 → 保持 HOLD 秒 → recover
#
# 每个场景是 scenarios/<场景>/scenario.sh，定义 EXPECTED_ALERTS、VERIFY_TIMEOUT 与 inject、recover 两个函数；
# 标准答案在 eval/scenarios/<场景>.yaml。注入时间写入 $SCENARIO_STATE_DIR/<场景>.json，评测按它截取时间窗。
# 声明了 SRENAUTIX_ROOT 的场景在 SRENAUTIX_CHECKS=1 时另外检查发现、分析与自愈 PR（srenautix-checks.sh）。
# KNOWN_GAP（引用跟踪 issue 与产品缺陷）标记已知缺口：场景照常运行、断言不变，kind-e2e 中它失败时只留下警告。
set -euo pipefail
# shellcheck source=deploy/kind/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
# shellcheck source=deploy/kind/srenautix-checks.sh
source "$(dirname "${BASH_SOURCE[0]}")/srenautix-checks.sh"

SCENARIO_STATE_DIR=${SCENARIO_STATE_DIR:-"$REPO_ROOT/.scratch/kind-scenarios"}
HOLD=${HOLD:-0}

usage() { sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2; exit 2; }

load() {
  local name=$1 file="$KIND_DIR/scenarios/$1/scenario.sh"
  [[ -f "$file" ]] || die "没有场景 ${name}（${file}）"
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
  known-gaps)
    for d in "$KIND_DIR"/scenarios/*/; do
      # 在子 shell 中读取，场景之间的变量互不影响
      # shellcheck source=/dev/null
      gap=$(KNOWN_GAP='' && source "$d/scenario.sh" && printf '%s' "$KNOWN_GAP")
      [[ -z "$gap" ]] || printf '%s\t%s\n' "$(basename "$d")" "$gap"
    done
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
        checks=false
        [[ "${SRENAUTIX_CHECKS:-}" == 1 && -n "${SRENAUTIX_ROOT:-}" ]] && checks=true
        if [[ "${SRENAUTIX_CHECKS:-}" == 1 ]]; then
          wait_alert_delivery_healthy
        fi
        $checks && use_llm_recording "$name"
        since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
        log "注入 $name"
        record "$name" injected_at
        inject
        wait_alerts "$VERIFY_TIMEOUT" "${EXPECTED_ALERTS[@]}"
        record "$name" verified_at
        if $checks; then
          check_srenautix "$since"
          record "$name" srenautix_checked_at
        fi
        if ((HOLD > 0)); then
          log "保持故障 ${HOLD}s"
          sleep "$HOLD"
        fi
        log "恢复 $name"
        recover
        record "$name" recovered_at
        # 检查 SreNautix 时每个场景都等自己注入的故障告警结束（不论是否声明了 SRENAUTIX_ROOT），再开始下一个场景
        if [[ "${SRENAUTIX_CHECKS:-}" == 1 ]]; then
          wait_fault_alerts_resolved "$since" "${EXPECTED_ALERTS[@]}"
          record "$name" fault_alerts_resolved_at
        fi
        ;;
    esac
    ;;
  *)
    usage
    ;;
esac

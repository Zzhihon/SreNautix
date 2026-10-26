# shellcheck shell=bash
# SreNautix 三个环节的场景检查（第二阶段章程 §3）：发现、分析、自愈 PR。由 scenario.sh 在 SRENAUTIX_CHECKS=1 时调用。
#
# 场景在 scenario.sh 中声明（没有声明 SRENAUTIX_ROOT 的场景只检查告警）：
#   SRENAUTIX_ROOT              根因组件键的正则（ComponentKey，与 eval/scenarios/<场景>.yaml 的 root_components 对应）
#   SRENAUTIX_MAX_INCIDENTS     注入之后与场景相关的事件数上限（默认 2）
#   SRENAUTIX_CONCLUSIONS       阶段 B 允许的结论（默认 "likely evidence_consistent"）
#   SRENAUTIX_REMEDIATION       期望的修复类别（release_rollback | config_resource | alert_rule）；为空时不检查 PR
#   SRENAUTIX_PR_FILES          修复 PR 应当改动的文件（kind/gitops 中的路径，正则）
#   SRENAUTIX_COVERAGE_ALERT    没有告警目录条目的告警名（ADR 0171）：检查 kind/gitops 上有它的覆盖缺口 issue，列出根因事件，
#                               并且这个事件没有自愈 PR
#   SRENAUTIX_TIMEOUT           每个环节的等待时间（秒，默认 600）
#
# 检查经 worker 的服务 token 调用 server 的读取接口（worker 调用方可以读取全部事件），GitHub 一侧读 gitlocal 的 /_test 接口。
# 依赖 lib.sh 的 k、log、die、gitlocal_api。

SRENAUTIX_NS=${SRENAUTIX_NS:-srenautix}
# 与场景无关的背景噪声所在的命名空间（deploy/kind/workloads/background.yaml）
SRENAUTIX_BACKGROUND_NS='^(traffic|batch)$'

# 以 worker 的服务 token 调用 server 的接口，输出响应体；参数：路径
srenautix_api() {
  local path=$1
  k -n "$SRENAUTIX_NS" exec deploy/srenautix-worker -c worker -- /nodejs/bin/node -e "
    const t = require('node:fs').readFileSync('/etc/srenautix/secrets/service-token/token', 'utf8').trim();
    fetch('http://srenautix-server.$SRENAUTIX_NS.svc:8080' + process.argv[1], { headers: { authorization: 'Bearer ' + t } })
      .then(async (r) => {
        const text = await r.text();
        if (r.status !== 200) { console.error('HTTP ' + r.status + ' ' + text.slice(0, 500)); process.exit(1); }
        process.stdout.write(text);
      })
      .catch((e) => { console.error(e.message); process.exit(1); });" "$path"
}

# 注入之后有变化的事件（新建，或已有事件吸收了新的告警），不含根因在背景噪声命名空间中的事件；
# 没有根因或根因是集群级对象的事件也计入。输出 JSON 数组；参数：注入时间（RFC 3339）
scenario_incidents() {
  local since=$1
  srenautix_api '/v1/incidents?state=all&limit=500' | jq --arg since "$since" --arg bg "$SRENAUTIX_BACKGROUND_NS" '
    [.items[] | select(.updated_at >= $since)
     | select(((.root_component // "") | capture("^[^:]+:(?<ns>[a-z0-9-]+)/")? // {ns: ""} | .ns) | test($bg) | not)]'
}

# 失败信息用：每个事件的根因、标签与成员告警（告警名、组件、状态、开始时间）；参数：scenario_incidents 的输出
describe_incidents() {
  local id
  for id in $(jq -r '.[].incident_id' <<<"$1"); do
    srenautix_api "/v1/incidents/$id" | jq -c '{root: .root, label, members: [.members[]
      | {alertname, component, status, starts_at}]}' || printf '{"incident_id":"%s","error":"读取失败"}' "$id"
  done | jq -sc .
}

# 注入前提：告警投递链路正常。Alertmanager 5 分钟内没有通知失败，也没有 Alertmanager*FailedToSendAlerts 告警
# （安装期间 SreNautix server 就绪之前的 webhook 失败会让这两条告警在随后约 5 分钟内触发，并成为第一个场景之外的事件）。
# SRENAUTIX_QUIET_TIMEOUT 秒（默认 900）
wait_alert_delivery_healthy() {
  local timeout=${SRENAUTIX_QUIET_TIMEOUT:-900} deadline failed alerts
  deadline=$((SECONDS + timeout))
  while true; do
    failed=$(prom_query 'sum(increase(alertmanager_notifications_failed_total[5m]))' | jq -r '.data.result[0].value[1] // "0"')
    alerts=$(prom_query 'ALERTS{alertname=~"Alertmanager(Cluster)?FailedToSendAlerts"}' | jq -c '[.data.result[].metric | {alertname, alertstate, integration}] | unique')
    [[ "$alerts" == "[]" ]] && awk -v f="$failed" 'BEGIN { exit !(f + 0 == 0) }' && break
    ((SECONDS < deadline)) || die "告警投递：${timeout}s 内 Alertmanager 仍有通知失败（5 分钟内 ${failed} 次）或告警 ${alerts}"
    sleep 15
  done
}

# 场景隔离：恢复之后等到场景注入的故障告警（EXPECTED_ALERTS）都已结束，下一个场景才注入：Prometheus 中不再有
# pending 或 firing，SreNautix 中注入之后开始的同名成员告警都已 resolved。只看注入的故障告警，持续的背景告警不阻塞。
# 参数：注入时间、告警名...；SRENAUTIX_QUIET_TIMEOUT 秒（默认 900）
wait_fault_alerts_resolved() {
  local since=$1 timeout=${SRENAUTIX_QUIET_TIMEOUT:-900} deadline names prom open id
  shift
  names=$(printf '%s\n' "$@" | jq -R . | jq -sc .)
  deadline=$((SECONDS + timeout))
  while true; do
    prom=$(prom_query "ALERTS{alertname=~\"$(IFS='|'; echo "$*")\"}" | jq -c '[.data.result[].metric | {alertname, alertstate}] | unique')
    open=$(for id in $(scenario_incidents "$since" | jq -r '.[].incident_id'); do
      srenautix_api "/v1/incidents/$id" | jq -c --argjson names "$names" --arg since "$since" '.members[]
        | select((.alertname | IN($names[])) and .status == "firing" and .starts_at >= $since)
        | {alert_id, alertname, component, starts_at}'
    done | jq -sc .)
    [[ "$prom" == "[]" && "$open" == "[]" ]] && break
    ((SECONDS < deadline)) || die "隔离：恢复之后 ${timeout}s 内注入的故障告警仍未结束：Prometheus ${prom}；SreNautix ${open}"
    sleep 15
  done
  log "隔离：注入的故障告警（$*）都已结束"
}

# 发现：事件收敛到不超过上限，其中有一个事件的根因匹配 SRENAUTIX_ROOT；输出该事件的 id
check_discovery() {
  local since=$1 max=${SRENAUTIX_MAX_INCIDENTS:-2} timeout=${SRENAUTIX_TIMEOUT:-600} deadline incidents id
  deadline=$((SECONDS + timeout))
  while true; do
    incidents=$(scenario_incidents "$since")
    id=$(jq -r --arg re "$SRENAUTIX_ROOT" '[.[] | select((.root_component // "") | test($re))][0].incident_id // empty' <<<"$incidents")
    [[ -n "$id" ]] && break
    ((SECONDS < deadline)) || die "发现：${timeout}s 内没有根因匹配 ${SRENAUTIX_ROOT} 的事件；当前：$(jq -c '[.[] | {root_component, label}]' <<<"$incidents")"
    sleep 15
  done
  # 根因事件出现之后再等一个收敛周期，确认同一故障没有拆成更多事件
  sleep 120
  incidents=$(scenario_incidents "$since")
  local n
  n=$(jq 'length' <<<"$incidents")
  ((n <= max)) || die "发现：注入之后有 ${n} 个事件，超过 ${max}：$(describe_incidents "$incidents")"
  log "发现：${n} 个事件（上限 ${max}），根因事件 ${id}（$(jq -r --arg id "$id" '.[] | select(.incident_id == $id) | .root_component' <<<"$incidents")）"
  printf '%s' "$id"
}

# 分析：阶段 A 有证据卡，注入之后开始的阶段 B 研判完成且结论在允许范围内（事件在注入之前已经存在时，
# 之前的研判用的是上一个场景的录制，不计入）；参数：事件 id、注入时间
check_analysis() {
  local id=$1 since=$2 timeout=${SRENAUTIX_TIMEOUT:-600} deadline cards runs run
  local allowed=${SRENAUTIX_CONCLUSIONS:-likely evidence_consistent}
  deadline=$((SECONDS + timeout))
  until cards=$(srenautix_api "/v1/incidents/$id/evidence" | jq 'length') && ((cards > 0)); do
    ((SECONDS < deadline)) || die "分析：事件 $id 在 ${timeout}s 内没有证据卡"
    sleep 15
  done
  until runs=$(srenautix_api "/v1/incidents/$id/research") &&
    run=$(jq -c --arg since "$since" '[.[] | select(.started_at >= $since and .state == "completed")][0] // empty' <<<"$runs") &&
    [[ -n "$run" ]]; do
    ((SECONDS < deadline)) ||
      die "分析：事件 $id 在 ${timeout}s 内没有注入之后完成的阶段 B 研判：$(jq -c '[.[] | {started_at, state, conclusion_level}]' <<<"${runs:-[]}")"
    sleep 15
  done
  local level
  level=$(jq -r '.conclusion_level' <<<"$run")
  [[ " $allowed " == *" $level "* ]] || die "分析：阶段 B 的结论为 ${level}，应为 ${allowed} 之一"
  log "分析：${cards} 张证据卡，阶段 B 研判 $(jq -r .run_id <<<"$run") 结论 ${level}"
}

# 自愈 PR：kind/gitops 上出现 srenautix/* 分支的 PR，描述有证据、改动、验证计划、回滚四段与 Refs #<issue>，
# 改动的文件匹配 SRENAUTIX_PR_FILES；issue 回链 PR；全程只有人工身份改动过 main，没有合并。参数：事件 id、注入时间
check_remediation() {
  local id=$1 since=$2 timeout=${SRENAUTIX_TIMEOUT:-600} deadline state pr issue files
  deadline=$((SECONDS + timeout))
  until state=$(gitlocal_api GET /_test/state) &&
    pr=$(jq -c --arg id "$id" --arg since "$since" '[.repos["kind/gitops"].items[]
      | select(.is_pr and (.head | startswith("srenautix/")) and .created_at >= $since
               and (.body | contains("<!-- srenautix:incident=" + $id + " -->")))][0] // empty' <<<"$state") && [[ -n "$pr" ]]; do
    ((SECONDS < deadline)) || die "自愈 PR：${timeout}s 内 kind/gitops 上没有事件 $id 的 srenautix/* PR"
    sleep 15
  done
  local body number head
  body=$(jq -r .body <<<"$pr")
  number=$(jq -r .number <<<"$pr")
  head=$(jq -r .head <<<"$pr")
  for section in summary evidence change verify rollback; do
    grep -qF "<!-- srenautix:pr=$section -->" <<<"$body" || die "自愈 PR #${number}：描述缺少 ${section} 一节"
  done
  issue=$(grep -oE 'Refs #[0-9]+' <<<"$body" | head -1 | tr -dc 0-9)
  [[ -n "$issue" ]] || die "自愈 PR #${number}：描述没有 Refs #<issue>"
  jq -e --argjson n "$issue" '.repos["kind/gitops"].items[] | select(.number == $n and (.is_pr | not)) | .labels | index("srenautix")' \
    <<<"$state" >/dev/null || die "自愈 PR #${number}：Refs 的 #${issue} 不是带 srenautix 标签的 issue"
  # 回链评论：App 机器人写的、标记为 <!-- srenautix:comment=link:<PR 地址> --> 且地址以 /pull/<编号> 结尾（apps/srenautix/src/github/issues.ts）
  until state=$(gitlocal_api GET /_test/state) &&
    jq -e --arg n "$issue" --arg num "$number" '.repos["kind/gitops"].comments[$n] // []
      | any((.user | endswith("[bot]")) and ([.body | capture("<!-- srenautix:comment=link:(?<url>[^ ]+) -->")? | .url] | any(endswith("/pull/" + $num))))' \
      <<<"$state" >/dev/null; do
    ((SECONDS < deadline)) || die "自愈 PR #${number}：issue #${issue} 没有回链 PR 的评论"
    sleep 10
  done
  [[ "$(jq -r .base <<<"$pr")" == main ]] || die "自愈 PR #${number}：目标分支不是 main"
  files=$(gitlocal_api GET "/_test/repos/kind/gitops/diff?base=main&head=$(jq -rn --arg h "$head" '$h|@uri')")
  jq -e 'length > 0' <<<"$files" >/dev/null || die "自愈 PR #${number}：分支没有改动"
  jq -e --arg re "$SRENAUTIX_PR_FILES" 'all(.[]; test($re))' <<<"$files" >/dev/null ||
    die "自愈 PR #${number}：改动了 $(jq -c . <<<"$files")，应只改匹配 ${SRENAUTIX_PR_FILES} 的文件"
  check_git_controls "$since"
  log "自愈 PR：#${number}（${head}）改动 $(jq -c . <<<"$files")，关联 issue #${issue}"
}

# 覆盖缺口（ADR 0171）：kind/gitops 上有带 srenautix 与 coverage 标签、正文标记为
# <!-- srenautix:coverage=<集群>/<SRENAUTIX_COVERAGE_ALERT> --> 的 issue（apps/srenautix/src/github/coverage-issues.ts），
# 正文或评论列出根因事件；这个事件没有 srenautix/* 的 PR。参数：事件 id、注入时间
check_coverage() {
  local id=$1 since=$2 timeout=${SRENAUTIX_TIMEOUT:-600} deadline state issue number re
  re="<!-- srenautix:coverage=[^/ ]+/${SRENAUTIX_COVERAGE_ALERT} -->"
  deadline=$((SECONDS + timeout))
  until state=$(gitlocal_api GET /_test/state) &&
    issue=$(jq -c --arg re "$re" '[.repos["kind/gitops"].items[]
      | select((.is_pr | not) and (.body | test($re)))][0] // empty' <<<"$state") && [[ -n "$issue" ]]; do
    ((SECONDS < deadline)) || die "覆盖缺口：${timeout}s 内 kind/gitops 上没有告警 ${SRENAUTIX_COVERAGE_ALERT} 的覆盖 issue"
    sleep 15
  done
  number=$(jq -r .number <<<"$issue")
  jq -e '(.labels | index("srenautix")) and (.labels | index("coverage"))' <<<"$issue" >/dev/null ||
    die "覆盖缺口：issue #${number} 的标签是 $(jq -c .labels <<<"$issue")，应含 srenautix 与 coverage"
  [[ "$(jq '[.repos["kind/gitops"].items[] | select((.is_pr | not) and (.body | test($re)))] | length' --arg re "$re" <<<"$state")" == 1 ]] ||
    die "覆盖缺口：告警 ${SRENAUTIX_COVERAGE_ALERT} 有不止一个覆盖 issue"
  # 事件开出时写在正文里，issue 开出之后才登记的事件写在评论里
  until state=$(gitlocal_api GET /_test/state) &&
    jq -e --arg n "$number" --arg id "$id" '.repos["kind/gitops"] as $r
      | ([$r.items[] | select(.number == ($n | tonumber)) | .body] + [($r.comments[$n] // [])[] | .body])
      | any(contains("/incidents/" + $id))' <<<"$state" >/dev/null; do
    ((SECONDS < deadline)) || die "覆盖缺口：issue #${number} 的正文与评论没有列出事件 ${id}"
    sleep 15
  done
  if jq -e --arg id "$id" --arg since "$since" '[.repos["kind/gitops"].items[]
      | select(.is_pr and (.head | startswith("srenautix/")) and .created_at >= $since
               and (.body | contains("<!-- srenautix:incident=" + $id + " -->")))] | length > 0' <<<"$state" >/dev/null; then
    die "覆盖缺口：事件 ${id} 开出了自愈 PR，覆盖缺口只开 issue"
  fi
  check_git_controls "$since"
  log "覆盖缺口：issue #${number}（告警 ${SRENAUTIX_COVERAGE_ALERT}）列出事件 ${id}，没有自愈 PR"
}

# 补偿控制：注入之后 App 机器人只改动过 srenautix/* 分支，main 只有人工身份的提交；没有经 REST 的合并请求
check_git_controls() {
  local since=$1 state bad
  state=$(gitlocal_api GET /_test/state)
  bad=$(jq -c --arg since "$since" '[.audit[] | select(.time >= $since and .repo == "kind/gitops")
    | select((.bot and (.kind == "ref_update") and ((.ref | startswith("refs/heads/srenautix/")) | not))
             or (.kind == "merge_attempt")
             or (.kind == "ref_update" and .ref == "refs/heads/main" and .bot))]' <<<"$state")
  [[ "$bad" == "[]" ]] || die "补偿控制：$bad"
}

# llm-replay 切换到场景的录制（deploy/kind/scenarios/<场景>/llm/）；场景没有录制时清空
use_llm_recording() {
  local name=$1 dir="$KIND_DIR/scenarios/$1/llm"
  local args=()
  if [[ -d "$dir" ]]; then
    args=(--from-file="$dir")
  fi
  k -n "$SRENAUTIX_NS" create configmap llm-replay "${args[@]}" --dry-run=client -o yaml | k apply -f - >/dev/null
  k -n "$SRENAUTIX_NS" rollout restart deployment/llm-replay >/dev/null
  k -n "$SRENAUTIX_NS" rollout status deployment/llm-replay --timeout=180s >/dev/null
  # 旧 Pod 已退出、新 Pod 就绪（readinessProbe 是 /healthz）之后才注入，避免注入后的研判打到正在重启的服务。
  # 先等旧 Pod 消失：kubectl wait 按选择器取到的 Pod 包括正在终止的旧 Pod，它不会再变为 Ready
  local deadline=$((SECONDS + 120))
  until [[ "$(k -n "$SRENAUTIX_NS" get pod -l app=llm-replay -o name | wc -l | tr -d ' ')" == 1 ]]; do
    ((SECONDS < deadline)) || die "llm-replay 的旧 Pod 120s 内没有退出：$(k -n "$SRENAUTIX_NS" get pod -l app=llm-replay -o name | tr '\n' ' ')"
    sleep 2
  done
  k -n "$SRENAUTIX_NS" wait pod -l app=llm-replay --for=condition=Ready --timeout=120s >/dev/null
  log "llm-replay 使用 ${name} 的录制（$(find "$dir" -name '*.json' 2>/dev/null | wc -l | tr -d ' ') 个响应）"
}

# 三个环节依次检查；参数：注入时间
check_srenautix() {
  local since=$1 id
  id=$(check_discovery "$since")
  check_analysis "$id" "$since"
  if [[ -n "${SRENAUTIX_REMEDIATION:-}" ]]; then
    check_remediation "$id" "$since"
  elif [[ -n "${SRENAUTIX_COVERAGE_ALERT:-}" ]]; then
    check_coverage "$id" "$since"
  else
    check_git_controls "$since"
  fi
}

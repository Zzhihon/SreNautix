# shellcheck shell=bash
# SreNautix 三个环节的场景检查（第二阶段章程 §3）：发现、分析、自愈 PR。由 scenario.sh 在 SRENAUTIX_CHECKS=1 时调用。
#
# 场景在 scenario.sh 中声明（没有声明 SRENAUTIX_ROOT 的场景只检查告警）：
#   SRENAUTIX_ROOT              根因组件键的正则（ComponentKey，与 eval/scenarios/<场景>.yaml 的 root_components 对应）
#   SRENAUTIX_MAX_INCIDENTS     注入之后与场景相关的事件数上限（默认 2）
#   SRENAUTIX_CONCLUSIONS       阶段 B 允许的结论（默认 "likely evidence_consistent"）
#   SRENAUTIX_REMEDIATION       期望的修复类别（release_rollback | config_resource | alert_rule | topology_coverage）；为空时不检查 PR
#   SRENAUTIX_PR_FILES          修复 PR 应当改动的文件（kind/gitops 中的路径，正则）
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
  ((n <= max)) || die "发现：注入之后有 ${n} 个事件，超过 ${max}：$(jq -c '[.[] | {root_component, label}]' <<<"$incidents")"
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
  until state=$(gitlocal_api GET /_test/state) &&
    jq -e --arg n "$issue" --arg num "$number" '.repos["kind/gitops"].comments[$n] // [] | map(.body) | any(contains("srenautix:pr-link=") and contains("/pull/" + $num))' \
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
  # 新 Pod 就绪（readinessProbe 是 /healthz）且旧 Pod 已退出之后才注入，避免注入后的研判打到正在重启的服务
  k -n "$SRENAUTIX_NS" wait pod -l app=llm-replay --for=condition=Ready --timeout=120s >/dev/null
  until [[ "$(k -n "$SRENAUTIX_NS" get pod -l app=llm-replay -o name | wc -l | tr -d ' ')" == 1 ]]; do sleep 2; done
  log "llm-replay 使用 ${name} 的录制（$(find "$dir" -name '*.json' 2>/dev/null | wc -l | tr -d ' ') 个响应）"
}

# 三个环节依次检查；参数：注入时间
check_srenautix() {
  local since=$1 id
  id=$(check_discovery "$since")
  check_analysis "$id" "$since"
  if [[ -n "${SRENAUTIX_REMEDIATION:-}" ]]; then
    check_remediation "$id" "$since"
  else
    check_git_controls "$since"
  fi
}

# shellcheck shell=bash
# 数据库 OOM 后应用 CrashLoop，同时有一个无关的发布：
# - 报表任务 report-batch 反复执行大排序（work_mem 2GB），postgres 容器超过 256Mi 内存上限被 OOM 终止并重启；
# - api 的数据库连接检查随之失败，api 进入 CrashLoopBackOff；
# - 同一时刻 web 发布新镜像（干扰项，与故障无关）。
# shellcheck disable=SC2034
EXPECTED_ALERTS=(KubePodCrashLooping)
VERIFY_TIMEOUT=900

inject() {
  k apply -k "$KIND_DIR/scenarios/db-oom-crashloop"
  k -n shop set image deployment/web web="$(image_ref nginx-next)"
}

recover() {
  k delete -k "$KIND_DIR/scenarios/db-oom-crashloop" --wait=true
  k -n shop set image deployment/web web="$(image_ref nginx)"
  wait_namespace_ready shop 600
}

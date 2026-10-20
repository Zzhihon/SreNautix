# shellcheck shell=bash
# 数据库 OOM 后应用 CrashLoop，同时有一个无关的发布：
# - 报表任务 report-batch 反复执行大排序（work_mem 2GB），postgres 容器超过 256Mi 内存上限被 OOM 终止并重启；
# - api 的数据库连接检查随之失败，api 进入 CrashLoopBackOff；
# - 同一时刻 web 经 kind/gitops 发布新镜像（干扰项，与故障无关）。
# 报表任务不由 Argo CD 管理，直接创建；web 的镜像在 Git 中修改（shop 由 Argo CD 同步）。
# shellcheck disable=SC2034
EXPECTED_ALERTS=(KubePodCrashLooping)
VERIFY_TIMEOUT=900

web_image() {
  gitops_edit "$2" apps/shop/workloads.yaml "
    (select(.kind == \"Deployment\" and .metadata.name == \"web\") | .spec.template.spec.containers[]
      | select(.name == \"web\") | .image) = \"$1\"" shop
}

inject() {
  k apply -k "$KIND_DIR/scenarios/db-oom-crashloop"
  web_image "$(image_ref nginx-next)" "Upgrade web to nginx 1.31"
}

recover() {
  k delete -k "$KIND_DIR/scenarios/db-oom-crashloop" --wait=true
  # 短名 nginx 由 kustomization.yaml 的 images 固定到 digest
  web_image nginx "Revert web to the pinned nginx"
  wait_namespace_ready shop 600
}

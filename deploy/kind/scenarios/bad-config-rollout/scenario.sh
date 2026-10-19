# shellcheck shell=bash
# 错误的配置被发布：checkout 改为引用新的 ConfigMap checkout-config-v2，其中 mode 是无效值。
# 新 Pod 启动即退出（CrashLoopBackOff）；maxUnavailable=0，旧 Pod 继续服务，发布在 120 秒后判为卡住。
# shellcheck disable=SC2034
EXPECTED_ALERTS=(KubePodCrashLooping)
VERIFY_TIMEOUT=900

inject() {
  k apply -f "$KIND_DIR/scenarios/bad-config-rollout/checkout-config-v2.yaml"
  k -n shop patch deployment checkout --type json \
    -p '[{"op": "replace", "path": "/spec/template/spec/volumes/0/configMap/name", "value": "checkout-config-v2"}]'
}

recover() {
  k -n shop rollout undo deployment/checkout
  k -n shop rollout status deployment/checkout --timeout=300s
  k delete -f "$KIND_DIR/scenarios/bad-config-rollout/checkout-config-v2.yaml"
}

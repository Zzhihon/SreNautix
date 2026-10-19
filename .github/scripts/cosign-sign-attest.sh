#!/usr/bin/env bash
# 对一个 OCI 制品做 cosign 无密钥签名，并按需附加 SBOM 证明。可以重复执行：
# - 构建可复现，同一份源码得到同一个 digest，Rekor 拒绝重复的记录；签名与每种证明分别检查，已经存在的跳过；
# - 获取 GitHub Actions OIDC token 偶尔返回非 JSON 的错误页，每次 cosign 调用最多重试 4 次（间隔 15、30、45 秒）。
#
# 用法：cosign-sign-attest.sh <制品引用@digest> <证书主体> [<证明类型>=<predicate 文件> ...]
# 例如：cosign-sign-attest.sh ghcr.io/zzhihon/srenautix@sha256:… \
#         https://github.com/Zzhihon/SreNautix/.github/workflows/image.yml@refs/heads/main \
#         spdxjson=sbom.spdx.json cyclonedx=sbom.cdx.json
set -euo pipefail

ref=${1:?用法：cosign-sign-attest.sh <引用@digest> <证书主体> [类型=文件 ...]}
identity=${2:?缺少证书主体}
shift 2
issuer=https://token.actions.githubusercontent.com

[[ "$ref" == *@sha256:* ]] || { echo "制品引用必须带 digest：$ref" >&2; exit 1; }

retry() {
  local attempt
  for attempt in 1 2 3 4; do
    if "$@"; then
      return 0
    fi
    if ((attempt == 4)); then
      return 1
    fi
    echo "第 ${attempt} 次执行失败，$((attempt * 15)) 秒后重试：$*" >&2
    sleep $((attempt * 15))
  done
}

if cosign verify --certificate-oidc-issuer "$issuer" --certificate-identity "$identity" "$ref" >/dev/null 2>&1; then
  echo "${ref} 已有有效签名"
else
  retry cosign sign --yes "$ref"
fi

for spec in "$@"; do
  type=${spec%%=*}
  predicate=${spec#*=}
  [[ -f "$predicate" ]] || { echo "找不到 predicate 文件：$predicate" >&2; exit 1; }
  if cosign verify-attestation --type "$type" --certificate-oidc-issuer "$issuer" \
    --certificate-identity "$identity" "$ref" >/dev/null 2>&1; then
    echo "${ref} 已有 ${type} 证明"
  else
    retry cosign attest --yes --type "$type" --predicate "$predicate" "$ref"
  fi
done

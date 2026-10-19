#!/usr/bin/env bash
# 在隔离网络中校验离线包：校验和、两个 SreNautix 镜像与 chart 的 cosign 签名、两种 SBOM 证明。
# 只使用包内的 trusted_root.json 与签名自带的透明日志证明，不访问网络。
#
# 用法：在解开的离线包目录中执行 ./verify-bundle.sh
# 环境变量：
#   IDENTITY_RE        镜像签名证书主体的正则，默认匹配 tag 上的 image.yml
#   CHART_IDENTITY_RE  chart 签名证书主体的正则，默认匹配 tag 上的 release.yml
# 依赖：cosign ≥3、sha256sum
set -euo pipefail

bundle_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
cd "$bundle_dir"
issuer=https://token.actions.githubusercontent.com
repo_re='^https://github\.com/Zzhihon/SreNautix'
image_identity_re=${IDENTITY_RE:-"${repo_re}/\\.github/workflows/image\\.yml@refs/tags/v.+\$"}
chart_identity_re=${CHART_IDENTITY_RE:-"${repo_re}/\\.github/workflows/release\\.yml@refs/tags/v.+\$"}

echo "==> 校验和"
sha256sum --check --quiet checksums.sha256

for image in srenautix srenautix-spoke; do
  echo "==> 镜像 ${image}：签名"
  cosign verify --offline --local-image --trusted-root trusted_root.json \
    --certificate-oidc-issuer "$issuer" --certificate-identity-regexp "$image_identity_re" \
    "images/$image" >/dev/null
  for type in spdxjson cyclonedx; do
    echo "==> 镜像 ${image}：${type} 证明"
    cosign verify-attestation --offline --local-image --trusted-root trusted_root.json --type "$type" \
      --certificate-oidc-issuer "$issuer" --certificate-identity-regexp "$image_identity_re" \
      "images/$image" >/dev/null
  done
done

echo "==> chart 签名"
cosign verify --offline --local-image --trusted-root trusted_root.json \
  --certificate-oidc-issuer "$issuer" --certificate-identity-regexp "$chart_identity_re" \
  charts/srenautix-oci >/dev/null

echo "全部校验通过"

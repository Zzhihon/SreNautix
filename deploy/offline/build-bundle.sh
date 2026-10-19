#!/usr/bin/env bash
# 构建离线安装包：两个 SreNautix 镜像、MinIO 镜像、Helm chart（OCI 制品与 .tgz）、
# cosign 签名与证明、SPDX 与 CycloneDX SBOM、Sigstore 信任根、校验和。
# 打包前先在线校验每个制品的签名，任何一项不通过都直接失败。
#
# 用法：deploy/offline/build-bundle.sh <版本> <输出目录>
#   版本：发布的镜像标签与 chart 版本，例如 1.2.0
# 环境变量：
#   REGISTRY     镜像仓库前缀，默认 ghcr.io/zzhihon
#   IDENTITY_RE  签名证书主体的正则，默认匹配本仓库 tag 上的发布工作流
# 依赖：cosign ≥3、helm ≥3.8、jq、yq（mikefarah）、tar（GNU）、sha256sum
set -euo pipefail

version=${1:?用法：build-bundle.sh <版本> <输出目录>}
out_root=${2:?用法：build-bundle.sh <版本> <输出目录>}
registry=${REGISTRY:-ghcr.io/zzhihon}
repo_url=https://github.com/Zzhihon/SreNautix
issuer=https://token.actions.githubusercontent.com
image_identity_re=${IDENTITY_RE:-"^${repo_url//./\\.}/\\.github/workflows/image\\.yml@refs/tags/v.+\$"}
chart_identity_re=${CHART_IDENTITY_RE:-"^${repo_url//./\\.}/\\.github/workflows/release\\.yml@refs/tags/v.+\$"}
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd "$script_dir/../.." && pwd)

name="srenautix-offline-${version}"
work="$out_root/$name"
rm -rf "$work"
mkdir -p "$work/images" "$work/charts" "$work/sbom"

# 1. Sigstore 信任根：cosign initialize 经 TUF 校验后得到 trusted_root.json
tuf_home=$(mktemp -d "$out_root/.tuf.XXXXXX")
HOME="$tuf_home" cosign initialize
cp "$tuf_home/.sigstore/root/tuf-repo-cdn.sigstore.dev/targets/trusted_root.json" "$work/trusted_root.json"
rm -rf "$tuf_home"

verify_signed() {
  local ref=$1 identity_re=$2
  cosign verify --certificate-oidc-issuer "$issuer" --certificate-identity-regexp "$identity_re" "$ref" >/dev/null
}

# 2. SreNautix 镜像：先在线校验签名与两种 SBOM 证明，再连同签名、证明一起保存为 OCI layout
for image in srenautix srenautix-spoke; do
  ref="$registry/$image:$version"
  digest_ref="$registry/$image@$(cosign triangulate --type digest "$ref" | sed 's/.*@//')"
  echo "==> $digest_ref"
  verify_signed "$digest_ref" "$image_identity_re"
  for type in spdxjson cyclonedx; do
    ext=$([[ $type == spdxjson ]] && echo spdx.json || echo cdx.json)
    cosign verify-attestation --type "$type" --certificate-oidc-issuer "$issuer" \
      --certificate-identity-regexp "$image_identity_re" "$digest_ref" \
      | jq -s -e '.[0].payload' -r | base64 -d | jq '.predicate' >"$work/sbom/$image.$ext"
  done
  cosign save --dir "$work/images/$image" "$digest_ref"
  echo "$image $digest_ref" >>"$work/images/refs.txt"
done

# 3. chart：OCI 制品（含签名）与 .tgz
chart_ref="$registry/charts/srenautix:$version"
chart_digest_ref="$registry/charts/srenautix@$(cosign triangulate --type digest "$chart_ref" | sed 's/.*@//')"
echo "==> $chart_digest_ref"
verify_signed "$chart_digest_ref" "$chart_identity_re"
cosign save --dir "$work/charts/srenautix-oci" "$chart_digest_ref"
helm pull "oci://$registry/charts/srenautix" --version "$version" -d "$work/charts"
echo "srenautix-chart $chart_digest_ref" >>"$work/images/refs.txt"

# 4. chart 引用的第三方镜像（审计汇 MinIO），按 chart values 中固定的 digest 保存
chart_tgz="$work/charts/srenautix-$version.tgz"
for key in image clientImage; do
  repo=$(helm show values "$chart_tgz" | yq ".audit.minio.$key.repository")
  digest=$(helm show values "$chart_tgz" | yq ".audit.minio.$key.digest")
  dir_name=$(basename "$repo")
  echo "==> $repo@$digest"
  cosign save --dir "$work/images/$dir_name" "$repo@$digest"
  echo "$dir_name $repo@$digest" >>"$work/images/refs.txt"
done

# 5. 安装与校验说明、校验脚本、校验和
cp "$repo_root/docs/install/offline.zh-CN.md" "$work/README.zh-CN.md"
cp "$script_dir/verify-bundle.sh" "$work/verify-bundle.sh"
sums=$(cd "$work" && find . -type f -print0 | sort -z | xargs -0 sha256sum)
printf '%s\n' "$sums" >"$work/checksums.sha256"

# 6. 可复现的 tar：固定排序、时间戳与属主
epoch=${SOURCE_DATE_EPOCH:-$(git -C "$repo_root" log -1 --format=%ct)}
tar --sort=name --mtime="@$epoch" --owner=0 --group=0 --numeric-owner \
  -C "$out_root" -cf "$out_root/$name.tar" "$name"
rm -rf "$work"
sha256sum "$out_root/$name.tar"

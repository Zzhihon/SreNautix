# 离线安装

每个 `v*` 版本的 GitHub Release 附带一个离线包 `srenautix-offline-<版本>.tar`，在隔离网络中安装与校验 SreNautix 只需要这个文件。离线包由 `deploy/offline/build-bundle.sh` 在发布工作流中构建，打包前在线校验每个制品的签名。

## 内容

| 路径 | 内容 |
|---|---|
| `images/srenautix/`、`images/srenautix-spoke/` | 两个镜像（amd64、arm64），连同 cosign 签名与 SBOM 证明，OCI layout 格式（`cosign save`） |
| `images/minio/`、`images/minio-client/` | chart 中审计用 MinIO 的两个镜像，按 values 中固定的 digest 保存 |
| `images/refs.txt` | 每个镜像的原始引用与 digest |
| `charts/srenautix-<版本>.tgz` | Helm chart |
| `charts/srenautix-oci/` | chart 的 OCI 制品与 cosign 签名 |
| `sbom/<镜像>.spdx.json`、`sbom/<镜像>.cdx.json` | 两个 SreNautix 镜像的 SPDX 与 CycloneDX SBOM |
| `trusted_root.json` | Sigstore 信任根（Fulcio 证书、Rekor 与 CT 日志公钥），打包时经 TUF 校验 |
| `trustroot.yaml` | 同一份信任根的 policy-controller TrustRoot |
| `verify-bundle.sh` | 离线校验脚本 |
| `checksums.sha256` | 包内全部文件的 sha256 |

## 离线校验

在隔离网络中解开离线包并执行校验脚本（需要 cosign ≥3 与 sha256sum）：

```bash
tar -xf srenautix-offline-<版本>.tar
cd srenautix-offline-<版本>
./verify-bundle.sh
```

脚本依次检查：

1. `checksums.sha256` 中每个文件的 sha256；
2. 两个镜像的 cosign 签名：`cosign verify --offline --local-image --trusted-root trusted_root.json`，证书主体必须是 tag 上的 `image.yml` 工作流，签发者是 GitHub Actions；
3. 两个镜像的 SPDX 与 CycloneDX 证明（`cosign verify-attestation --offline`）；
4. chart 的 cosign 签名，证书主体必须是 tag 上的 `release.yml` 工作流。

签名自带 Rekor 的透明日志证明，校验时不访问 Fulcio、Rekor 或 TUF。也可以手动校验单个制品：

```bash
cosign verify --offline --local-image --trusted-root trusted_root.json \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp '^https://github\.com/Zzhihon/SreNautix/\.github/workflows/image\.yml@refs/tags/v.+$' \
  images/srenautix-spoke
```

## 推送到私有仓库

用 `cosign load` 把镜像连同签名推送到私有仓库，签名随镜像一起保留：

```bash
REG=registry.example.internal/srenautix
cosign load --dir images/srenautix "$REG/zzhihon/srenautix:<版本>"
cosign load --dir images/srenautix-spoke "$REG/zzhihon/srenautix-spoke:<版本>"
cosign load --dir images/minio "$REG/minio@<digest>"            # digest 见 images/refs.txt
cosign load --dir images/minio-client "$REG/minio-client@<digest>"
```

## 安装

```bash
helm install srenautix charts/srenautix-<版本>.tgz -n srenautix -f my-values.yaml \
  --set global.imageRegistry=registry.example.internal/srenautix \
  --set audit.minio.image.repository=registry.example.internal/srenautix/minio \
  --set audit.minio.clientImage.repository=registry.example.internal/srenautix/minio-client
```

`global.imageRegistry` 替换两个 SreNautix 镜像的仓库前缀（保留 `zzhihon/<镜像名>` 之后的部分）；镜像的 tag 或 digest 不变，签名继续有效。

## 合规配置的镜像签名校验

policy-controller 在隔离网络中校验签名需要信任根。离线包的 `trustroot.yaml` 是由 `trusted_root.json` 转换出的 TrustRoot（名称 `srenautix-sigstore`，转换规则见 `deploy/offline/trustroot.jq`）：

```bash
kubectl apply -f trustroot.yaml
helm install srenautix charts/srenautix-<版本>.tgz -n srenautix -f values-compliance.yaml -f my-values.yaml \
  --set global.imageRegistry=registry.example.internal/srenautix \
  --set imagePolicy.trustRootRef=srenautix-sigstore
```

ClusterImagePolicy 匹配 `global.imageRegistry` 下的两个镜像，校验离线信任根中的 Fulcio 证书与 Rekor 公钥。

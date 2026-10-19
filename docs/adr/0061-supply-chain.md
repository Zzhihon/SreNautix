# 0061 镜像、chart 与离线包的供应链

## 背景

DESIGN §16.5 要求：镜像与 chart 都用 cosign 签名，SBOM 同时提供 SPDX 与 CycloneDX，支持 ARM64，离线包可用 `cosign verify --offline` 校验；GitHub Actions 按 SHA、基础镜像按 digest、pnpm 冻结锁文件与 `onlyBuiltDependencies`；govulncheck 与 osv-scanner 作为门禁。合规配置另外要求可复现构建与 policy-controller 的 `ClusterImagePolicy`。

## 决定

1. **无密钥签名**：镜像在可复用工作流 `image.yml` 中签名，chart 在 `release.yml` 中签名，证书由 Fulcio 按 GitHub Actions 的 OIDC 身份签发。校验时固定签发者 `https://token.actions.githubusercontent.com` 与工作流路径（`image.yml` 或 `release.yml`）加 ref 的正则，不需要管理长期私钥。
2. **两份 SBOM 与两种证明**：syft 对推送后的镜像生成 SPDX 与 CycloneDX，以 `cosign attest` 附加（`spdxjson`、`cyclonedx` 类型）；另外用 `actions/attest-build-provenance` 生成 GitHub 的构建溯源证明。工作流在推送后立即用 cosign 校验签名与两种证明，校验失败则发布失败。
3. **多架构与交叉编译**：两个镜像都构建 linux/amd64 与 linux/arm64。Go 在构建平台上按 `TARGETARCH` 交叉编译，不经过 QEMU；Node 镜像在 QEMU 中安装依赖，原因是依赖中可能有平台相关的二进制。
4. **可复现**：提交时间作为 `SOURCE_DATE_EPOCH`，buildx 改写层时间戳；Go 使用 `-trimpath -buildvcs=false` 与空 buildid；Node 构建产物的时间统一改写；离线包的 tar 固定排序、时间与属主。
5. **最小镜像**：运行镜像是 distroless 的 `nonroot` 变体（`nodejs24-debian13`、`static-debian13`），没有 shell，以 UID 65532 运行，chart 设置只读根文件系统。
6. **固定版本**：Actions 按 40 位提交 SHA；基础镜像、MinIO 镜像、Kind 节点镜像按 digest；CI 下载的工具与测试二进制校验 sha256；go.mod 的 `toolchain` 与分支镜像的 Go 版本相同并由 CI 检查。
7. **漏洞门禁**：govulncheck 以 go.mod 的 toolchain（即发布二进制的 Go 版本）检查可达的漏洞；osv-scanner 检查 `pnpm-lock.yaml` 与 `go.mod`。两者任何发现都让 CI 失败。
8. **离线包**：只在 tag 上构建。打包前在线校验每个制品的签名与证明；包内包含镜像与签名（`cosign save` 的 OCI layout）、chart、SBOM、经 TUF 校验的 `trusted_root.json` 及其 TrustRoot 形式、离线校验脚本与校验和。隔离网络中用 `cosign verify --offline --local-image --trusted-root` 校验，签名自带 Rekor 透明日志证明。
9. **准入时校验**：合规配置用 policy-controller 的 `ClusterImagePolicy` 要求两个镜像带发布工作流的签名；隔离网络中引用离线包的 TrustRoot。

## 结果

- 证书主体与工作流文件名绑定，重命名 `image.yml` 或 `release.yml` 需要同时修改 chart 的 `imagePolicy.subjectRegExp`、离线校验脚本与文档。
- GHCR 包首次推送后默认 private，需要所有者手动改为 public（见 `docs/release/README.zh-CN.md`）。
- 依赖的新漏洞会让 main 的 CI 失败，修复方式是升级依赖，不设置豁免清单。

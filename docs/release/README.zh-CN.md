# 发布与供应链

## 制品与标签

| 触发 | 中心镜像与分支镜像 | chart |
|---|---|---|
| 每 30 分钟，main 的最新提交（该提交的 chart 已发布、或该提交的 ci 未成功完成时跳过）；手动 `gh workflow run release.yml --ref main` | `sha-<7 位提交>` | `<Chart.version>-main.<提交时间 UTC，年月日时分秒>.g<7 位提交>` |
| tag `vX.Y.Z` | `sha-<7 位提交>`、`X.Y.Z`、`X.Y` | `X.Y.Z`，并附带离线包 |

main 不按推送触发发布：推送频率高于一次发布的耗时，同一并发组只保留一个排队中的运行，排队的运行会不断被更新的推送替换。定时发布取运行时 main 的最新提交，同一提交的 chart 版本号固定，已发布的提交不会重复构建。

**发布门禁**：任何触发方式都要求同一提交的 ci（push 触发的那一轮）已经成功完成。定时运行遇到 ci 失败、被取消或仍在运行时跳过，仍在运行的由下一次定时运行接着检查；跳过时整次运行仍显示成功（只有 `detect` 运行），原因写在运行摘要与注解中，镜像与 chart 没有发布。手动触发与 tag 遇到这种情况时运行失败。紧急修复必须越过门禁时手动触发并设置 `force`（`gh workflow run release.yml --ref main -f force=true`），运行中留下警告。kind-e2e 不在门禁中，发布前另外确认它已通过。

- 镜像：`ghcr.io/zzhihon/srenautix`、`ghcr.io/zzhihon/srenautix-spoke`，linux/amd64 与 linux/arm64。
- chart：`oci://ghcr.io/zzhihon/charts/srenautix`；打包时 `appVersion` 写成本次镜像的标签，chart 默认就拉取同一次构建的镜像。
- 中心镜像包含 server、worker、mcp 三个角色、内置领域包（`/app/packs`）、契约文件（`/app/contract`）与控制台静态文件（`/app/web/console/dist`）。`apps/srenautix`、`packs/`、`web/console/` 都在仓库中时才构建中心镜像；两个镜像都构建成功后才发布 chart。

## 工作流

| 工作流 | 触发 | 内容 |
|---|---|---|
| `ci.yml` | PR、main | TS 的 lint、契约生成检查、类型检查、测试（真实的 Prometheus、Alertmanager、VictoriaMetrics、MinIO、PostgreSQL）；Go 的 gofmt、vet、生成结果检查、envtest 测试；govulncheck 与 osv-scanner；chart 的 lint、kubeconform、helm-unittest；actionlint、shellcheck、action 固定检查；两个镜像的构建检查 |
| `release.yml` | 每 30 分钟（main）、`v*` tag、手动 | 调用 `image.yml` 构建两个镜像，打包并推送 chart，tag 上构建离线包并附加到 Release |
| `image.yml` | 被 `release.yml` 调用 | 多架构构建与推送、cosign 无密钥签名、syft 生成 SPDX 与 CycloneDX SBOM 并以 cosign 证明附加、GitHub 构建溯源证明 |

签名与两种 SBOM 证明由 `.github/scripts/cosign-sign-attest.sh` 完成：签名与每种证明分别检查，已经存在的跳过（构建可复现，同一提交得到同一个 digest，Rekor 拒绝重复记录）；获取 GitHub Actions OIDC token 偶尔返回错误页，每次 cosign 调用最多重试 4 次。
| `kind-e2e.yml` | 手动、每晚、`deploy/kind` 变更 | 每个级联故障场景在自己的 Kind 集群中安装完整环境、注入故障并检查预期告警与 SreNautix 的三个环节；环境拉起与不变量 12 单独运行一次 |

## 依赖固定

- GitHub Actions 全部按 40 位提交 SHA 固定，`ci.yml` 检查新增的 `uses:`。
- 基础镜像按 digest 固定：`node:24.22.0-trixie-slim`（构建）、`gcr.io/distroless/nodejs24-debian13:nonroot`（中心镜像运行）、`golang:1.27.3-trixie`（构建）、`gcr.io/distroless/static-debian13:nonroot`（分支镜像运行）。
- go.mod 的 `toolchain` 与分支镜像的 Go 版本相同，`ci.yml` 检查两者一致。
- pnpm 使用冻结锁文件，依赖安装脚本只对根目录 `package.json` 的 `pnpm.onlyBuiltDependencies` 白名单执行（目前只有 esbuild；pnpm 9 不读 `pnpm-workspace.yaml` 里的这一项）。tree-sitter 语法包只用其中的 `.wasm` 文件，安装脚本不执行，构建镜像不需要 Python。
- CI 下载的工具与测试二进制全部校验 sha256。

## 可复现构建

- 两个镜像都以提交时间作为 `SOURCE_DATE_EPOCH`，buildx 输出设置 `rewrite-timestamp=true`。
- Go：`-trimpath -buildvcs=false -ldflags "-s -w -buildid="`，在构建平台上交叉编译。
- Node：构建产物的文件时间统一为 `SOURCE_DATE_EPOCH`。
- 离线包的 tar 固定排序、时间戳与属主。

## 校验签名

```bash
IMAGE=ghcr.io/zzhihon/srenautix-spoke:<标签>
cosign verify "$IMAGE" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp '^https://github\.com/Zzhihon/SreNautix/\.github/workflows/image\.yml@refs/(heads/main|tags/v.+)$'

# SBOM 证明
cosign verify-attestation --type spdxjson "$IMAGE" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp '^https://github\.com/Zzhihon/SreNautix/\.github/workflows/image\.yml@refs/(heads/main|tags/v.+)$' \
  | jq -r '.payload' | base64 -d | jq '.predicate' > sbom.spdx.json

# GitHub 构建溯源
gh attestation verify "oci://$IMAGE" -R Zzhihon/SreNautix

# chart（签名主体是 release.yml）
cosign verify ghcr.io/zzhihon/charts/srenautix:<chart 版本> \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp '^https://github\.com/Zzhihon/SreNautix/\.github/workflows/release\.yml@refs/(heads/main|tags/v.+)$'
```

## GHCR 包的可见性

集群匿名拉取镜像与 chart 要求三个 GHCR 包都是 public。GitHub 在首次推送时创建包，个人账号下新建的包默认是 private，可见性只能由包的所有者在网页上修改（`GITHUB_TOKEN` 与 REST API 都不能修改可见性）。每个包只需要设置一次：

1. 打开 `https://github.com/users/Zzhihon/packages/container/<包名>/settings`，包名依次为 `srenautix`、`srenautix-spoke`、`charts%2Fsrenautix`。
2. 在 "Danger Zone" 中选择 "Change visibility" → "Public"，输入包名确认。
3. 在 "Manage Actions access" 中确认 `Zzhihon/SreNautix` 仓库有 "Write" 权限（发布工作流用 `GITHUB_TOKEN` 推送）。

确认匿名可读：

```bash
curl -s "https://ghcr.io/token?scope=repository:zzhihon/srenautix:pull" | jq -r .token | head -c 8; echo
crane digest ghcr.io/zzhihon/srenautix:<标签>   # 不登录时能取到 digest 即为 public
```

## 发版步骤

1. 确认 main 上 `ci` 与 `release` 全部通过。
2. 修改 `deploy/helm/srenautix/Chart.yaml` 的 `version` 与 `appVersion` 为新版本，提交到 main。
3. 打 tag 并推送：`git tag -s vX.Y.Z -m vX.Y.Z && git push origin vX.Y.Z`。
4. `release.yml` 完成后，GitHub Release 中有离线包；按上文校验镜像与 chart 的签名。
5. 评测报告写入 `eval/reports/<版本>.md`（DESIGN §19）。

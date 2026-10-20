# 0096 变更源经 GitHub REST API 读取，不在 hub 镜像里带 git

## 背景

server 的变更源（ADR 0092 之后的实现）维护仓库的只读克隆，调用 `git clone`、`git fetch`、`git log`，用部署密钥时还需要 `ssh`。hub 运行镜像是 distroless，没有 git 与 ssh，配置了变更源时同步一直失败。换成带 git 的基础镜像会扩大镜像的攻击面与漏洞扫描范围，并且要在镜像里处理 ssh 主机密钥。

## 决定

1. **不更换基础镜像**。托管在 GitHub 上的仓库改用 GitHub REST API：经 GitHub App 的安装令牌（`github_app`，与拓扑覆盖 PR、事件 issue 共用，ADR 0095）读取分支在回看窗口内的提交，再读取每个提交的 diff 得到改动的文件，按路径前缀映射到拓扑节点。输出与通用 git 适配器相同：不含合并提交，时间取提交时间，`change_id` 为 `<实例 id>:<sha>`。
2. **通用 git 远端暂不支持**：`kind: git` 的变更源在解析配置时报错，说明原因并给出 `kind: github` 的写法；不静默忽略。`changes.cache_dir` 不再使用。
3. 集成清单 `integrations/github`（changes/v1，official_candidate，以录制的 API 响应验证）；凭证只有 App 私钥的挂载文件，App 需要 Contents 只读。
4. 每个提交的 diff 只读一次（适配器缓存最近一次列表中出现过的提交的文件列表），一次同步最多翻 10 页（1000 个提交），超出时只取最新的部分并标记截断。

## 考虑过的方案

- **换成带 git 的基础镜像（例如 Debian slim）**：通用，但镜像变大、漏洞面变大，ssh 的主机密钥信任也要放进镜像或配置；不采用。
- **在镜像里只加静态链接的 git**：仍然需要 ssh 与 CA 证书的处理，维护成本与收益不成比例。
- **GitHub 的 compare 接口一次取多个提交的文件**：只返回整体的文件列表，不能把文件对应到单个提交。

## 结果

- 不需要改镜像；GitHub 上的仓库可以作为变更源。
- GitLab、Gitee、Gitea 等其他远端暂时不能作为 server 的变更源；需要时按各自的 API 增加适配器，或再评估镜像。
- 每次同步的 API 调用数与窗口内的提交数成正比（列表按页、每个新提交一次 diff），受 GitHub App 每小时的配额约束；回看窗口与同步间隔按仓库的提交频率配置。

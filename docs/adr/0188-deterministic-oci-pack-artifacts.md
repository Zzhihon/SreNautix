# 0188 确定性的 OCI 领域包制品与测试后端的回收

## 背景

ConfigMap 分发的用户包有 1 MiB 的上限（ADR 0187）。从几百条告警规则生成的条件卡包会继续增长，按文件分到几个 ConfigMap 只能推迟问题。OCI 分发没有这个上限，加载端（`loadOciPack`、`packs.oci.sources`）已经支持签名校验与 digest 固定，但发布端只有文档里的 `oras push` 示例：

- `oras push` 打包时写入文件的修改时间与创建时间注解，同一份包目录每次推送得到不同的 digest。部署方把 digest 写进 values 时，评审者无法从仓库内容核对这个 digest，CI 也无法在合并之前算出它。
- server 只在启动时加载 OCI 包。发布流程先合并 values（新 digest）再推送制品时，server 在制品推送之前启动，这个来源加载失败，直到下一次重启都不可用。

另有两个测试问题：

- 测试后端（Prometheus、VictoriaMetrics、Loki、zot）由 `startProcess` 启动。vitest 的 worker 被 SIGTERM 或 SIGKILL 结束时，进程退出钩子不运行，后端成为父进程为 1 的孤儿进程，继续占用端口和内存。
- `runPackTests` 在测试超时之后继续启动后端：vitest 判定超时并开始下一个用例，超时的用例仍在后台执行，机器负载高时这会让后面的用例接连超时。

## 决定

### 1. 确定性的包制品

`@srenautix/packs-sdk` 增加 `buildPackArtifact(dir)`，从包目录生成与 `oras push` 格式兼容的单层制品，同一份内容总是得到同一个 manifest digest：

- 层是 tar.gz。tar 条目以包名为顶层目录，文件按路径排序，目录与文件的权限固定为 0755 与 0644，属主与修改时间为 0。gzip 只用不压缩的块（stored），头部的时间为 0：不同机器上的 zlib 实现压缩结果可以不同，不压缩的块在任何实现上都相同。
- 层的注解与 oras 相同（`io.deis.oras.content.digest`、`io.deis.oras.content.unpack`、`org.opencontainers.image.title`），`oras pull` 解包得到原样的包目录；manifest 没有创建时间注解，config 为 OCI 空描述符，`artifactType` 为 `application/vnd.srenautix.pack.v1`。
- 包目录先经 `loadPackDir` 校验，校验失败不生成制品。

命令行增加两个命令：

- `srenautix pack digest --pack <目录> [--json]`：输出制品的 digest。CI 用它核对 values 中固定的 digest 与仓库中的包目录一致。
- `srenautix pack push --pack <目录> --repository <仓库> [--tag <标签>] [--oras <路径>] [--plain-http]`：写成 OCI layout 后由 `oras cp` 推送，再从仓库读回描述符核对 digest。标签默认为 `pack.yaml` 的版本。签名仍由 `cosign sign` 完成。

### 2. 启动时重试 OCI 来源

server 加载每个 OCI 来源时失败后按 2 秒、8 秒各重试一次（`OciPackSources.retryDelaysMs`），每次失败记一条警告。重试覆盖「values 已合并、制品稍后推送或签名」的短暂间隔；重试结束仍失败时只停用这个来源，与之前相同。

### 3. 测试后端随测试进程结束

`startProcess` 在第一次启动后端时另启一个看守进程，经 stdin 登记每个后端的 pid。看守进程忽略 SIGINT、SIGTERM 与 SIGHUP；stdin 关闭（测试进程以任何方式结束，包括 SIGKILL）时向登记的后端发送 SIGKILL。后端正常停止时从登记中移除。

`runPackTests` 接受 `signal`，每次启动后端之前检查它；内置包测试把 vitest 的 `TestContext.signal`（超时时中止）传入，超时的用例不再启动新的后端。

负载高的开发机上可以用 `vitest --maxWorkers=<n> --maxConcurrency=<n>` 降低并发；`describe.concurrent` 的默认上限是 5。

## 考虑过的方案

- **在 CI 中 `oras push` 之后把 digest 写回 values**：digest 不再能在评审时核对，合并之后还要再提交一次，部署仓库的 main 上会出现机器提交。
- **固定 gzip 的压缩级别**：同一级别在 Node 的 zlib、Go 的 compress/flate 与系统 zlib 之间输出不同，digest 依赖构建机器。不压缩的块让层变大（cchp 的条件卡包约 0.9 MiB），对按 digest 缓存的拉取影响很小。
- **server 定期重新加载 OCI 来源**：改变「包在启动时固定、pack.lock 在进程内不变」的约定，同一进程内的研判可能用不同的 lock，还要处理加载到一半的来源。发布顺序的问题用启动时的短重试即可覆盖。
- **用进程组结束后端**：测试进程被 SIGKILL 时没有机会向进程组发送信号；看守进程依赖 stdin 关闭，内核在任何退出方式下都会关闭它。

## 结果

- 部署方在仓库里提交包目录与固定的 digest，CI 在合并之前核对两者一致，合并之后推送并签名同一个 digest。用户包的大小不再受 ConfigMap 上限约束。
- values 先于制品生效时，server 在约 10 秒内仍能加载这个来源。
- 测试进程异常结束不再留下孤儿后端；超时的包测试不再继续占用后端。

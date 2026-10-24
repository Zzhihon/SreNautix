# 0143 用户包变化时滚动更新：由 GitOps 侧填写的 packs.revision

## 背景

用户领域包的 ConfigMap 改了以后，srenautix-server 不会滚动更新。CCHP 合并 cchp-k8s-ops #201、#263 之后，都只能手动 `kubectl rollout restart`。

- server 只在启动时执行一次 `PackRuntime.load`。告警目录、根因参数、证据卡、检测器与阶段 A 都基于那一次的结果，报告里记录的 pack.lock 摘要也是它。
- ConfigMap 卷（没有用 subPath）里的文件大约一分钟后会更新，但进程不会重新读取。
- server 与 worker 的 Pod 模板只有 `checksum/config`，即角色配置的 sha256。用户包的 ConfigMap 不在里面：chart 并不渲染这些 ConfigMap，`packs.userConfigMaps` 只是名字，内容由安装方提供。CCHP 的 ConfigMap `cchp` 就是这样，由 GitOps 仓库单独提供。所以 chart 算不出用户包内容的校验和，任何安装方式都一样。
- worker 不加载领域包：研判用的查询模板与 pack.lock 摘要都由 server 随任务下发。

## 决定

values 增加 `packs.revision`，由提供用户包 ConfigMap 的一方填写，建议取 `srenautix pack lint` 输出的 pack.lock 摘要（各包内容的哈希）。

- 非空时，server 与 worker 的 Pod 模板带注解 `checksum/packs`，值是 `packs.revision` 的 sha256，写法与 `checksum/config` 相同。包变了、这里跟着变，就滚动更新。
- worker 也带：它虽然不加载领域包，但这样新旧包的研判不会在同一时间混在一起。
- reader、gateway、mcp 不加载领域包，不带这个注解。
- 为空时没有这个注解，渲染结果与之前相同。

CCHP 的做法：在 GitOps 仓库里把 `srenautix pack lint` 的摘要写进 values 的 `packs.revision`，与 ConfigMap `cchp` 在同一个提交里修改。CI 可以用 `srenautix pack lock --check` 一类的检查保证两者一致。

不采用的做法：

- **chart 用 `lookup` 读取集群中的 ConfigMap 计算校验和**：Argo CD 渲染时不连集群，`lookup` 返回空；用 helm 直接安装时，结果取决于渲染那一刻集群里的内容，渲染不再确定。
- **server 监听包目录，变化后重新加载**：领域包在启动时被织进很多部件（告警目录、根因参数、证据源、检测器、阶段 A 的报告摘要），热重载要保证一轮重算里各部件用的是同一批包，改动大、风险高。滚动更新的效果相同。加载失败的包与重启时一样被禁用，并记录在 `领域包已加载` 日志的 `failed` 里。
- **用 Argo CD 的 `$ARGOCD_APP_REVISION` 作为 packs.revision**：GitOps 仓库的每一次提交都会让 server 与 worker 重启，与包无关的提交也不例外。

## 结果

- 实现：`deploy/helm/srenautix/values.yaml` 的 `packs.revision`，`templates/deployments.yaml` 的 `checksum/packs`。
- 测试：`deploy/helm/srenautix/tests/packs_revision_test.yaml` 覆盖四种情况：
  - 不填时没有注解；
  - 填了时 server 与 worker 都带注解，值是 `packs.revision` 的 sha256；
  - 值变了注解跟着变，数字形式的值按字符串处理；
  - reader 与 gateway 不带注解。
- 文档：`docs/install/README.zh-CN.md`。
- CCHP 需要在 cchp-k8s-ops 的 values 里填 `packs.revision`，才会在改包后自动滚动更新。

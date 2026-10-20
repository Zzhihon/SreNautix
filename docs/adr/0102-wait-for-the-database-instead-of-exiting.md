# 0102 启动时数据库没准备好：重试并保持 not ready，不退出

## 背景

install-e2e 在 89e4cef 上失败：server 与 worker 先于 db bootstrap 启动，扩展迁移报 `schema "server" does not exist`，进程退出，Pod 进入 CrashLoopBackOff，等 bootstrap 完成后按退避间隔才恢复。platform-ops 在 de2485b 给 server、worker 加了 initContainer（`db wait --schema=<角色>`，store/wait-schema.ts），主进程在 schema 建好之前不会启动。剩下的问题是 initContainer 之后数据库又不可用时（数据库重启、bootstrap 被重做、不用 chart 的部署）主进程该怎么做。

## 决定

1. **重试，不退出**：启动时的扩展迁移遇到"数据库还没准备好"的错误时按退避重试（2 秒起倍增，封顶 30 秒），每次记一条 warn 日志写明原因与下次间隔，没有总时限。"没准备好"指 PostgreSQL 错误码 3F000（schema 不存在）、3D000（数据库不存在）、28000/28P01（角色或口令）、42501（没有授权）、57P03（正在启动），以及连接被拒绝、重置、超时、解析失败。
2. **保持 not ready**：等待期间在探针端口临时监听：`/healthz` 返回 200（进程正常，kubelet 不重启它），`/readyz` 返回 503 并写明在等数据库与原因；迁移成功后临时监听关闭，正式的探针端口照常启动。
3. **其他错误照常退出**：SQL 错误、收缩迁移不兼容等是部署或代码的问题，重试没有意义，进程退出让问题立即暴露。
4. server 与 worker 相同。

## 理由

退出重启把"数据库还没好"变成 CrashLoopBackOff，退避间隔会拉长到 5 分钟，数据库好了之后还要等；日志与事件里看到的是崩溃而不是等待原因。保持进程、只让 readiness 失败，原因写在 `/readyz` 与日志里，数据库一就绪就在 30 秒内恢复。initContainer 仍然保留：它让首次安装时主进程不必在缺 schema 的状态下启动。

## 结果

- 首次安装由 initContainer 排序；之后数据库短暂不可用时 Pod 不重启，只是 not ready。
- 没有总时限：数据库长时间不可用时 Pod 一直 not ready，由 readiness 与自身告警暴露，不靠崩溃。

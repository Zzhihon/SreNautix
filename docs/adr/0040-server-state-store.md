# 0040 server 的状态库：库角色、分轨迁移、outbox 与事件流

## 背景

DESIGN §2 要求每项状态只有一个写入方、每个角色使用独立的数据库角色、跨角色读取只能走 API 或事件流，并且 N-1 版本的二进制能在 N 版本的 schema 上运行（§15.4）。事件流的投递语义是至少一次，消费者按游标读取（§2.3）。

## 决定

1. **库角色与 schema**：`srenautix_server`、`srenautix_worker`、`srenautix_mcp` 三个登录角色；`server` 与 `worker` 两个 schema 分别归对应角色所有，PUBLIC 的默认权限全部收回。`db bootstrap` 以数据库管理员身份执行这些语句，可以重复执行。测试用 `has_schema_privilege` 检查任何角色对别人的 schema 都没有 USAGE。
2. **分轨迁移**：一个 schema 的迁移按模块分成若干轨道（store、identity、ingest、topology、incident、proposals、notify、console），每条轨道从版本 1 起编号，按列出的顺序执行。每条迁移标为 `expand`（只增加）或 `contract`（删除或收紧）。
   - 进程启动时只执行扩展迁移；收缩迁移由 `db contract` 在全部副本升级后显式执行。
   - 库里出现本二进制不认识的扩展迁移时照常运行（作为 N-1）；出现不认识的收缩迁移时拒绝启动。
   - 某条收缩迁移未执行而其后还有扩展迁移时拒绝升级，要求先执行 `db contract`。
3. **outbox**：每个所有者一张只追加的 `outbox`（`seq`、`event_id`、`type`、`schema_version`、`cluster_id`、`payload`），与状态变更写在同一个事务里。追加前取事务级 advisory lock，使 `seq` 的分配顺序等于提交顺序，消费者按 `after=<seq>` 读取时不会跳过晚提交的小 seq。提交时 `pg_notify` 唤醒消费者。
4. **事件流**：`GET /v1/events?after=server:<seq>` 支持长轮询（`wait` 秒）与 SSE（`Accept: text/event-stream`，SSE id 为游标，断线后按 `Last-Event-ID` 续传）。读取方按自己的角色作用域过滤。worker 的研判事件由 server 消费 worker 自己的事件流，按原 `event_id` 重新发布到 server 的 outbox，控制台与渠道只读 server 一处。
5. **幂等键**：写接口接受 `Idempotency-Key`，同一调用方、同一个键在 24 小时内返回第一次的结果；同一个键配上不同的请求体返回 422。

## 结果

- 状态与事件不会出现"写了状态、事件丢了"或反过来的情况；消费者重放同一段游标得到同样的事件。
- 升级时先部署新版本（扩展），全部副本就绪后再收缩，期间新旧两个版本可以同时运行。
- worker 看不到 server 的表，研判需要的事件、阶段 A 报告、拓扑邻域与反馈都经 server 的接口取得。

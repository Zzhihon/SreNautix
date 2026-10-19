# 0073 控制台与插件的端到端测试

## 背景

控制台的正确性取决于它与中心 API 的真实交互：会话 cookie、CSRF、Origin 校验、TOTP 的一次性使用、目标 UID 的拓扑解析、L/H 档的判定、审批断言的签发。用伪造的接口测试界面，会让这些约束在测试里消失。

## 决定

1. **真实后端**：Playwright 的全局准备启动一次性 PostgreSQL（`initdb` 到 `.scratch`）、envtest（真实 etcd 与 kube-apiserver）、按生产方式用配置文件启动的 server 角色（`src/main.ts --role=server`）。控制台的构建产物由 server 的控制台入口（`console.dir`）提供，与接口同源，和部署形态一致。
2. **种子只经真实接口写入**：Kubernetes 对象写进 apiserver，由 server 的 informer 读成拓扑；告警经 Alertmanager webhook 接入；提议由 worker 身份经 `/v1/research/claim` 与 `/v1/proposals` 提交（目标在 informer 同步之前无法解析，提交按真实情况重试）；集群状态由 gateway 心跳上报。H 档提议取 SreNautix 自身依赖（策略的 `self_dependencies`）上的动作。
3. **登录一次**：TOTP 码在一个时间窗内只能用一次，测试登录一次后保存会话；H 档重新认证时等待下一个时间窗的码。重新认证之前，测试把浏览器时钟拨到登录 6 分钟之后，界面要求重新认证；之后拨回真实时间，服务端以自己的时钟核对认证时间。
4. **插件**：在控制台的同一套后端之上，启动真实的 Grafana（官方发行包），插件目录指向构建产物，插件配置经 provisioning 写入（中心地址、控制台地址、`kind: grafana` 的调用方 token）。server 把插件请求头 `X-SreNautix-On-Behalf-Of` 里的邮箱映射到经 OIDC 登录过的用户，所以后端同时启动一个真实的 OIDC 身份源（node-oidc-provider，与 server 的身份测试共用），其中一个账号的邮箱与 Grafana 管理员相同、所在组绑定 responder；插件测试之前，该账号在控制台经 OIDC 登录一次。
5. **资源**：Playwright 只安装 Chromium，放在 `.scratch/ms-playwright`；运行结束停止全部进程并删除数据目录。

## 结果

- 控制台 15 项 e2e 覆盖登录、外壳、收件箱、详情、反馈、L/H 档审批、动作队列、集群、拓扑、策略、治理、语言与主题、手机布局。
- 插件 4 项 e2e 覆盖：在 Grafana 中加载且共享 React 与 jsx-runtime；经插件后端读取收件箱与事件详情，"批准"打开控制台的审批页；反馈经插件后端提交，渠道记为 grafana；插件后端拒绝审批、撤销、实时重跑、原始提示词与暂停，请求不到达中心。
- worker 没有部署时，评测、Agent 健康与模型页面显示中心返回的原因，e2e 断言这段文字。

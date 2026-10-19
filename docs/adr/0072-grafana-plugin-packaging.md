# 0072 Grafana 插件的打包与后端代理

## 背景

插件嵌入收件箱、事件详情与研判运行明细，可以读取和提交反馈；"批准"打开控制台的审批页，插件本身不提供审批路径（DESIGN §12.5）。参考集群的运营台插件曾经在 Grafana 12.1 上整体加载失败：打包配置把 `react/jsx-runtime` 列为外部模块，而那个版本的 Grafana 没有共享它，浏览器请求 `/react/jsx-runtime` 得到 404。

## 决定

1. **模块格式**：Grafana 用 SystemJS 的 AMD 扩展加载 `module.js`。Rolldown 没有 AMD 输出，它的 UMD 输出在 Grafana 页面里会选中 CommonJS 分支并因为没有 `require` 而失败。插件构建为 CommonJS，再用 `define([...共享模块], ...)` 包起来，包内的 `require` 只能取到已声明的共享模块，取其他模块直接报错。CSS 注入到 JS 中；elkjs 内联进 `module.js`（SystemJS 不认识插件自己的动态分片地址）。
2. **共享模块**：`react`、`react-dom`、`react/jsx-runtime`、`@grafana/data`、`@grafana/runtime`、`@grafana/ui`、`rxjs` 外置，插件与 Grafana 用同一份 React。`plugin.json` 的 `grafanaDependency` 只列出共享 `react/jsx-runtime` 的版本：`>=11.6.11 <12 || >=12.0.10 <12.1 || >=12.1.7 <12.2 || >=12.2.5`（与 `@grafana/create-plugin` 的 externalize-jsx-runtime 迁移相同）。Grafana 13.2 起使用 React 19，组件库同时声明 React 18.3 与 19 的对等依赖。
3. **后端**：Go（grafana-plugin-sdk-go），只放行一张路径表：只读接口与 `createFeedback`。路径按转义后的形式匹配（事件标签中的 `%2F` 不会多出路径段），带 `.`、`..` 段或重复斜杠的路径一律拒绝。转发时带插件配置的 Grafana 插件 token 与 `X-SreNautix-On-Behalf-Of: <Grafana 用户邮箱>`，中心把邮箱映射到已绑定的用户并按该用户的角色授权；没有邮箱的 Grafana 用户就地返回 401。审批、撤销、重跑、原始提示词等路径就地返回 403，不连接中心。
4. **配置**：`jsonData.hubUrl`（插件后端访问中心的地址）、`jsonData.consoleUrl`（浏览器打开控制台的地址）、`secureJsonData.hubToken`。插件未签名，部署时以 `GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS` 放行。

## 结果

- 插件的 e2e 在真实的 Grafana 13.2.4 上加载 `module.js`，断言没有 `/react/jsx-runtime` 之类的 404、没有页面错误；后端拒绝的路径经真实的 Grafana 资源接口验证。
- 低于上述版本的 Grafana 不会安装这个插件，避免加载失败。

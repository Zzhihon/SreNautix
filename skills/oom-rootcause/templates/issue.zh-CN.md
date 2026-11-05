{{#finding.previous_number}}
**修复后再次出现**：同一根因的 #{{finding.previous_number}} 已以 completed 关闭。

{{/finding.previous_number}}
## 现象

{{subject.kind}} `{{subject.name}}`（命名空间 `{{subject.namespace}}`{{#steps.kind.facts.limit}}，limit {{steps.kind.facts.limit}}{{/steps.kind.facts.limit}}{{#steps.kind.facts.gomemlimit}}，GOMEMLIMIT {{steps.kind.facts.gomemlimit}}{{/steps.kind.facts.gomemlimit}}{{#steps.kind.facts.gomaxprocs}}，GOMAXPROCS={{steps.kind.facts.gomaxprocs}}{{/steps.kind.facts.gomaxprocs}}{{#steps.kind.facts.image}}，镜像 `{{steps.kind.facts.image}}`{{/steps.kind.facts.image}}）在最近 {{params.occurrence_window}} 内 {{steps.kind.occurrences.length}} 次内存终止：

| 时间 (UTC) | Pod | 分类 | 说明 |
|---|---|---|---|
{{#steps.kind.occurrences}}
| {{at_text}} | {{pod}} | {{kind_text}} | {{#heap_text}}{{heap_text}}；{{/heap_text}}{{note}} |
{{/steps.kind.occurrences}}

结论（主因/次因/置信度）：

{{#steps.rank.main}}
- **主因（置信度{{confidence_text}}）**：{{title}}。{{mechanism}}。
{{/steps.rank.main}}
{{^steps.rank.main}}
- 没有嫌疑项在发生之前的窗口里得到指标与日志的支持，原因未解释，见 §5。
{{/steps.rank.main}}
{{#steps.rank.others}}
- **另一种触发（置信度{{confidence_text}}）**：{{pods_and_times}} 由{{title}}主导。{{mechanism}}。
{{/steps.rank.others}}
{{#steps.rank.unsupported_by_stats}}
- **统计上未得到支持（不排除）**：{{title}}{{#aggravating}}，可能是次要加重因素{{/aggravating}}，见 §3。
{{/steps.rank.unsupported_by_stats}}
{{#steps.rank.ruled_out}}
- **排除为主因（置信度{{confidence_text}}）**：{{title}}，见 §3。
{{/steps.rank.ruled_out}}

## 1. 证据

| 时间 (UTC) | Pod | 指标 / 日志 | 数值 | 依据 | 查询 |
|---|---|---|---|---|---|
{{#steps.rank.evidence}}
| {{when}} | {{pod}} | {{what}} | {{value}} | {{basis}} | {{#query}}`{{query}}`{{/query}} |
{{/steps.rank.evidence}}

{{#steps.requests.items.length}}
主因分组的大请求（只列 request_id、组织前缀与数值{{#steps.requests.group.label}}；请求体字节最多的是{{steps.requests.group.label}}{{/steps.requests.group.label}}）：

|{{#steps.requests.columns}} {{title}} |{{/steps.requests.columns}}
|{{#steps.requests.columns}}---|{{/steps.requests.columns}}
{{#steps.requests.items}}
|{{#cells}} {{#code}}`{{text}}`{{/code}}{{^code}}{{text}}{{/code}} |{{/cells}}
{{/steps.requests.items}}
{{/steps.requests.items.length}}

## 2. 机制与代码位置

{{#steps.code.items}}
- **{{title}}**（{{verdict_text}}{{#confidence_text}}，置信度{{confidence_text}}{{/confidence_text}}）：{{mechanism}}（推断，领域包声明的机制）
{{#locations}}
  - [`{{path}}:{{start}}-{{end}}`]({{url}}){{#note}}：{{note}}{{/note}}
{{/locations}}
{{/steps.code.items}}
{{^steps.code.items}}
{{#steps.rank.ranked}}
- **{{title}}**（{{verdict_text}}）：{{mechanism}}（推断，领域包声明的机制）
{{/steps.rank.ranked}}
{{/steps.code.items}}
{{#steps.code.commit}}

代码按提交 `{{steps.code.commit}}` 读取。
{{/steps.code.commit}}

## 3. 排除项与统计反例

只有发生时刻机制没有出现的直接反证才排除；统计上缺乏关联只说明没有得到支持，不据此排除。

{{#steps.rank.ruled_out}}
- **{{title}}**（排除）：{{reason_text}}。
{{/steps.rank.ruled_out}}
{{#steps.rank.unsupported_by_stats}}
- **{{title}}**（统计上未得到支持，不排除）：{{reason_text}}。
{{/steps.rank.unsupported_by_stats}}
{{^steps.rank.ruled_out}}
{{^steps.rank.unsupported_by_stats}}
- 没有排除项，也没有统计上未得到支持的嫌疑项。
{{/steps.rank.unsupported_by_stats}}
{{/steps.rank.ruled_out}}

## 4. 修复方向与运维侧选项

业务代码（没有被排除的嫌疑项）：

{{#steps.rank.fixes}}
- [ ] {{text}}
{{/steps.rank.fixes}}

运维侧选项（只列出，不执行，由人决定）：

| 选项 | 作用领域 | 影响范围 | 收益 | 风险 |
|---|---|---|---|---|
{{#steps.rank.options}}
| {{title}} | {{domain}} | {{impact}} | {{benefit}} | {{risk}} |
{{/steps.rank.options}}

## 5. 未验证

{{#steps.rank.inferred}}
- {{text}}
{{/steps.rank.inferred}}
{{#steps.code.stale}}
- 代码提示失效：`{{path}}` 中找不到 `{{pattern}}`。
{{/steps.code.stale}}
{{#steps.rank.unexplained}}
- 未解释的发生：{{pod}} {{at_text}}。
{{/steps.rank.unexplained}}
{{#steps.profiles.items.length}}
- 堆里具体是哪些对象需要堆画像。保留的画像（SreNautix 不取出）：
{{#steps.profiles.items}}
  - {{pod}}（{{time_text}}）：`{{path}}`；取出：`{{fetch}}`；分析：`{{analyze}}`
{{/steps.profiles.items}}
{{/steps.profiles.items.length}}

{{#steps.related.items.length}}
相关：{{#steps.related.items}}#{{number}} {{/steps.related.items}}
{{/steps.related.items.length}}

---
由 SreNautix 技能 oom-rootcause {{skill.version}}（摘要 `{{skill.digest}}`，运行 [{{run.id}}]({{run.url}})）只读生成；同一根因再次出现时在这里评论。

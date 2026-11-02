同一根因再次出现（第 {{finding.occurrences}} 次运行，运行 [{{run.id}}]({{run.url}})）：

| 时间 (UTC) | Pod | 原因 | 时刻的来源 |
|---|---|---|---|
{{#steps.occ.new}}
| {{at_text}} | {{pod}} | {{cause_text}} | {{source_text}} |
{{/steps.occ.new}}

{{#steps.rank.main}}
- 主因：{{title}}（置信度{{confidence_text}}）。
{{/steps.rank.main}}
{{#steps.rank.others}}
- 另一种触发：{{pods_and_times}}，{{title}}（置信度{{confidence_text}}）。
{{/steps.rank.others}}
{{#steps.rank.ruled_out}}
- 排除为主因：{{title}}（置信度{{confidence_text}}）。
{{/steps.rank.ruled_out}}

| 时间 (UTC) | Pod | 指标 / 日志 | 数值 | 依据 | 查询 |
|---|---|---|---|---|---|
{{#steps.rank.evidence}}
| {{when}} | {{pod}} | {{what}} | {{value}} | {{basis}} | {{#query}}`{{query}}`{{/query}} |
{{/steps.rank.evidence}}
{{#steps.profiles.items.length}}

新保留的堆画像：
{{#steps.profiles.items}}
- {{pod}}（{{time_text}}）：`{{path}}`；取出：`{{fetch}}`
{{/steps.profiles.items}}
{{/steps.profiles.items.length}}

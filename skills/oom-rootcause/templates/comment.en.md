The same root cause occurred again (run {{finding.occurrences}}, [{{run.id}}]({{run.url}})):

| Time (UTC) | Pod | Cause | Source |
|---|---|---|---|
{{#steps.occ.new}}
| {{at_text}} | {{pod}} | {{cause_text}} | {{source_text}} |
{{/steps.occ.new}}

{{#steps.rank.main}}
- Main cause: {{title}} (confidence {{confidence_text}}).
{{/steps.rank.main}}
{{#steps.rank.others}}
- Another trigger: {{pods_and_times}}, {{title}} (confidence {{confidence_text}}).
{{/steps.rank.others}}
{{#steps.rank.unsupported_by_stats}}
- Not supported by statistics (not ruled out): {{title}}.
{{/steps.rank.unsupported_by_stats}}
{{#steps.rank.ruled_out}}
- Ruled out as the main cause: {{title}} (confidence {{confidence_text}}).
{{/steps.rank.ruled_out}}

| Time (UTC) | Pod | Metric / log | Value | Basis | Query |
|---|---|---|---|---|---|
{{#steps.rank.evidence}}
| {{when}} | {{pod}} | {{what}} | {{value}} | {{basis}} | {{#query}}`{{query}}`{{/query}} |
{{/steps.rank.evidence}}
{{#steps.profiles.items.length}}

Newly retained heap profiles:
{{#steps.profiles.items}}
- {{pod}} ({{time_text}}): `{{path}}`; fetch: `{{fetch}}`
{{/steps.profiles.items}}
{{/steps.profiles.items.length}}

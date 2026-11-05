{{#finding.previous_number}}
**Recurred after a fix**: #{{finding.previous_number}} for the same root cause was closed as completed.

{{/finding.previous_number}}
## Symptoms

{{subject.kind}} `{{subject.name}}` (namespace `{{subject.namespace}}`{{#steps.kind.facts.limit}}, limit {{steps.kind.facts.limit}}{{/steps.kind.facts.limit}}{{#steps.kind.facts.gomemlimit}}, GOMEMLIMIT {{steps.kind.facts.gomemlimit}}{{/steps.kind.facts.gomemlimit}}{{#steps.kind.facts.gomaxprocs}}, GOMAXPROCS={{steps.kind.facts.gomaxprocs}}{{/steps.kind.facts.gomaxprocs}}{{#steps.kind.facts.image}}, image `{{steps.kind.facts.image}}`{{/steps.kind.facts.image}}) had {{steps.kind.occurrences.length}} memory kills in the last {{params.occurrence_window}}:

| Time (UTC) | Pod | Kind | Notes |
|---|---|---|---|
{{#steps.kind.occurrences}}
| {{at_text}} | {{pod}} | {{kind_text}} | {{#heap_text}}{{heap_text}}; {{/heap_text}}{{note}} |
{{/steps.kind.occurrences}}

Conclusion (main / secondary / confidence):

{{#steps.rank.main}}
- **Main cause (confidence {{confidence_text}})**: {{title}}. {{mechanism}}.
{{/steps.rank.main}}
{{^steps.rank.main}}
- No suspect is supported by metrics and logs in the windows before the kills; the cause is not explained, see §5.
{{/steps.rank.main}}
{{#steps.rank.others}}
- **Another trigger (confidence {{confidence_text}})**: {{pods_and_times}} was driven by {{title}}. {{mechanism}}.
{{/steps.rank.others}}
{{#steps.rank.unsupported_by_stats}}
- **Not supported by statistics (not ruled out)**: {{title}}{{#aggravating}}, possibly an aggravating factor{{/aggravating}}, see §3.
{{/steps.rank.unsupported_by_stats}}
{{#steps.rank.ruled_out}}
- **Ruled out as the main cause (confidence {{confidence_text}})**: {{title}}, see §3.
{{/steps.rank.ruled_out}}

## 1. Evidence

| Time (UTC) | Pod | Metric / log | Value | Basis | Query |
|---|---|---|---|---|---|
{{#steps.rank.evidence}}
| {{when}} | {{pod}} | {{what}} | {{value}} | {{basis}} | {{#query}}`{{query}}`{{/query}} |
{{/steps.rank.evidence}}

{{#steps.requests.items.length}}
Large requests in the main group (request_id, organization prefix and numbers only{{#steps.requests.group.label}}; most request body bytes: {{steps.requests.group.label}}{{/steps.requests.group.label}}):

|{{#steps.requests.columns}} {{title}} |{{/steps.requests.columns}}
|{{#steps.requests.columns}}---|{{/steps.requests.columns}}
{{#steps.requests.items}}
|{{#cells}} {{#code}}`{{text}}`{{/code}}{{^code}}{{text}}{{/code}} |{{/cells}}
{{/steps.requests.items}}
{{/steps.requests.items.length}}

## 2. Mechanism and code

{{#steps.code.items}}
- **{{title}}** ({{verdict_text}}{{#confidence_text}}, confidence {{confidence_text}}{{/confidence_text}}): {{mechanism}} (inferred, declared by the pack)
{{#locations}}
  - [`{{path}}:{{start}}-{{end}}`]({{url}}){{#note}}: {{note}}{{/note}}
{{/locations}}
{{/steps.code.items}}
{{^steps.code.items}}
{{#steps.rank.ranked}}
- **{{title}}** ({{verdict_text}}): {{mechanism}} (inferred, declared by the pack)
{{/steps.rank.ranked}}
{{/steps.code.items}}
{{#steps.code.commit}}

Code read at commit `{{steps.code.commit}}`.
{{/steps.code.commit}}

## 3. Ruled out and statistical counter-examples

Only direct evidence that the mechanism was absent at the kills rules a suspect out; a missing statistical association only means it is not supported and rules nothing out.

{{#steps.rank.ruled_out}}
- **{{title}}** (ruled out): {{reason_text}}.
{{/steps.rank.ruled_out}}
{{#steps.rank.unsupported_by_stats}}
- **{{title}}** (not supported by statistics, not ruled out): {{reason_text}}.
{{/steps.rank.unsupported_by_stats}}
{{^steps.rank.ruled_out}}
{{^steps.rank.unsupported_by_stats}}
- No suspect was ruled out or left unsupported by statistics.
{{/steps.rank.unsupported_by_stats}}
{{/steps.rank.ruled_out}}

## 4. Fixes and operations options

Code (suspects not ruled out):

{{#steps.rank.fixes}}
- [ ] {{text}}
{{/steps.rank.fixes}}

Operations options (listed only, not executed; a human decides):

| Option | Domain | Impact | Benefit | Risk |
|---|---|---|---|---|
{{#steps.rank.options}}
| {{title}} | {{domain}} | {{impact}} | {{benefit}} | {{risk}} |
{{/steps.rank.options}}

## 5. Not verified

{{#steps.rank.inferred}}
- {{text}}
{{/steps.rank.inferred}}
{{#steps.code.stale}}
- Stale code hint: `{{pattern}}` not found in `{{path}}`.
{{/steps.code.stale}}
{{#steps.rank.unexplained}}
- Unexplained occurrence: {{pod}} {{at_text}}.
{{/steps.rank.unexplained}}
{{#steps.profiles.items.length}}
- Which objects fill the heap needs a heap profile. Retained profiles (SreNautix does not fetch them):
{{#steps.profiles.items}}
  - {{pod}} ({{time_text}}): `{{path}}`; fetch: `{{fetch}}`; analyze: `{{analyze}}`
{{/steps.profiles.items}}
{{/steps.profiles.items.length}}

{{#steps.related.items.length}}
Related: {{#steps.related.items}}#{{number}} {{/steps.related.items}}
{{/steps.related.items.length}}

---
Generated read-only by SreNautix skill oom-rootcause {{skill.version}} (digest `{{skill.digest}}`, run [{{run.id}}]({{run.url}})); recurrences of the same root cause are added here as comments.

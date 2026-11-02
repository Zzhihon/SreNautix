{{#finding.previous_number}}
Recurred after #{{finding.previous_number}}.
{{/finding.previous_number}}
Pods: {{#steps.status.names}}{{.}} {{/steps.status.names}}
{{#steps.previous.logs}}
- {{pod}}: `{{text}}`
{{/steps.previous.logs}}
Run {{run.id}}, generation {{finding.generation}}.

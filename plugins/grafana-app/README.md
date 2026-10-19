# SreNautix Grafana app plugin

Shows SreNautix incidents inside Grafana: the incident inbox, incident detail (evidence, hypotheses, timeline, runs) and research run pages, with feedback on the disposition and the root component. Approvals are not available in Grafana; **Approve** opens the SreNautix console approval page.

## Requirements

- Grafana 11.6.11+, 12.0.10+, 12.1.7+ or 12.2.5+ (these versions share `react/jsx-runtime` with plugins).
- A SreNautix server and a Grafana plugin token created on the console settings page. The token can read and submit feedback only.

## Configuration

| Field | Meaning |
|---|---|
| `jsonData.hubUrl` | Where the plugin backend reaches the SreNautix server |
| `jsonData.consoleUrl` | Where browsers open the SreNautix console |
| `secureJsonData.hubToken` | Grafana plugin token |

The plugin backend forwards read requests and feedback only, with the current Grafana user's email in `X-SreNautix-On-Behalf-Of`; the server maps it to a linked SreNautix user and authorizes with that user's roles.

The plugin is unsigned; allow it with `GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=srenautix-console-app`.

License: Apache-2.0.

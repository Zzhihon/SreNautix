# AGENTS.md

Read this before you change SreNautix. It maps the repository, names the source of truth for each kind of data, and lists the checks to run. Every path in backticks is checked by CI (`.github/scripts/check-doc-paths.sh`), so the map fails the build when it goes stale.

## How an alert becomes an action

```
Alertmanager webhook ─► ingest ─► incident engine ─► stage A (deterministic report)
                                        │                 │
                                        │                 ▼
                                        │          research (stage B, model)
                                        ▼                 │
                                    notify ◄──────────────┘
                                        │
                     proposals ─► remediation (self-heal PR) / gateway (typed action, Go)
```

## Repository map

| Path | What it holds |
|---|---|
| `apps/srenautix/src` | The hub: server, worker and mcp roles in one TypeScript app |
| `packages/core` | Pure domain functions: alert classification, convergence, incident identity, root ranking |
| `packages/contract` | Types and schemas generated from `contract/`; never edit `packages/contract/src/generated` by hand |
| `packages/packs-sdk` | Pack format, evidence cards, pack test runner |
| `packages/integration-sdk` | Integration manifests, PromQL/MetricsQL parsers (wasm), real test backends |
| `packages/ui` | Console components and views, i18n strings in `packages/ui/src/i18n` |
| `web/console` | Console app shell, routes and Playwright e2e in `web/console/e2e` |
| `internal/spoke` | Go spoke: `internal/spoke/reader` (topology), `internal/spoke/gateway` (typed cluster writes), `internal/spoke/tunnel` |
| `cmd/srenautix-spoke` | Spoke entry point |
| `contract` | OpenAPI, JSON Schemas, gateway CRDs and test vectors shared by TypeScript and Go |
| `packs` | Built-in domain packs; `packs/_example` is the superset reference |
| `skills`, `integrations`, `plugins/grafana-app` | Hot-pluggable skills, channel and data-source integrations, Grafana app |
| `deploy/helm/srenautix` | The chart; `deploy/helm/srenautix/templates/_config.tpl` maps camelCase values to snake_case role config |
| `deploy/kind` | Kind scenarios with answer keys, used by `kind-e2e` |
| `eval` | Replay scenarios and scoring |
| `docs/adr` | Architecture decision records, one decision each |

### Server modules (`apps/srenautix/src`)

| Module | Role |
|---|---|
| `ingest` | Alertmanager webhook, alert state, reconciliation |
| `alerts` | Alert category resolution and business-impact matchers |
| `detectors` | Cluster-state detectors that synthesize alerts |
| `incident` | Incident engine: grouping, identity, reopen, recategorize, data corrections |
| `topology` | Topology store fed by the spoke reader |
| `stage-a` | Deterministic report from pack evidence cards |
| `research` | Stage B: model research, disposition, conclusion ladder |
| `llm`, `prompts`, `tools` | Model routes and sessions, prompt text, model-callable tools |
| `skills`, `optimize` | Hot-pluggable skills and goal-driven optimization |
| `scheduler` | Research admission queue |
| `notify`, `channels` | Message composition, digests, storm control; Telegram and Feishu rendering |
| `proposals`, `remediation`, `changes` | Proposal lifecycle (`ProposalService`), self-heal PRs, change correlation |
| `github` | Issues and PRs through the GitHub App, coverage-gap issues |
| `export`, `mcp`, `console-bff` | Incident export, MCP server, console backend |
| `identity` | Local admin, OIDC, WebAuthn approvals, role bindings |
| `eval`, `events` | Replay and eval candidates; outbox listeners |
| `kernel` | Base layer: logging, metrics, HTTP app and errors, leader election, PostgreSQL pool, migrations, outbox, data corrections. A lint rule forbids it to import anything outside `apps/srenautix/src/kernel` |
| `api`, `config` | HTTP routes of the server roles; zod config schemas |
| `roles` | Process assembly: `apps/srenautix/src/roles/server.ts` wires every module |

## Sources of truth

| Data | Edit here | Then |
|---|---|---|
| API and shared types | `contract/openapi.yaml`, `contract/schemas` | Bump the version in `contract/VERSION`, `contract/openapi.yaml` (`info.version`) and `packages/contract/package.json`; run `pnpm contract:gen` |
| Gateway CRD, admission policy, test vectors | Go types in `internal/spoke/gateway/execution` | `make gateway-generate`; never edit `contract/gateway/v1/crd` by hand |
| Server config keys | The owning module's `config.ts` (`apps/srenautix/src/notify/config.ts`, `apps/srenautix/src/changes/config.ts`, `apps/srenautix/src/detectors/config.ts`, `apps/srenautix/src/optimize/config.ts`, `apps/srenautix/src/skills/config.ts`); other sections in `apps/srenautix/src/config/server.ts`, which only composes | Add the Helm value, its mapping in `_config.tpl` and a helm unittest |
| Database schema | the module's `migrations.ts` | Migrations only add schema (ADR 0176); rewrite rows in a data correction listed in `apps/srenautix/src/roles/server-schema.ts` |
| Console text | `packages/ui/src/i18n/zh-CN.json` and `en.json` | `rg` the old text in `web/console/e2e` and update the assertions |
| Test backend versions | `packages/integration-sdk/backends.json` | CI caches `.scratch/backends` by the file hash |

## Checks before you push

1. Run `pnpm lint`. It runs `prettier --check .`, which also covers YAML and Markdown.
2. If you changed `contract/`, run `pnpm contract:check`.
3. Run `pnpm typecheck`.
4. Run the unit tests of the packages you touched, for example `pnpm --filter @srenautix/app test:unit`.
5. Integration tests need real backends: set `SRENAUTIX_TEST_BIN`, `SRENAUTIX_MINIO_BIN`, `SRENAUTIX_PG_BIN` (see `.github/scripts/install-test-binaries.sh`). Behind a proxy, set `NODE_USE_ENV_PROXY=1`, because Node `fetch` ignores `HTTPS_PROXY`.
6. For Go, run `make go-vet` and the tests of the touched packages.

## Rules

- Every change reaches `main` through a pull request. Merge only when CI is green; a red required job is a real failure until you prove otherwise.
- One decision per ADR. Give a new ADR the next free number after the highest in `docs/adr`. When a new ADR changes an old one, add `状态：部分取代（见 NNNN）` or `状态：已取代（见 NNNN）` under the old one's title, then run `node hack/adr-index.mjs`; CI checks `docs/adr/README.md` is current and no ADR cites a missing one.
- Write user-facing text, comments and ADRs in Simplified Chinese, in short sentences. Keep identifiers in their original form.
- Use Conventional Commits: `type(scope): subject`.
- Never weaken a safety invariant (`POSITIONING.zh-CN.md`, `test/invariants`) without a test for it in the same pull request.

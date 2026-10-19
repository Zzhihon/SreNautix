# SreNautix

**The full-stack, open-source AI SRE platform for self-hosted Kubernetes.**

SreNautix takes alerts from your existing stack, groups them into incidents, ranks root-cause candidates on your cluster's topology, and judges deterministic evidence before any model is involved. Only then does it ask a model, and it checks every citation in the model's output with code. Fixes go through a separate gateway that can only run typed, pre-declared actions. The Kubernetes API server confines those writes, each one is checked afterwards, and it is reverted if possible. How accurate SreNautix is gets measured on your own past incidents, with the model you actually use.

> **Status: design stage.** There is no runnable code yet. Public releases start only after the project has met its own production bar on a reference cluster for two consecutive weeks (see [POSITIONING.zh-CN.md](POSITIONING.zh-CN.md)).

![Architecture](architecture.svg)

## What it is built around

1. **Root inference on topology.** Alerts are grouped into incidents deterministically and root causes are ranked on the cluster topology.
2. **Evidence first.** Evidence cards judge their own data as normal, abnormal or undeterminable before the model sees anything. Code checks every evidence reference the model makes and downgrades unsupported conclusions.
3. **Controlled execution.** Models never hold write credentials. A separate gateway runs typed catalog actions, and Kubernetes admission policies confine their shape.
4. **Verify and undo.** Each action checks a declared post-condition. Reversible actions roll back automatically; compensable actions need re-approval.
5. **Replay on your own incidents.** Replays are leakage-guarded and scored per model with confidence intervals. A regression blocks the release.

Twelve safety invariants are stated in the positioning document, and each one is backed by a named CI test in the design.

## Documents

| Document | Content |
|---|---|
| [POSITIONING.zh-CN.md](POSITIONING.zh-CN.md) | Who it is for, the jobs it does, its invariants, falsifiable claims, and licensing |
| [DESIGN.zh-CN.md](DESIGN.zh-CN.md) | Architecture and design (v2), reviewed by 11 adversarial reviewers in two rounds |
| [architecture.svg](architecture.svg) | Architecture diagram |

The design documents are in Chinese for now. English versions will be published before the first release.

## License

- Server-side code: [AGPL-3.0-or-later](LICENSE).
- `contract/`, `packages/{packs-sdk,integration-sdk,ui,contract}`, `plugins/`, `packs/`: [Apache-2.0](LICENSE.Apache-2.0).

Contributions to AGPL-licensed code require signing the [CLA](CLA.md). Contributions to Apache-2.0 parts only need a DCO sign-off. See [CONTRIBUTING.md](CONTRIBUTING.md).

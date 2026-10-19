# Contributing to SreNautix

SreNautix is in the design stage. Design discussion is welcome in issues. Code contributions open once the repository layout described in [DESIGN.zh-CN.md](DESIGN.zh-CN.md) §18 exists.

## Licensing of contributions

| Path | License | What you need |
|---|---|---|
| `contract/`, `packages/packs-sdk`, `packages/integration-sdk`, `packages/ui`, `packages/contract`, `plugins/`, `packs/`, `integrations/` | Apache-2.0 | A DCO sign-off on every commit (`git commit -s`, which adds `Signed-off-by: Your Name <email>`). By signing off you certify the [Developer Certificate of Origin 1.1](https://developercertificate.org/). |
| Everything else (server-side code) | AGPL-3.0-or-later | Sign the [CLA](CLA.md) once, by commenting on your first pull request: `I have read the CLA Document and I hereby sign the CLA`. |

A pull request that touches both kinds of paths needs both.

If you contribute on behalf of an employer, make sure you are authorized to do so before you sign. If your organization needs a corporate agreement, open an issue.

## Commits and pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): subject`.
- Keep each pull request to one change. Describe how you verified it.
- Anything that widens what SreNautix can execute (actions, policies, executors, admission policies) must come with tests for the affected safety invariants (DESIGN §16.1).

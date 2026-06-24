---
name: running-tend
description: Station-specific guidance for tend CI workflows. Adds Station's CI lanes, terminal/TUI review rules, and runtime-debugging boundaries on top of the generic tend-* skills.
metadata:
  internal: true
---

# Station Tend CI

Project-specific guidance for Tend workflows running on Station.

The generic Tend skills provide the workflow framework. This overlay adds
Station's repo conventions.

## Test Commands

Use the same deterministic gate documented in `docs/development.md`:

```bash
pnpm test:all
```

Focused commands:

```bash
pnpm build
pnpm typecheck
pnpm lint
pnpm test:unit
pnpm test:contracts
pnpm test:integration
pnpm test:diagnostics
pnpm test:agent:scripted
pnpm smoke:release
```

The CI workflow also has a mandatory Bun lane for the OpenTUI Station
workspace:

```bash
pnpm build
cd station
bun install
bun run typecheck
bun run test
```

Real provider and broader e2e lanes are opt-in. Do not make them required for
ordinary PRs or default-branch CI.

## Review Focus

- Station is terminal/TUI-first. Ignore generic web, frontend, site, image, and
  browser guidance unless the PR explicitly targets a browser-rendered UI.
- For architecture or boundary decisions, read `docs/architecture.md` before
  recommending changes.
- For runtime trace IDs, command IDs, diagnostic IDs, or live debugging, use
  `docs/debugging.md` and the existing runtime/debug commands before grepping
  source.
- Keep provider-specific behavior behind provider or integration boundaries.
  Observer/core code should consume contracts and injected capabilities, not
  concrete provider details.
- Treat `unknown` as a boundary-only type. Parse JSON, TOML, CLI output, hook
  payloads, and provider payloads once with strict schemas, then pass typed
  values inward.

## CI Fix Policy

If `standard-ci` fails on `main`, classify the failure before opening a PR.
Open a fix PR only for a reproducible regression or deterministic CI/setup
breakage. For transient GitHub runner failures, network failures, or one-off
flakes, leave a concise diagnosis and do not churn the repo.

## PR Titles

Use semantic, reviewer-oriented PR titles like
`fix(observer): preserve command completion diagnostics`.

Do not add agent tags to PR titles.

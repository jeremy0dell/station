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

## This Repo Runs a Tend Fork

The CI workflows pin `jeremy0dell/tend/claude@onboard` — a **fork** of upstream
`max-sixty/tend`, not the published action. When verifying any tend behavior
(config keys, checks, preflight logic), read the fork source at `jeremy0dell/tend`
branch `onboard`. Do **not** verify against upstream `max-sixty/tend` or
`uvx tend@latest` — both run the published code and lag the fork, so a claim
that holds upstream can be wrong for the code that actually runs in CI.

`.config/tend.yaml` sets `unsafe_allow_unprotected_default_branch: true`. This
key **is functional on the fork**: `check_branch_protection` converts the
`branch-protection:<default>` failure into a pass when it is set
(`generator/src/tend/checks.py`), which is why CI runs succeed on an
intentionally-unprotected `main`. It is **not** a no-op or dead key.

Consequences:

- `uvx tend@latest check` reports `branch-protection:main` FAIL plus an
  "unknown config key" warning. Both are **false positives** relative to the
  fork that actually runs in CI — the published CLI doesn't recognize the key.
  Don't treat that FAIL as a real defect, and don't propose removing the key:
  removing it would re-break the bundled branch-protection preflight (it
  hard-failed an early run before the fork migration).
- Regenerating workflows via published tend would revert the `@onboard` refs
  and strip the key — a harmful change. Don't open that PR.

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

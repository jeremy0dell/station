# Agent Guidance

For architecture or boundary decisions, read `docs/architecture.md`.

For configuration — the runtime `config.toml` (all sections, including `[workspace]` and `[tui]`), the project-local `.station/config.toml`, and environment variables — read `docs/configuration.md`.

For development, test, and documentation workflow, read `docs/development.md`.

For runtime trace IDs, command IDs, diagnostic IDs, or live debugging, read `docs/debugging.md`.
For diagnosis, start with the debugging, diagnostics, and observability tools documented there before reading source code.

When finishing a change and summarizing it, include a minimal line or section naming the specific UX implication and how to manually verify it when possible.

PR titles should be semantic and reviewer-oriented, using a type/domain shape like `refactor(protocol): centralize observer command completion waits`; do not add agent tags.

STATION is terminal/TUI-first. Ignore generic web, frontend, site, image, and browser guidance unless the task explicitly targets a web frontend or browser-rendered UI.

## Code Comments

Prefer self-documenting code. Add a comment when it protects non-obvious intent that future edits could plausibly break: ordering constraints, fallbacks, invariants, cancellation or concurrency behavior, external tool quirks, boundary translations, or other concerns in that realm.

Prefer one precise comment near the protected code over leaving the rationale in a planning doc or review thread. Do not add comments that restate the branch condition, variable name, or TypeScript type. If a comment would need to narrate several steps of ordinary code, simplify or extract the code first.

Keep load-bearing comments; do not strip them chasing a zero-comment ideal. The target is the necessary minimum, which is almost always SOME, not NONE — a file with real ordering, concurrency, or boundary subtlety should carry the comments that protect it.

Voice: one sentence by default (needing two usually means the code wants renaming or extracting). State the mechanism or invariant, not a narrative. Cut storytelling and anthropomorphizing ("brings the user there", "yanked into the pane", "lands the user in the pane") and anything that restates a named flag or type. At most one parenthetical per comment.

## Optional Object Construction

`exactOptionalPropertyTypes` is intentional. Preserve the difference between absent optional fields and fields set to `undefined`.

For complex mappers, persistence row conversion, diagnostics construction, error shaping, and provider payload parsing, prefer typed local builders with explicit `if` assignments over dense `...(value === undefined ? {} : { value })` object spreads. Small conditional spreads are acceptable when they stay local and obvious.

Do not use `...(await somePromise)` in production array or object construction. Await into a named local first.

Provider-specific diagnostics and behavior must stay behind provider or integration boundaries. Observer/core code should aggregate provider diagnostics through contracts or injected capabilities, not import concrete providers directly.

Use strict schemas for untrusted input and shared payload formats. Avoid maintaining parallel hand-written validators for the same shape.

Treat `unknown` as a boundary-only type. At JSON/TOML/CLI/hook/provider boundaries, parse once with a strict Zod schema or contract parser, then pass typed values inward.

Do not add local JavaScript-style type helper clusters such as `isRecord`, `asRecord`, `stringField`, `numberField`, or repeated `"key" in value`/`typeof value.foo === ...` checks for shapes that already have, or should have, a schema or discriminated TypeScript type. If the shape is shared, put the schema in `packages/contracts`; if it is provider-private, keep a provider-local schema beside the adapter/parser.

Inside already-typed code, prefer discriminated unions, exhaustive `switch` handling, typed builders, and inferred schema types over runtime property probing. Runtime shape probing is acceptable only for truly generic traversal/error-normalization code or the first step before schema parsing.

Observer/core code should not scrape provider-specific keys out of generic `providerData`. Normalize those fields at the provider boundary into contract fields, correlation fields, or a provider-owned schema.

## Runtime Debugging

For runtime trace IDs, command IDs, and diagnostic IDs, do not start by grepping checked-in source. Runtime evidence lives under the configured observer state directory, defaulting to `~/.local/state/station`.

Start with the narrowest matching tool:

- trace, command, or diagnostic id: `stn debug trace <id>`
- no id yet, historical/local symptom: `stn debug logs [query]`
- latest known failure: `stn debug trace --latest-failure`
- process status only: `stn observer status`
- current runtime health: `stn doctor`
- current graph truth: `stn snapshot --json`
- live event stream: `stn observe --include-snapshot --duration 3s`, with `--json` for agent-readable output
- command lifecycle record: `stn command get <commandId>`
- redacted shareable evidence: `stn debug bundle --trace <traceId>`, `stn debug bundle --command <commandId>`, or `stn debug bundle --latest-failure`
- provider hook setup: `stn hooks doctor worktrunk|claude|codex|cursor|crush|opencode` or `stn event-hooks doctor`
- setup/tool readiness: `stn setup check --json`, `stn setup system --check`, or `pnpm setup:system:check`

If the user says "no action", treat debugging as read-only: inspect only existing logs, existing bundles, existing command/error records, and `stn debug trace` / `stn debug logs` output. Do not start/restart observer, run commands that call or auto-start the observer, retry commands, kill processes, mutate setup/hooks/config, or write a new bundle unless explicitly asked.

Provider hooks are delivery hints, not runtime truth. Use hook logs and hook doctors to diagnose delivery/setup, then use observer health, reconcile output, and snapshots for current truth.

Key runtime files are `logs/observer.jsonl`, `logs/hooks.jsonl`, `logs/cli.jsonl`, `logs/tui.jsonl`, latest `diagnostics/*/diagnostic-index.json`, `diagnostics/*/commands.jsonl`, `diagnostics/*/errors.jsonl`, and `spool/hooks/`.

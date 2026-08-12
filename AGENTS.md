# Agent Guidance

For repository-wide architecture or boundary decisions, read `docs/architecture.md`. For
Observer ports, adapters, use cases, policies, composition, or dependency direction, also
read `docs/observer-architecture.md` and `docs/architecture-documentation.md`.

For configuration — the runtime `config.toml` (all sections, including `[workspace]` and `[tui]`), the project-local `.station/config.toml`, and environment variables — read `docs/configuration.md`.

For development, test, and documentation workflow, read `docs/development.md`.

When creating plans, name the governing documents and other sources of truth, enumerate every file and test expected to change, and identify every JSDoc addition or update required for backend or connector changes.

For harness status, attention, and event semantics, read `docs/harness-signals.md`. For adding or upgrading a harness integration, read `docs/harness-authoring.md`.

For runtime trace IDs, command IDs, diagnostic IDs, or live debugging, read `docs/debugging.md`.
For diagnosis, start with the debugging, diagnostics, and observability tools documented there before reading source code.

When finishing a change and summarizing it, include a minimal line or section naming the specific UX implication and how to manually verify it when possible.

PR titles should be semantic and reviewer-oriented, using a type/domain shape like `refactor(protocol): centralize observer command completion waits`; do not add agent tags.

PR descriptions must be reviewer-oriented and understandable without prior knowledge of Station's implementation history.

Every substantive PR should answer, in this order:

- `## What this fixes`: briefly explain the affected Station responsibility, the concrete problem, and why it matters.
- `## What changed`: summarize the resulting behavior and important design decisions using concise, outcome-oriented bullets.
- `## Testing`: name the meaningful validation performed.

Add `## Safety and scope` or `## User-visible behavior` only when they provide decision-relevant context.

Assume the reviewer is technically capable but may not know Station's internal architecture. Define unfamiliar subsystem responsibilities on first mention, but do not include project history, a file-by-file walkthrough, implementation details already clear from the diff, or exhaustive test output. Prefer one short context paragraph and 3-7 change bullets; smaller PRs should be shorter.

STATION is terminal/TUI-first. Ignore generic web, frontend, site, image, and browser guidance unless the task explicitly targets a web frontend or browser-rendered UI.

## Module Organization

When a module’s name cannot clearly describe what it owns, identify its independent outputs and give each one a module named after that responsibility. Extract only genuinely shared mechanics; do not group unrelated behavior merely because it belongs to the same feature.

## Code Comments

Prefer self-documenting code. Add a concise comment next to the code only when it protects non-obvious intent future edits could break—especially ordering, invariants, concurrency, fallbacks, external quirks, or boundary translations.

Keep load-bearing comments, but do not restate the code or its types. If a comment must narrate ordinary steps, simplify the code first. State the mechanism or invariant, usually in one sentence; avoid storytelling and anthropomorphism.

## Optional Object Construction

`exactOptionalPropertyTypes` is intentional. Preserve the difference between absent optional fields and fields set to `undefined`.

For complex mappers, persistence row conversion, diagnostics construction, error shaping, and provider payload parsing, prefer typed local builders with explicit `if` assignments over dense `...(value === undefined ? {} : { value })` object spreads. Small conditional spreads are acceptable when they stay local and obvious.

Do not use `...(await somePromise)` in production array or object construction. Await into a named local first.

Keep provider-specific behavior, diagnostics, and raw-payload parsing inside `integrations/...`. Observer/core may consume only provider-neutral contracts or injected capabilities; normalize shared facts at the integration boundary instead of reading provider-specific `providerData` keys.

Use strict schemas for untrusted input and shared payload formats. Avoid maintaining parallel hand-written validators for the same shape.

Treat `unknown` as a boundary-only type. At JSON/TOML/CLI/hook/provider boundaries, parse once with a strict Zod schema or contract parser, then pass typed values inward.

Use idiomatic TypeScript and `SafeError` shapes. At error boundaries, convert unknown failures through the repo's SafeError helpers instead of probing Error-like objects by hand. If code is `===`-checking JavaScript primitive type strings (`"string"`, `"number"`, `"boolean"`, `"object"`), it is usually the wrong shape even in small helpers: use a schema, discriminated union, inferred type, or typed builder instead. Keep primitive `typeof` checks only for truly generic JavaScript interop, recursion, or error-normalization boundaries where no typed contract can exist, and keep them local.

Do not add local JavaScript-style type helper clusters such as `isRecord`, `asRecord`, `stringField`, `numberField`, or repeated `"key" in value`/`typeof value.foo === ...` checks for shapes that already have, or should have, a schema or discriminated TypeScript type. If the shape is shared, put the schema in `packages/contracts`; if it is provider-private, keep a provider-local schema beside the adapter/parser.

Inside already-typed code, prefer discriminated unions, exhaustive `switch` handling, typed builders, and inferred schema types over runtime property probing. Runtime shape probing is acceptable only for truly generic traversal/error-normalization code or the first step before schema parsing.

## Runtime Debugging

Runtime evidence lives under the configured Observer state directory (default `~/.local/state/station`). Use the CLI before searching source:

- known trace, command, or diagnostic ID: `stn debug trace <id>`; command lifecycle: `stn command get <commandId>`
- history or latest failure: `stn debug logs [query]` or `stn debug trace --latest-failure`
- process, health, or graph: `stn observer status`, `stn doctor`, or `stn snapshot --json`
- live events: `stn observe --include-snapshot --duration 3s` (add `--json` for agent-readable output)
- hook/setup diagnosis: `stn hooks doctor <provider>`, `stn event-hooks doctor`, or `stn setup check --json`
- redacted evidence: `stn debug bundle --trace <id>`, `--command <id>`, or `--latest-failure`

If the user says "no action," use only existing logs, records, bundles, and `stn debug trace` / `stn debug logs`. Do not start, restart, or auto-start Observer; retry commands; kill processes; change setup, hooks, or config; or create a bundle.

Hooks prove delivery, not current runtime state; confirm current truth through Observer health, reconcile output, and snapshots.

# Development

This is the contributor entrypoint for Station. It covers checkout preparation,
routes each kind of work to its owning guide, and names the default verification
gates. Detailed runtime procedures, test topology, and release operations live
in their own documents.

## Prepare a checkout

Development requires Node.js 24.2+ and below 25, with Bun 1.4.0 as the
repository package manager, script dispatcher, and raw typed-command source runtime.

```sh
bun install
bun run build
```

The root workspace and `station/` use TypeScript 7. The root also retains a
TypeScript 6 compatibility lane for compiler-API and declaration regressions.
Use the repository's workspace TypeScript version in your editor.

## Choose the owning guide

- Use [Local development](local-development.md) to run checkout-isolated
  Observer, TUI, and tmux workflows without disturbing another worktree.
- Use [TUI development](tui.md) for OpenTUI components, keymaps, rendering,
  native terminal behavior, and Station Host work.
- Use [Dashboard architecture](dashboard-architecture.md) for semantic UI tree,
  focus, flexible layout, scrolling/clipping ownership, and terminal-cell boundaries.
- Use [Setup testing](setup-testing.md) for guided setup, shell behavior, and
  clean-profile acceptance.
- Use [Testing](../tests/README.md) to choose a deterministic, compiled, PTY,
  or opt-in real-provider lane.
- Use [Architecture](architecture.md) for repository-wide ownership and
  dependency direction.
- Use [Observer architecture](observer-architecture.md) and
  [Architecture documentation](architecture-documentation.md) for Observer
  boundaries, controlled JSDoc, and architecture-manifest work.
- Use [Harness authoring](harness-authoring.md) when adding or upgrading a
  provider integration.
- Use [Configuration](configuration.md) for TOML and environment-variable
  contracts.
- Use [Releasing](releasing.md) for the maintainer release procedure.

For runtime incidents, start with [Debugging](debugging.md) and current runtime
evidence before reading source code.

## Choose verification

While iterating, run the narrowest test that proves the changed responsibility.
Build first when an integration test launches files from `dist`.

For documentation-only changes:

```sh
bun run lint
bun run test:diagnostics:policy
```

For implementation changes, finish with the deterministic repository gate:

```sh
bun run test:all
```

The pre-push hook intentionally runs only `bun run lint`. It is fast feedback, not
a substitute for the appropriate test gate. Real-provider and machine-specific
lanes are opt-in; follow [Testing](../tests/README.md) before running them.

Ready, non-draft pull requests report the required `standard-ci` aggregate.
Draft activity does not run hosted validation. Release tags run the full
release workflow, while pushes to `main` retain only the inexpensive post-merge
checks. The workflows themselves are the source of truth for lane selection.

## Implementation discipline

- Reproduce a regression with the smallest focused test before changing code.
- Keep one responsibility per change and run its focused gate while iterating.
- Treat current code, schemas, tests, and runtime evidence as authoritative.
- For layout or render performance work, record the representative baseline first,
  alternate baseline/current measurements, derive tolerances from observed noise,
  and protect algorithmic scaling with deterministic operation-count coverage when possible.
- Keep semantic component state independent of terminal rows and coordinates. Add
  OpenTUI geometry only to a named renderer-boundary module and update its ownership
  inventory test when a new physical adapter is genuinely required.
- Update architecture manifests only through their checked-in generator and
  check commands.
- Keep provider-specific behavior behind its provider boundary.

## Documentation discipline

Documentation records durable user behavior, contributor procedure, contracts,
and invariants. It is not a change journal or a substitute for issue tracking.

- Give each subject one owning document; other docs link to it instead of
  copying its instructions.
- Document a change only when it alters a durable contract or procedure a
  reader must follow.
- Keep plans, phase status, audit findings, acceptance evidence, TODO ledgers,
  and implementation history in issues and pull requests.
- Delete obsolete guidance rather than preserving superseded narratives.
- Prefer current commands and stable decision rules over exhaustive lists of
  regression files or workflow implementation details.
- Protect non-obvious code invariants with a precise nearby comment or JSDoc;
  do not leave essential rationale only in planning material.

## Sources of truth

- `package.json` owns runnable development and test commands.
- `config/vitest/` owns Vitest lane composition and machine isolation.
- `.github/workflows/` owns hosted CI and release automation.
- [Documentation home](README.md) owns the current documentation routes.

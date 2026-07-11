# Development

Status: current living doc for development, test, and documentation workflow.

## Environment

- Use Node.js 24.2+ (and below 25) and pnpm 11. The root `package.json` requires `node: >=24.2 <25`, `pnpm: 11.0.0`, and `packageManager: pnpm@11.0.0`.
- Use the repo-local command during development: `pnpm stn ...`.
- Use `pnpm station:link` only when you intentionally want all three launchers globally bound to the current checkout.
- External tools are optional unless the lane needs them: Worktrunk for real worktree workflows, tmux for the reference terminal provider, and Claude Code, Codex, Cursor, Pi, or OpenCode for real harness workflows.

## Local TUI Workflow

| Need | Command | Boundary |
| --- | --- | --- |
| Normal run | `pnpm stn` / `pnpm stn tui` | Built CLI, configured observer |
| UI hot reload against the selected observer | `pnpm station:ui-dev` | Bun renderer only |
| CLI/package-output watcher | `pnpm dev` / `pnpm station:tui-dev` | Isolated by default, not Bun HMR |
| Isolated Station sandbox | `pnpm station:devbox` | Isolated observer, host, state, and supported hooks |
| Isolated Station sandbox with UI HMR | `pnpm station:devbox dev` | Same devbox isolation, Bun renderer hot reload |

Do not use `station:dev` as a catch-all name until it truthfully owns the UI,
CLI/package, observer, provider, protocol, and host restart boundaries.

- `pnpm stn` opens the normal station popup from the current checkout's built CLI when run inside tmux.
- `pnpm stn tui` opens the normal station TUI fullscreen from the current checkout's built CLI.
- Normal tmux popup fast-path registrations are scoped to the checkout root that created them. A popup launcher from another checkout ignores and clears stale normal popup metadata before falling back to that checkout's CLI.
- `pnpm station:ui-dev` starts the Bun renderer with hot reload for `station/src/**` UI changes from the current checkout.
- `pnpm station:tui-dev` starts the CLI-side dev TUI for the checkout where it is run. It watches the built Node CLI/package outputs, not the Bun renderer source. By default it uses a generated worktree-local config at `.dev-state/tui-dev/config.toml`, with observer `state_dir` and supported harness hook homes under `.dev-state` and a short checkout-keyed socket path under the OS temp dir so Unix socket names do not overflow on long worktree roots. It preconfigures isolated Codex, Claude, Cursor, and OpenCode hooks for that observer. Pass `--config <path>` or set `STATION_CONFIG_PATH` when you intentionally want a specific observer/config. While that process is alive, popup routing can reuse that dev UI only from the same checkout root. If another checkout already owns the dev popup, the command shows that root/session and asks whether to stop it before starting here.
- `pnpm station:devbox dev` starts the isolated Station sandbox with Bun hot reload for `station/src/**`; use it when UI iteration should not connect to the real observer.
- `pnpm station:reset` clears station tmux popup registrations for the current checkout and opens station normally from built code. Inside tmux that means a fresh popup; outside tmux that means the fullscreen TUI.
- `pnpm station:reset:tmux-tui` is the heavier tmux TUI refresh for this checkout. It requires clean `main`, pulls `origin/main`, clears only station TUI/popup tmux state, rebuilds, restarts the observer, then opens station from the rebuilt checkout. It does not kill worktree sessions or harness agents.

## Deterministic Gates

Git-backed fixtures and child processes must clear Git's repository-local environment variables;
`cwd` and `git -C` do not isolate a command when variables such as `GIT_DIR` or `GIT_WORK_TREE`
are inherited. Remove linked worktrees and other Git-created resources through Git before deleting
their directories.

The deterministic local gate is:

```bash
pnpm test:all
```

It runs build, typecheck, lint, unit tests, contract tests, integration tests,
diagnostics tests, the scripted-agent lane, setup E2E coverage, and a production
Observer SQLite restart smoke. It intentionally excludes real provider lanes.

After root `pnpm install`, Lefthook runs the broader local gate before pushes:

```bash
pnpm test:pre-push
```

In addition to `test:all`, it checks cross-runtime SQLite compatibility, the
Station renderer, the native PTY implementation, and the compiled binary on
the developer's current platform. Install both the root pnpm dependencies and
the `station/` Bun dependencies before pushing. GitHub-hosted CI remains the
required PR and `main` gate, including cross-platform PTY coverage; the local
gate is supplementary and can be bypassed with `git push --no-verify`.

Useful focused commands:

```bash
pnpm build
pnpm typecheck
pnpm lint
pnpm test:unit
pnpm test:contracts
pnpm test:integration
pnpm test:sqlite:bun
pnpm test:diagnostics
pnpm test:agent:scripted
pnpm smoke:release
pnpm smoke:install
```

`pnpm test:all` includes `pnpm smoke:install`. The installer smoke uses fake
authenticated GitHub responses and temporary homes, so it is deterministic and
does not download a real release.

Run `pnpm test:sqlite:bun` after `pnpm build` with Bun 1.3.14 available. It
creates observer databases under Node and Bun, then reopens each database under
the other runtime to verify the shared SQLite contract and migrations. Both the
local pre-push gate and the mandatory hosted `station-bun` job run this check.

For focused Station PTY work, run both implementations explicitly:

```bash
cd station
bun run test:pty                 # existing Node/node-pty bridge smoke
bun run build:ctty-helper
bun run test:pty:bun             # Bun.Terminal + controlling-terminal helper
```

To daily-drive the Bun implementation in the isolated devbox, return to the
repo root and start a fresh host with the selector in its environment:

```bash
pnpm station:devbox stop
STATION_PTY_IMPL=bun pnpm station:devbox start
pnpm station:devbox logs --follow
```

The `host.start` record in `.dev-state/observer/logs/station-host.jsonl` should
report `ptyImplementation` as `bun`. `station:devbox restart` deliberately
preserves the existing host, so changing PTY implementations requires `stop`
followed by `start`. Open a shell pane, run `sleep 30`, press Ctrl-Z, run `fg`,
then press Ctrl-C. Finally stop the devbox and confirm no pane payload remains.

For standalone-binary work, Bun 1.3.14 is required. From `station/`, install the
native UI dependencies, return to the repository root, then build and run the
binary smoke:

```bash
bun install
cd ..
pnpm build:binary -- --version 0.7.0
pnpm smoke:binary -- --expected-version 0.7.0
```

The staged artifact is `station/dist/bin/stn`, with `stn-ingress` and
`stn-tmux-popup` symlinks beside it. The build is native-only: it compiles the
portable C controlling-terminal helper with the host `cc`, bundles the Pi
extension, and selects the matching Bun target. Intel/x64 builds use Bun's
baseline target for older CPU compatibility. The smoke runs the binary with a
child `PATH` that contains neither Node nor Bun and covers Observer self-spawn,
ingress and popup argv0 dispatch, packaged assets, hostile working-directory
configuration, and a real host-backed Bun PTY.

To inspect the UX manually after the smoke:

```bash
./station/dist/bin/stn
```

Open a shell pane, run `sleep 30`, press Ctrl-Z, run `fg`, then press Ctrl-C.
The isolated or configured `logs/station-host.jsonl` should record
`ptyImplementation` as `bun`.

To verify binary host upgrades, build two copies with distinct prerelease
versions (for example `0.1.1-host-a` and `0.1.1-host-b`) and use an isolated
config with `station_persistent_agents = true`. Start A, open a hosted terminal,
print a recognizable marker, leave a long command running, and exit the UI so
the host survives. Because Observer version eviction is separate B3 work,
explicitly stop the A observer and start B's observer before launching B.

B must report `HOST_UPGRADE_BLOCKED` with both versions and the live-terminal
count without opening or rewriting the saved layout. Reopen A and confirm the
command and marker scrollback survived. Close every hosted agent and auxiliary
terminal, retry B, then open a hosted terminal so the stopped idle host is
replaced on demand. The next `host.start` record in `logs/station-host.jsonl`
must show B's build and protocol versions. Legacy or different-protocol hosts
refuse automatic replacement and must be stopped explicitly only after their
sessions are accounted for.

## Private Binary Release

Before tagging, an administrator must enable GitHub immutable releases; the
workflow token cannot read that administration setting. The workflow validates
that release tags use supported release SemVer without `+` build metadata,
exactly equal `v${package.json.version}`, come from a commit on `origin/main`,
and have no existing GitHub release. Pushing a `v*` tag runs the callable
standard CI workflow, `pnpm smoke:release`, native binary build and smoke jobs
for all four supported targets, archive/checksum assembly, and an authenticated
installer smoke against the resulting GitHub release draft. The workflow never
publishes the draft automatically.

The initial immutable baseline is `v0.1.1-rc.1`:

1. Enable GitHub immutable releases, merge the A5 implementation with
   `package.json` at `0.1.1-rc.1`, then create and push `v0.1.1-rc.1`.
2. Confirm the draft contains exactly four native archives plus
   `SHA256SUMS`, and that every native build and installer job passed. Immediately
   before publishing, fetch the remote tag and verify its peeled commit
   (`git rev-parse "v0.1.1-rc.1^{commit}"`) still equals the successful release
   workflow SHA recorded in the draft notes; drafts do not receive immutable
   tag protection until publication.
3. Install the explicit RC on clean native machines for `darwin-arm64`,
   `darwin-x64`, `linux-arm64`, and `linux-x64`; complete the manual UX gate
   below, then publish it as a prerelease.
4. Merge only the version change to `0.1.1`, create and push `v0.1.1`, and
   repeat the automated and manual gates against the stable draft.
5. Prove RC-to-stable upgrade and explicit RC rollback before manually
   publishing `v0.1.1` as latest. Repeat the remote-tag/workflow-SHA comparison
   and five-asset inventory immediately before publishing the stable draft.

Published tags and assets are immutable. Recovery may explicitly reinstall a
prior version, but the release line moves forward with a superseding patch; it
never deletes, retags, or overwrites a published release. The source Homebrew
formula is a separate manually dispatched workflow and is not part of this
binary release gate.

If a transient workflow failure leaves an unpublished draft, delete only that
draft and rerun the unchanged tag workflow. If the source needs a fix, leave
the pushed tag alone and use the next prerelease tag. Never delete or mutate a
published release.

Installer acceptance uses the destination lock
`<install-dir>/.station-install.lock`, acquired before release lookup or
download; `<install-dir>/.station-install.lock/owner` records the PID and
requested tag or `latest`. A lock refusal must name the lock path and recorded
owner PID when readable, state that the existing Station installation was
unchanged, and tell the user to wait and retry. The installer never auto-removes
an uncertain lock: after confirming that no installer with the recorded PID is
alive, the operator removes the lock directory manually and retries.

The staged binary's `--version` probe must finish within 10 seconds. A timeout
terminates and reaps the probe and preserves the existing install. HUP, INT,
and TERM use the rollback/cleanup path and exit 129, 130, and 143 respectively.
The verified `stn` rename is the sole runtime commit point: aliases already
resolve to `stn`, and pre-commit caught failures restore the old license and
remove aliases created by that attempt. SIGKILL and power loss cannot clean up;
they may leave a stale lock, stage, or old/new `LICENSE` metadata when the data
and install directories are on different filesystems, but pre-existing runtime
entrypoints must still resolve coherently to the complete old or new binary.

For each target, install through the authenticated script into a clean home and
manually verify the actual user experience, not a dashboard override:

1. With the installed binary's runtime `PATH` containing neither Node nor Bun,
   run bare `stn` outside tmux. Confirm the real OpenTUI first-run screen draws
   and connects to a healthy Observer.
2. Open a shell pane, run `sleep 30`, press Ctrl-Z, run `fg`, then press Ctrl-C.
3. Run `stn setup` to add a project. Confirm the open TUI reconnects and shows
   it after activation on the same Observer socket.
4. Run bare `stn` inside tmux and confirm `stn-tmux-popup` opens the popup.
5. Deliver a provider event through `stn-ingress` and confirm it appears in
   Station.
6. Leave a hosted PTY alive under the RC, run
   `scripts/install.sh --version v0.1.1`, and confirm launch reports
   `HOST_UPGRADE_BLOCKED` without losing the terminal or scrollback. Reinstall
   the RC to reattach and close every hosted terminal; reinstall `v0.1.1` and
   confirm the idle host is replaced.
7. In terminal A, continuously run the installed `stn --version`. In terminal
   B, install RC → stable → RC. Terminal A may print only complete old or
   new versions: never command-not-found or malformed output. After each
   transition, confirm `stn-ingress` and `stn-tmux-popup` still link to `stn`,
   so the runtime never has mixed entrypoints.
8. In an isolated install directory, create an abandoned
   `.station-install.lock` with representative owner metadata. Run the
   installer and follow its printed inspection, manual removal, and retry
   instructions exactly; do not remove the lock until no owner process is
   alive.
9. Interrupt a real authenticated upgrade with Ctrl-C. Confirm the prior TUI
   still opens, the installer exits with status 130 and leaves no owned lock or
   stage, then retry successfully.
10. Run `scripts/install.sh --version v0.1.1-rc.1`, confirm the version changed,
    then reinstall `v0.1.1` to complete the explicit rollback check.

Record the oldest supported macOS version or built-against glibc version in the
release notes. Signing and notarization are not part of A5; integrity is the
authenticated GitHub asset plus `SHA256SUMS` verification and immutable
publication.

For CI install parity, use:

```bash
CI=true pnpm install --frozen-lockfile --ignore-scripts
pnpm test:all
```

## Real And E2E Lanes

Real provider and broader e2e lanes are opt-in:

```bash
pnpm test:e2e
pnpm test:e2e:real
pnpm test:e2e:worktrunk:real
pnpm test:e2e:claude:real
pnpm test:e2e:codex:real
pnpm test:e2e:cursor:real
pnpm test:e2e:pi:real
pnpm test:e2e:opencode:real
pnpm test:e2e:real:local
pnpm test:e2e:real:codex-hooks
```

Use `pnpm setup:system:check` before real lanes. Real lanes may require `STATION_REAL_*` flags, installed provider CLIs, credentials, tmux, model access, and isolated temporary projects. They must not become required for ordinary PR or `main` CI.

## Implementation Discipline

- For meaningful behavior changes, work red-first: write or update focused tests, observe the expected failure or characterize current behavior, implement, and keep the relevant gate green.
- Keep slices narrow. Prefer one contract, provider, observer, TUI, or diagnostics change at a time unless the behavior requires a vertical path.
- Current code, tests, runtime traces, and deterministic fixtures are stronger evidence than historical plans.
- Do not introduce production behavior through docs-only changes.

## Architecture Documentation

- Read [Observer Architecture](observer-architecture.md) before changing Observer boundaries,
  composition, state authority, lifecycle, concurrency, or persistence responsibilities.
- New or materially changed Observer ports, adapter entrypoints, use cases, shared policies,
  and composition roots must follow
  [Architecture Documentation](architecture-documentation.md).
- Update the Observer architecture in the same change when a boundary, dependency rule,
  runtime flow, state lifetime, or registered deviation changes. Ordinary helper refactors do
  not require architecture-document churn.
- Apply role markers to touched seams. Do not classify every exported helper or perform an
  unrelated repository-wide marker backfill.

## TUI Work

TUI work has additional OpenTUI/React and terminal-layout expectations. The terminal UI is the OpenTUI renderer in `station/` (package `@station/workspace`, built on `@opentui/core` + `@opentui/react` + `react`). Use [TUI development](tui.md) before changing `station/` components, hooks, sources, keymaps, selectors, popup behavior, or renderer tests.

## TypeScript And Data Rules

- `exactOptionalPropertyTypes` is intentional. Preserve the difference between an absent optional field and a field set to `undefined`.
- For complex mappers, persistence row conversion, diagnostics construction, error shaping, and provider payload parsing, prefer typed local builders with explicit `if` assignments.
- Small conditional spreads are acceptable when local and obvious.
- Do not use `...(await somePromise)` in production array or object construction. Await into a named local first.
- Use strict schemas for untrusted input and shared payload formats. Avoid parallel hand-written validators for the same shape.
- Treat `unknown` as a boundary-only type. Parse JSON, TOML, CLI output, hooks, and provider payloads once with a strict Zod schema or contract parser, then pass typed values inward.
- Use idiomatic TypeScript and `SafeError` shapes. At error boundaries, convert unknown failures through the repo's SafeError helpers instead of probing Error-like objects by hand.
- If code is `===`-checking JavaScript primitive type strings (`"string"`, `"number"`, `"boolean"`, `"object"`), it is usually the wrong shape even in small helpers: use a schema, discriminated union, inferred type, or typed builder instead.
- Keep primitive `typeof` checks only for truly generic JavaScript interop, recursion, or error-normalization boundaries where no typed contract can exist, and keep them local.
- Do not write little JavaScript-style type helper clusters such as `isRecord`, `asRecord`, `stringField`, `numberField`, or repeated `"key" in value` / `typeof value.foo === ...` checks when a shape already has, or should have, a schema or discriminated TypeScript type.
- If a payload shape is shared, define it in `packages/contracts` and infer the TypeScript type from the schema. If it is provider-private, keep the schema local to the provider adapter/parser.
- Inside already-typed code, use discriminated unions, exhaustive `switch` statements, typed builders, and inferred schema types instead of runtime property probing.
- Runtime shape probing is acceptable for generic recursion, redaction, error normalization, or the first step before schema parsing; keep it small, local, and avoid duplicating a schema.
- Provider-specific diagnostics and behavior must stay behind provider or integration boundaries.
- Do not move raw provider payloads into contracts, normal TUI rendering, protocol-facing shapes, or observer core logic.
- Do not make observer/core scrape provider-specific keys from generic `providerData`. Normalize those values at the provider boundary into contract fields, correlation fields, or provider-owned schema data.

## Agent Guidance Maintenance

- Keep always-loaded guidance concise. `AGENTS.md` should route agents and preserve hard repo quirks, not duplicate long plans.
- Use just-in-time references. Put detailed architecture, development, and debugging guidance in living docs that agents open only for relevant tasks.
- Scope guidance by task and path when possible. A terminal-boundary rule, docs workflow, or runtime-debug procedure should not force every agent to read an old rebuild plan.
- Review instructions periodically. Remove stale mandates, classify historical docs clearly, and update living docs when current code/tests prove a different truth.
- Avoid conflicting instructions. If an old plan, current doc, current test, and runtime evidence disagree, resolve the conflict explicitly instead of adding another overlapping rule.

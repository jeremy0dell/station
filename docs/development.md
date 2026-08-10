# Development

Status: current living doc for development, test, and documentation workflow.

## Environment

- Use Node.js 24.2+ (and below 25) and pnpm 11. The root `package.json` requires `node: >=24.2 <25`, `pnpm: 11.0.0`, and `packageManager: pnpm@11.0.0`.
- Use the repo-local command during development: `pnpm stn ...`.
- Use `pnpm station:link` only when you intentionally want all three launchers globally bound to the current checkout.
- External tools are optional unless the lane needs them: Worktrunk for real worktree workflows, tmux for the reference terminal provider, Claude Code, Codex, Cursor, Pi, or OpenCode for real harness workflows, and `lsof` for fail-closed socket recovery or Observer handoff.

## TypeScript Compiler And Editor

Root and renderer build/typecheck commands use the native TypeScript 7 compiler. The conventional
`typescript` dependency also resolves to TypeScript 7 so repository-aware tools and LSP clients can
discover the native compiler. Tools that import the compiler API use the explicit TypeScript 6
compatibility package until TypeScript 7 provides a stable replacement API. Verify the split with:

```bash
pnpm exec tsc --version
node -p 'require("typescript/package.json").version'
node -p 'require("@typescript/typescript6").version'
cd station && bun run tsc --version
```

VS Code does not select the native language server from this dependency split automatically. To opt
in, install the official [TypeScript 7 extension](https://marketplace.visualstudio.com/items?itemName=TypeScriptTeam.native-preview),
then run **TypeScript: Enable TypeScript 7** or set `"js/ts.experimental.useTsgo": true` in a user or
profile setting. Do not point `js/ts.tsdk.path` at `node_modules/typescript`; that package provides the
native compiler and LSP rather than the legacy `tsserver` plugin layout. Disable the setting or
extension to return to VS Code's standard TypeScript service. Editors that accept a custom LSP
command can start `pnpm exec tsc --lsp --stdio` with the repository root as the working directory;
integrations that require `tsserver` should use the editor's bundled TypeScript service.

## Local TUI Workflow

| Need | Command | Boundary |
| --- | --- | --- |
| Normal run | `pnpm stn` / `pnpm stn tui` | Built CLI, configured observer |
| UI hot reload against the selected observer | `pnpm station:ui-dev` | Bun renderer only |
| CLI/package-output watcher | `pnpm dev` / `pnpm station:tui-dev` | Isolated by default, not Bun HMR |
| Isolated Station sandbox | `pnpm station:devbox` | Isolated observer, host, state, and supported hooks |
| Isolated Station sandbox with UI HMR | `pnpm station:devbox dev` | Same devbox isolation, Bun renderer hot reload |
| Isolated tmux popup with UI HMR | `pnpm station:devbox tmux dev` | Private tmux server, Observer, config/state, and production popup CLI |

Real-state source development is intentionally native-only: use
`pnpm station:ui-dev` for checkout UI code against the selected live Observer.
Station does not support routing checkout popup code through the normal tmux
server against that live runtime; use the private tmux lane for popup transport,
geometry, HMR, and lifecycle validation instead.

Do not use `station:dev` as a catch-all name until it truthfully owns the UI,
CLI/package, observer, provider, protocol, and host restart boundaries.

To test a different worktree without interrupting the devbox or hosted sessions
from this checkout, open a second terminal, `cd` to the worktree under test, and
run `pnpm station:devbox dev` there. Devbox state, sockets, Observer, Host, and
provider homes are checkout-local. See the copy-paste recipe in
[Local development](local-development.md#fast-path-test-another-worktree-and-keep-current-sessions).

- `pnpm stn` opens the normal station popup from the current checkout's built CLI when run inside tmux.
- `pnpm stn tui` opens the normal station TUI fullscreen from the current checkout's built CLI.
- Source popup registrations are scoped to the canonical checkout root that
  created them. Compiled registrations are scoped to the canonical installed
  binary directory instead; neither path may register filesystem root `/`.
- With default popup settings, the optional binding installed by a compiled
  `stn setup` uses the generated direct tmux fast path. Custom geometry, client
  scope, or an enabled popup status bar uses the config-aware exact sibling
  `stn-tmux-popup` alias instead, as does setup run with an explicit `--config` path. The fast path's
  first use can enter that alias, while a valid warm use attaches, toggles, or
  transfers the existing `_station-ui` session without Bun, config loading, or
  Observer startup. Build the binary with
  `pnpm build:binary -- --version <version>` when validating this path; a source
  `pnpm build` does not create the installed artifact ownership used by the
  binding.
- `pnpm station:ui-dev` starts the Bun renderer with hot reload for `station/src/**` UI changes from the current checkout. The foreground native-HMR owner registers a private disposable process group before Bun starts, reaps it on exit or interruption, and recovers an exact abandoned group on the next start. Observer, Station Host, and Host-owned PTYs remain outside that group.
- `pnpm station:tui-dev` starts the CLI-side dev TUI for the checkout where it is run. It watches the built Node CLI/package outputs, not the Bun renderer source. Its watcher restarts the TUI only after the identity-aware whole-graph build publishes a stable `station-build-id` sentinel. By default it uses a generated worktree-local config at `.dev-state/tui-dev/config.toml`, with observer `state_dir` and supported harness hook homes under `.dev-state` and a short checkout-keyed socket path under the OS temp dir so Unix socket names do not overflow on long worktree roots. It preconfigures isolated Codex, Claude, Cursor, and OpenCode hooks for that observer. Pass `--config <path>` or set `STATION_CONFIG_PATH` only to select a controlled development config. This selector retains ordinary CLI Observer startup and handoff behavior; it is not a safe real-state popup lane and should not target a live runtime that must remain undisturbed. While that process is alive, popup routing can reuse that dev UI only from the same checkout root. If another checkout already owns the dev popup, the command shows that root/session and asks whether to stop it before starting here.
- `pnpm station:devbox dev` starts the isolated Station sandbox with Bun hot reload for `station/src/**`; use it when UI iteration should not connect to the real observer. For `start` and `dev`, the nested wrapper first runs `bun install --frozen-lockfile` in `station/`, before creating devbox state or starting the Observer. After isolated Observer and hook setup, it enters the same native-HMR owner as `station:ui-dev`; that owner performs the sole package-link and node-pty repair pass before Bun starts, while UI cleanup leaves the persistent devbox Observer, Host, and agent PTYs intact. `stop` performs no dependency preparation.
- Native-HMR records live at `<state_dir>/run/runtime-owners/v1` in a `0700` directory with `0600` files. Do not delete an uncertain record: the next matching start revalidates owner PID/start identity and the exact disposable PGID before TERM, bounded wait, and any KILL escalation.
- Inspect those records without changing a runtime with `pnpm station:runtime-inventory` or, for this checkout's devbox, `cd station && bun run station:isolated inventory`. Both commands support `--json`; they report keyed/redacted roots, lifecycle evidence, Host PTY count when safely available, and refusal reasons, never raw commands, environment, terminal data, or private paths. Inventory never signals, starts, stops, repairs, or deletes anything.
- Prune one verified abandoned record by first running `pnpm station:runtime-prune -- --runtime <run_uuid>` and then rerunning it with the displayed `--yes --expect-plan <sha256>`. The apply path acquires the same runtime-key lock as startup, rebuilds the plan under that lock, and refreshes record, process-group, cleanup-root, Host, and live-PTY evidence before TERM and any KILL escalation. It refuses active owners, changed or unavailable identities, stale plan digests, protected Host/PTY overlap, and non-temporary or replaced cleanup roots. General socket and persistence roots are classification-only and are never recursively deleted. For a devbox record, use `cd station && bun run station:isolated prune --runtime <run_uuid>`.
- Manually verify pruning only against a controlled isolated runtime: capture its inventory, generate a plan, change the record or replace a cleanup root and confirm apply refuses without a shutdown event, then generate a fresh plan and apply it. The selected owner record and exact binary-smoke cleanup root should disappear; unrelated Host and PTY processes must remain present in the next inventory.
- Before Observer startup, `station:devbox` creates or repairs only its checkout-keyed socket directory to mode `0700`. It refuses symlinks, non-directories, and directories owned by another user; it never repairs or replaces socket and claim files.
- If a devbox socket is inaccessible, startup exits nonzero without replacing the Observer or `.dev-state` and prints recovery commands. Restore access (normally mode `0600`) or install the named `lsof` executable, inspect with `pnpm station:devbox status`, then rerun the same start command; it reconnects to the original Observer. `pnpm station:devbox reset -- --yes` is only for intentionally disposable state because it deletes `.dev-state` and its agents.
- `pnpm station:devbox tmux dev` builds the checkout, starts or safely reuses a checkout-keyed private tmux server and isolated live Observer, claims cleanup ownership, and attaches the invoking terminal. Inside that client, `Ctrl-b Space` invokes the built production `popup` command while its Bun dashboard child hot-reloads `station/src/**`; `Ctrl-b d` detaches and cleans up the owned lane. Use `tmux start` plus `tmux attach` when automation needs a persistent lane that is stopped explicitly.
- `pnpm station:reset` clears station tmux popup registrations for the current checkout and opens station normally from built code. Inside tmux that means a fresh popup; outside tmux that means the fullscreen TUI.
- `pnpm station:reset:tmux-tui` is the heavier tmux TUI refresh for this checkout. It requires clean `main`, pulls `origin/main`, clears only station TUI/popup tmux state, rebuilds, restarts the observer, then opens station from the rebuilt checkout. It does not kill worktree sessions or harness agents.

### Private tmux popup devbox

Install the root and Station dependencies, then start the interactive lane:

```bash
pnpm install
cd station && bun install && cd ..

pnpm station:devbox tmux dev
# Ctrl-b Space opens Station
# Ctrl-b d exits and cleans up
```

The lane creates `/tmp/stn-dbx-<checkout-hash>` at mode `0700`, one private
`tmux -L stn-dbx-<checkout-hash> -f /dev/null` server, an isolated live
Observer, empty provider homes, a committed disposable Git project, and a
strict minimal config. It never seeds real auth, Git, SSH, hooks, config, or
default tmux state. `status` inspects only the recorded private manifest,
server, sockets, and matching processes.

Attach preserves the caller's `TERM` only when ncurses `tput` can resolve it
inside the isolated environment with tmux's required `clear` and `cup`
capabilities. Caller-specific `TERMINFO`, `TERMINFO_DIRS`, and external XDG data
paths are intentionally not imported. An absent, unavailable, or unsuitable
terminal falls back to `xterm-256color`; a rejected value is named in the
fallback diagnostic, so the documented attach command never needs a manual
`TERM` prefix.

Use `Ctrl-b Space` in the attached base session. The binding enters the built
CLI's production `popup` command; `_station-ui` owns the long-lived CLI parent,
which retains the renderer-control IPC channel while the Bun renderer reloads
in place. `dev` remains in the foreground, owns its attached client, and performs
the same scoped cleanup after `Ctrl-b d`, Ctrl-C, SIGHUP, SIGTERM, or a coordinated
external `stop`. Use `start` instead when automation needs the lane to return
immediately; a standalone `attach` never takes cleanup ownership. Detach any
split-command clients before switching to `dev`, which refuses before rebuilding
an attached persistent lane.

| Changed surface | Required action |
| --- | --- |
| Dashboard-imported `station/src/**` | Bun HMR only |
| Linked `packages/*` output, CLI, Observer, providers, protocol, or tmux integration | Detach/stop → `tmux dev` (builds before startup) |
| Station Host or PTY runtime | Full detach/stop → `tmux dev` |
| Dependencies or Station package links | Detach/stop, install/relink, then `tmux dev` |
| Generated root/config/wrapper ownership | `tmux reset --yes` → `tmux dev` |

There is intentionally no `tmux restart`: a rebuild boundary must replace the
CLI, Observer, popup signature, and any optional Host coherently. Diagnostics
and cleanup commands are:

```bash
pnpm station:devbox tmux status
pnpm station:devbox tmux logs --follow
pnpm station:devbox tmux stop
pnpm station:devbox tmux reset --yes
```

The explicit real-lane smoke is excluded from `test:all` because it requires
tmux, Bun, Python 3, PTY interaction, and a temporary source edit:

```bash
pnpm station:devbox:tmux:smoke
```

That smoke owns public grammar, generated-environment isolation, wrapper
auditing, attach UX, live repaint, signal exits, and cleanup.
`STATION_REAL_TMUX=1 pnpm test:tmux-popup:real` is the exact production-popup
acceptance lane: it owns popup claims, keyboard input through an attached outer PTY,
terminal-driven resize propagation, rendered focus outcomes, warm reuse,
compiled binding behavior, and its own private fixture cleanup. The canonical
99×25 capture is checked against
`integrations/terminal/tmux/test/fixtures/real-dashboard-99x25.frame.json`.
Full-frame captures use the private wrapper and preserve trailing cells;
assertions wait for two identical captures rather than accepting an
intermediate repaint.

## Guided setup development

Guided `stn setup` uses `@clack/prompts` through the sole production import in
`apps/cli/src/commands/setup/presenters/clack.ts`. Keep direct Clack imports out of the guided
driver, setup core, providers, config, and tests; presenter unit tests inject the exported plain function
object instead of mocking the package globally. Bare guided setup requires TTY stdin and stdout,
while check, plan, explicit apply, system, help, and JSON surfaces remain noninteractive.

For manual UX exploration, run the real guided flow in a disposable sandbox:

```bash
pnpm setup:guided:sandbox
pnpm setup:guided:sandbox -- --profile multi --keep
pnpm setup:guided:sandbox -- --profile everything-missing --keep
```

The sandbox builds the checkout, creates a committed disposable repository, then launches the real
CLI with inherited terminal I/O. An `env -i` boundary relocates `HOME`, every XDG directory, config,
Observer state and sockets, and all provider homes beneath one private temporary root. Fake
Homebrew, curl, npm, pnpm, Worktrunk, tmux, and agent commands prevent network access and global
installation while allowing accepted installer operations to re-probe their sandbox executables. The real Observer runs
only against the sandbox paths and is stopped when setup exits.

The default `first-run` profile has required tools but no agent CLI. `multi` starts with Codex and
OpenCode, `missing-tools` starts with those agents but no required tools, and `everything-missing`
exercises both installer stages. During UX review, the guided opening should contain only its trust
copy, compact inspection progress, and selected prerequisite proposal; the
Core/Recommended/Actions/Next matrix belongs to `stn setup check`. Verify selected Homebrew tools
show compact clickable Formulae labels rather than raw URLs, prompt details are visually secondary
to the first-line decision, and no resolved sandbox shim path leaks into consent copy. The tmux
consent must explain that prefix + Space opens Station, and setup must reject a user-configured
assignment while permitting tmux's built-in `next-layout` default. Use `--keep` to retain the printed root, edit any shim under its
`bin/` directory from another terminal, inspect `external-commands.log`, and rerun its `run-setup`
launcher. `--prepare-only` creates that environment without starting setup. Without `--keep`, the
root is removed after completion or cancellation; no profile reads credentials, provider config,
shell startup files, normal tmux state, or global Station state.

The automated real-terminal lane requires Python 3 and uses the standard-library `pty` module:

```bash
pnpm exec vitest run --config config/vitest/vitest.unit.config.ts \
  apps/cli/test/unit/setup-clack-presenter.test.ts
pnpm test:e2e:setup:guided
pnpm test:e2e:setup:guided:all-shells
```

Both guided entrypoints run under a disposable runtime owner
(`scripts/test-runners/run-setup-guided-e2e.mjs`): it registers a private
`setup-guided-e2e` owner record before Vitest spawns, reaps the exact
supervised process group on normal completion, interruption, or terminal loss,
and recovers only an exact registered abandoned group on the next start.
Records live at `<state_dir>/run/runtime-owners/v1` beside the other disposable
runtime records, and lifecycle events reach `<state_dir>/logs/cli.jsonl` through the
existing `stn debug logs` surface. Fixture cleanup inside the tests remains
defense in depth, not the sole owner; do not invoke Vitest directly for the
guided suites except through the owner's passthrough arguments.

The PTY support normalizes terminal controls and redraws. When intentional copy or layout changes
alter `apps/cli/test/fixtures/setup-guided-transcript.txt`, regenerate from the fixed 100×24 happy
scenario with the command below, review the normalized transcript manually, and verify it contains
no environment paths, JSON envelopes, provider values, or raw operation structures:

```bash
STATION_UPDATE_SETUP_TRANSCRIPT=1 pnpm test:e2e:setup:guided -- \
  -t "writes multiple selected agent CLIs"
```

Python must never reach the user's
Station homes, config, state, sockets, provider homes, or tmux server.

After changing Clack or another shipped dependency, run the normal build and static gates, then
validate the compiled runtime:

```bash
pnpm build:binary -- --version 0.0.0-local
pnpm smoke:binary -- --expected-version 0.0.0-local
```

At minimum, exercise the compiled binary's non-TTY guided preflight to prove the packaged dependency
loads before release validation.

## Deterministic Gates

### Deterministic test isolation

Each test lane declares one of four boundaries: automatic per-file machine isolation, lane-owned
fixtures, an explicitly controlled process runner, or intentional machine interaction. The boundary
is an environment and default-path guarantee, not an OS security boundary.

| Lane | Config or runner | Classification | State and environment ownership |
| --- | --- | --- | --- |
| Unit | `vitest.unit.config.ts` | Automatic machine isolation | One private machine root and restored environment per test file. |
| Integration | `vitest.integration.config.ts` | Automatic machine isolation | One private machine root and restored environment per test file. |
| Contracts | `vitest.contracts.config.ts` | Automatic machine isolation | Schema tests stay pure while new files fail closed onto private defaults. |
| Diagnostics | `vitest.diagnostics.config.ts` | Automatic machine isolation | Diagnostics and their child processes start from private machine defaults unless a test supplies an explicit environment. |
| Scripted agent | `vitest.agent-scripted.config.ts` | Automatic machine isolation | Scripted harness state, provider homes, Git defaults, and child processes inherit the private file root. |
| Setup E2E | `vitest.setup-e2e.config.ts` | Lane-owned fixtures | Each fixture constructs its complete home, PATH, provider shims, runtime directory, and hostile inputs; a parent sandbox would mask missing fixture inputs. |
| Observer and general E2E | `vitest.e2e.config.ts` | Lane-owned fixtures | Tests own config, state, sockets, repositories, and Observer process cleanup, including deliberate default-path scenarios. |
| Installer smoke | `scripts/test-runners/run-install-smoke.mjs` | Controlled process runner | The runner supplies a private root and sanitized install, config, state, and tool environment. |
| SQLite and Observer-claim cross-runtime | `scripts/test-runners/run-sqlite-cross-runtime.mjs` and `scripts/test-runners/run-observer-claim-cross-runtime.mjs` | Lane-owned process paths | Runners own temporary databases, sockets, claims, and cleanup while inheriting only the ambient toolchain needed to launch Node and Bun. |
| Station renderer and PTY | `pnpm test:ci:station` | Intentional non-Vitest exception | Bun tests own focused temporary fixtures; there is no suite-wide machine sandbox, so tests must not use default Station paths for mutation. |
| Binary smoke and handoff stress | `scripts/test-runners/run-binary-smoke.mjs` | Controlled process runner | The runner owns private build, worktree, config, state, evidence, and child-process paths while preserving required build-tool discovery. |
| Build, typecheck, and lint | Root package scripts | Checkout tooling | These commands intentionally read the checkout and write declared build outputs; they are not test-machine sandboxes. |
| Real provider, Worktrunk, E2E, and tmux popup | Real Vitest configs below | Intentional machine interaction | These opt-in lanes exercise installed providers, real worktrees, or a real tmux server and retain their deliberate machine contract. |

The automatic group is exactly `vitest.unit.config.ts`, `vitest.integration.config.ts`,
`vitest.contracts.config.ts`, `vitest.diagnostics.config.ts`, and
`vitest.agent-scripted.config.ts`. Each creates a private machine root for every test file. The
shared setup redirects home, temporary, XDG, harness, Git, GitHub CLI, and shell-history paths;
clears Station runtime/correlation overrides plus inherited Git, SSH, and GitHub credentials; and
passes the sandbox paths to child processes. The root is removed after the file, including ordinary
test failures.

Use `vi.stubEnv` for test-local environment changes and let the shared setup restore the complete
per-file baseline. Environment-mutating tests must not use `it.concurrent` or otherwise overlap in
the same file because `process.env` is process-global. Set `STATION_TEST_MACHINE_KEEP_ROOT=1` for a
focused automatic-lane run to retain the root and print its location, inspect it, and remove it
manually afterward.

The intentional real-machine configs are `vitest.real-e2e.config.ts`,
`vitest.claude-real.config.ts`, `vitest.codex-real.config.ts`,
`vitest.cursor-real.config.ts`, `vitest.opencode-real.config.ts`,
`vitest.pi-real.config.ts`, `vitest.tmux-popup-real.config.ts`, and
`vitest.worktrunk-real.config.ts`. They do not compose the automatic setup. Setup E2E and Observer
E2E also omit it because their owned environment construction is part of what those lanes test.

Automatic isolation prevents accidental inheritance and environment leakage. It does not contain
explicit absolute paths, signals, file descriptors, network access, custom child environments,
installed tools, or subprocesses that deliberately escape the redirected environment. The
OS-level containment decision belongs to #401.

Git-backed fixtures and child processes must clear Git's repository-local environment variables;
`cwd` and `git -C` do not isolate a command when variables such as `GIT_DIR` or `GIT_WORK_TREE`
are inherited. Lefthook commands run through `scripts/run-without-git-locals.mjs`, which removes
the complete variable list reported by the installed Git before launching any hook descendants.
This hook boundary is defense in depth: independently invoked Git-backed fixtures must still clear
their own child environments. Remove linked worktrees and other Git-created resources through Git
before deleting their directories.

`pnpm build` computes one immutable Observer build identity from the current
Git `HEAD`, the sorted production inputs from tracked plus untracked-nonignored
working-tree contents, and the resulting production package `dist` contents.
Test trees and TypeScript test/spec files are excluded to match Turbo's
production build inputs. It rebuilds, verifies the inputs did not move, then
atomically publishes `packages/runtime/dist/station-build-id`. Source
CLI/Observer output and a binary compiled from that output therefore share an
identity; rebuilding unchanged inputs and outputs reuses it. A source process
verifies both halves before first adopting the sidecar, then reuses that
verified identity without further Git or hash I/O for its lifetime. That first
verification prevents a scoped compile, cache restore, source edit, or failed
build from silently claiming an older identity. Run `pnpm build` again; do not
copy or retain this sidecar across a failed or different build.

Observer architecture has three focused commands:

```bash
pnpm architecture:observer:generate
pnpm architecture:observer:check
pnpm architecture:observer:visualize
```

Generation validates the source graph and controlled JSDoc first, then
atomically refreshes
`docs/generated/observer-architecture-manifest.json`. Check mode validates the
same graph and byte-compares the committed artifact. If check mode reports only
a stale artifact, run the generation command and review the generated diff; fix
any earlier architecture diagnostics before regenerating. Visualization runs
check mode first, then serves a local D3 hexagonal-role overview at
`http://localhost:3000`, with the raw module-import graph available as a
secondary view; it does not write another generated artifact.

`pnpm lint` invokes the check once. `pnpm test:all`, the lint-only pre-push hook,
pull-request static validation, documentation-only validation, and the `main`
smoke inherit it through lint; do not add a second architecture invocation to
those gates.

The deterministic local gate is:

```bash
pnpm test:all
```

It runs build, typecheck, lint, unit tests, contract tests, integration tests,
diagnostics tests, the scripted-agent lane, setup and Observer lifecycle E2E
coverage, and a production Observer SQLite restart smoke. It intentionally
excludes real provider lanes.

After root `pnpm install`, Lefthook runs lint before commits and pushes:

```bash
pnpm test:pre-push
```

The pre-push hook is intentionally lint-only so pushing does not repeat the hosted deterministic
gate. Use `pnpm test:all` or the focused commands below when local behavior needs validation.
Install the `station/` Bun dependencies only for Station renderer, PTY, or compiled-binary work.

Ready, non-draft pull requests fan out static validation, root tests, setup E2E, Observer E2E,
cross-runtime SQLite, Station renderer and PTY tests, and selected installer and binary smokes on
independent `ubuntu-24.04` jobs. Documentation-only changes run lint and diagnostics policy tests.
Installer smoke runs when installer, release, dependency, or CI infrastructure changes; binary
smoke runs when production, binary, dependency, or CI infrastructure changes. Observer-sensitive
changes use the exhaustive claim-race counts, while setup- and Worktrunk-sensitive changes retain
both bash and zsh process-level setup coverage. One aggregate job named `standard-ci` preserves the
repository ruleset contract and fails if a mandatory or path-selected lane is unexpectedly skipped.
A failed binary-smoke step best-effort uploads one redacted, allowlisted evidence directory capped at
1 MiB with three-day retention; a successful step creates and uploads no evidence directory, and
artifact upload failure cannot mask the smoke failure.

Release tags select every lane, use the exhaustive claim-race counts and both setup shell paths, and
call that parallel gate before adding the four native build and draft-install targets. Both `standard-ci` and
`smoke:release` must pass before any native release build starts. Draft pull request activity
allocates no runner, including synchronization before `ready_for_review`. Pushes to `main`
run only build, typecheck, and lint as a cheap post-merge smoke. The repository ruleset must
require the pull-request `standard-ci` check and block direct `main` pushes; the cheap smoke is a
post-merge backstop, not a substitute for the full required gate.

Useful focused commands:

```bash
pnpm build
pnpm typecheck
pnpm lint
pnpm architecture:observer:generate
pnpm architecture:observer:check
pnpm architecture:observer:visualize
pnpm test:unit
pnpm test:contracts
pnpm test:integration
pnpm test:e2e:observer
pnpm test:e2e:setup:guided:all-shells
pnpm test:observer-claim:cross-runtime
pnpm test:sqlite:bun
pnpm test:diagnostics
pnpm test:agent:scripted
pnpm smoke:release
pnpm smoke:install
```

Native Station per-TTY ownership has a focused Bun suite and a private real-PTY
acceptance lane:

```bash
cd station
bun test src/singleInstance.test.ts
bun run typecheck
cd ..

STATION_REAL_E2E=1 pnpm exec vitest run \
  --config config/vitest/vitest.real-e2e.config.ts \
  tests/e2e/real/real-native-tui-singleton.test.ts

STATION_REAL_E2E=1 pnpm exec vitest run \
  --config config/vitest/vitest.real-e2e.config.ts \
  tests/e2e/real/real-native-hmr-lifecycle.test.ts

pnpm build:binary -- --version 0.0.0-local
STATION_REAL_E2E=1 \
STATION_COMPILED_BIN="$PWD/station/dist/bin/stn" \
pnpm exec vitest run \
  --config config/vitest/vitest.real-e2e.config.ts \
  tests/e2e/real/real-native-tui-singleton.test.ts
pnpm smoke:binary -- --expected-version 0.0.0-local
```

The real lane requires macOS or Linux, Bun, and Python 3. It owns its PTY and
fixture processes and does not use the user's Station configuration.

Dead-code audits are repository-owned and cover both the pnpm monorepo and the separate
`station/` Bun workspace:

```bash
pnpm deadcode                 # all source, tests, exports, and development dependencies
pnpm deadcode:production      # code and dependencies reachable from shipped entrypoints
```

The full audit should pass cleanly. The production audit excludes test and development consumers,
so it may list deliberate test-support exports alongside product-only cleanup candidates.
`knip.jsonc` records executable files that are reached through package scripts, subprocess path
strings, binary packaging, or Bun test discovery. TypeScript also rejects unused locals and
parameters in both the root packages and Station workspace. Treat Knip findings as candidates:
confirm dynamic and external entrypoints before removal, and do not use Knip's automatic file
removal. Neither command is part of `test:all`; run the relevant focused tests and deterministic
gates after each reviewed cleanup slice.

`pnpm test:all` includes `pnpm smoke:install`. The installer smoke uses fake
public `curl` downloads and authenticated draft responses in temporary homes,
including first-argument `--disable` isolation, receipt creation and inode
preservation, strict expected-installation parsing, binary/launcher/receipt
identity races, startup-file
non-interaction, safely evaluated minimal-PATH guidance, physical launcher
resolution, and normalized-colon preflight coverage. It is deterministic, does
not download a real release, and does not read or modify real shell startup
files. The path-selected installer CI job runs it once. On a heavily contended local host, run
`STATION_INSTALL_SMOKE_TIMEOUT_SCALE=4 pnpm smoke:install` to scale only the
harness deadlines; the default and hosted gate remain strict.
The release workflow builds and smokes the compiled binary on all four native
targets, then installs each actual draft asset with real platform utilities and
requires the exact receipt. The focused
`apps/cli/test/integration/installer-binary-update.test.ts` fixture invokes the
real `scripts/install.sh` against fake exact-tag assets to prove atomic binary
replacement, physical `--version` execution, stable launchers and receipt, and
invocation-boundary race refusal.

Run `pnpm test:sqlite:bun` after `pnpm build` with Bun 1.3.14 available. It
creates observer databases under Node and Bun, then reopens each database under
the other runtime to verify the shared SQLite contract and migrations. It also
runs the exhaustive boot-claim stress: 50 alternating Node/Bun two-process rounds,
10 three-contender rounds, and killed-owner recovery with stable inode and
`integrity_check=ok`. Pull-request CI uses `pnpm test:sqlite:bun:pr` for five two-process and two
three-contender rounds; Observer-sensitive pull requests and release tags retain the exhaustive
counts. The scheduled `nightly-observer-claim` workflow runs the same exhaustive command against
`main` each day so a low-frequency race cannot remain latent until a release. Both commands also
check Node/Bun inaccessible and stale classification plus displaced-listener abandonment; the
claim gate makes no fairness claim.

`pnpm test:e2e:observer` drives the built production Observer through cold and
real stale-socket races, read-only snapshot refusal, XDG/state divergence,
explicit paths with spaces,
claim-held no-side-effect behavior, pidfile publication, compatible-build reuse,
same-version build-identity handoff and refusal, cross-version graceful handoff,
inaccessible-socket preservation, displaced shutdown, clean restart while the
persistent claim remains, and guarded duplicate inspection with keeper
preservation. Duplicate-cleanup changes must additionally prove dormant
candidates, startup-contender and unrelated-socket-FD refusal, quarantine
cancellation, SIGTERM-only survivor behavior, and absence of automatic
SIGKILL. The compiled binary smoke
also builds a second artifact from one production-source change in an isolated
detached worktree, queries both exact selectors, proves lower-to-higher
same-version replacement and post-handoff mutation refusal, then proves
source/compiled ordering and Station Host PTY continuity across both Observer
replacements. In the mixed source/compiled branch it also proves that lower-build
native and public-popup Station launchers refuse exact-selector admission before
renderer, reconcile, tmux, Host, PTY, or layout mutation while non-UI lower-build
reuse remains available. Singleton-cleanup promotion must also prove the same guarded
SIGTERM-only behavior under the compiled Bun artifact before production
composition leaves report-only mode. The smoke also chmods the physical Observer socket to `000`, proves status,
start, restart, doctor, and ingress preserve the original PID/socket/pidfile,
then restores access and drains the one spooled event. Run both after `pnpm build` when changing startup, socket
ownership, pidfiles, or claim lifecycle behavior.

For focused Station PTY work, run both implementations explicitly:

```bash
cd station
bun run test:pty                 # existing Node/node-pty bridge smoke
bun run build:ctty-helper
bun run test:pty:bun             # Bun.Terminal + controlling-terminal helper
```

Both PTY lanes include the pinned Pi 0.80.10 capability detector in real local
and Station Host-backed child processes. They prove equivalent Station-owned
capabilities while requiring persistent Host spawns to fail closed on tmux
provenance. Both lanes are part of hosted `standard-ci` and remain available as focused local
commands.

The isolated two-renderer controller regression requires both PTY prerequisites,
then starts a fresh Host for each `bridge` and `bun` implementation without using
the configured Station runtime:

```bash
pnpm --dir station repair:node-pty
pnpm --dir station build:ctty-helper
pnpm test:e2e:real:local tests/e2e/real/real-native-tui-pty-control.test.ts
```

It attaches differently sized `hostAttachedTerminal` renderers to one real child
and verifies shared output, geometry-before-input takeover, viewer resize
suppression, and later resize noise from the revoked renderer.

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
pnpm build:binary -- --version 0.0.0-local
pnpm smoke:binary -- --expected-version 0.0.0-local
```

The staged artifact is `station/dist/bin/stn`, with `stn-ingress` and
`stn-tmux-popup` symlinks beside it. The build is native-only: it compiles the
portable C controlling-terminal helper with the host `cc`, bundles the Pi
extension, and selects the matching Bun target. Intel/x64 builds use Bun's
baseline target for older CPU compatibility. The smoke runs the binary with a
child `PATH` that contains neither Node nor Bun and covers Observer self-spawn,
ingress and popup argv0 dispatch, packaged assets, hostile working-directory
configuration, and a real host-backed Bun PTY.
The `0.0.0-local` display version exercises cross-version Observer handoff. The
smoke first builds two independently stamped binaries at that display version,
runs the lower identity as incumbent, replaces it with the higher identity, and
verifies that a later mutating command from the loser is refused without
changing the Observer, Station Host, or live PTY. The same `0.0.0-local` lane
then runs its mixed source/compiled native and popup admission checks against the
higher source Observer and verifies the complete runtime baseline is unchanged.
It requires a committed clean checkout so the detached-worktree artifact has one
controlled source delta; do not weaken or bypass that requirement.

Before any child starts, the runner records one disposable process group for
the smoke runner, Observer, Station Host, and popup renderer in private,
checkout-and-mode-keyed owner state. INT, TERM, and HUP cleanup sends TERM
first, escalates only after bounded identity revalidation, and records the
result in the failure bundle's `runtime/lifecycle.jsonl`. Unrelated persistent
Station runtime remains outside that group. The next ordinary binary-smoke or
handoff-stress start reopens the same owner state and rescues only an owner-dead
exact group; device-and-inode-pinned abandoned roots remain carried forward
until exact deletion succeeds. Ambiguous process or root identity is preserved.

For a local failure bundle, name an absolute path that does not exist and is
outside the smoke root:

```bash
STATION_BINARY_SMOKE_EVIDENCE_DIR=/absolute/new/path \
  pnpm smoke:binary -- --expected-version 0.0.0-local
```

The outer launcher refuses an existing destination before spawning, then
reserves it with a private per-run marker that is removed after an uncaptured
success. The same per-run ID binds capture and finalization to the current
invocation, including outer capture after a hard-killed inner runner. Failure or
cancellation evidence is captured before teardown and finalized once after
exact group and root cleanup while preserving the original failure. `complete`
requires the owned group, private roots,
Observer and Host sockets, and Observer pidfile all to be absent. Inspect
`manifest.json` first; `rounds/*/runtime/lifecycle.jsonl` shows registration,
signal, escalation, refusal, rescue, and final zero-residue counts. In hosted
CI, use:

```bash
gh run download <run-id> \
  --name binary-smoke-evidence-<run-id>-<attempt> \
  --dir /tmp/station-binary-smoke-evidence-<run-id>
```

The focused handoff stress reuses immutable current and alternate binaries for
fresh isolated rounds and stops at the first failure without rebuilding or
retrying a handoff:

```bash
STATION_BINARY_SMOKE_EVIDENCE_DIR=/absolute/new/path \
  pnpm stress:binary-handoff -- \
  --expected-version 0.0.0-local \
  --rounds 50 \
  --round-timeout-ms 30000
```

Each round proves the logical lower-to-higher replacement, exact PID/build and
socket/pidfile ownership, one healthy Observer, live Host PTY continuity, and
then the reverse physical call's deterministic reuse or refusal without winner
mutation. With one fixed artifact pair, that reverse call is not a second valid
replacement direction. The `Binary handoff stress` workflow exposes the same
lane through manual dispatch on Ubuntu 24.04 with at most 100 rounds; it is not a
required PR or nightly lane. If rounds were independent at the previously
observed 13.8% failure rate, 50 rounds would have about a 99.94% chance of a
failure and zero failures would imply only an approximate one-sided 95% upper
bound of 5.8% (about 3% for 100 and 1% for 300). Hosted timing can be correlated,
so these runs increase confidence but do not prove absence.

To inspect the UX manually after the smoke:

```bash
./station/dist/bin/stn
```

Open a shell pane, run `sleep 30`, press Ctrl-Z, run `fg`, then press Ctrl-C.
The isolated or configured `logs/station-host.jsonl` should record
`ptyImplementation` as `bun`.

Host upgrade handoff is gated by automated lanes (preferred over a manual A/B
binary pair for day-to-day validation):

```bash
pnpm --dir station test:pty          # includes hostHandoff.smoke (STATION_PTY_SMOKE=1)
pnpm test:e2e:host-upgrade           # A→B refuse, gated TUI handoff, and warm-reattach smoke
```

The smoke uses test-only `--build-version` overrides on `hostMain` (requires
`STATION_HOST_ALLOW_BUILD_VERSION_OVERRIDE=1`) so two host identities share one
checkout entrypoint. Cases covered: busy refuse without
opt-in (`HOST_UPGRADE_BLOCKED`, child survives), negotiated
`beginHandoff` → `completeHandoff` → successor `adoptRegistry` with the same
child PID, idle `stopIfIdle` remains the empty-host path, multi-PTY + abort +
recovery, and a packaging-shape handoff (source-style `bun hostMain` → trampoline
successor argv, proving adopt still works when the successor is not launched with
the same command prefix), plus the native TUI inventory path building a warm
restore plan from successor PTYs and receiving replayed and later live output.
Set `STATION_BINARY_PATH=/path/to/stn` to additionally
exercise a real compiled `__station-host` successor in that packaging case.

### Source ↔ binary and `station:devbox`

Host compatibility is display `buildVersion` + protocol major only — not
`compiled` vs source, and not Observer content identity. Consequences:

- Source and a binary that report the **same** display version **reuse** the host;
  `stn host handoff` refuses as unnecessary.
- Different display versions with matching protocol are `replace`; busy hosts still
  default to `HOST_UPGRADE_BLOCKED` until someone opts into handoff. The successor
  packaging follows the requesting CLI (`bun hostMain.ts` vs `<stn> __station-host`).
- Protocol major skew never handoffs.
- Both sides must target the same socket/state dir (same config). Global state and
  a worktree `.dev-state` are different islands.
- `pnpm station:devbox` always wants a Bun source host. Mixing a binary
  `stn host handoff` into that socket can flip packaging; `station:devbox status`
  warns on mismatch. Prefer `stop` then `start` to restore the source host.
  `restart` recycles the Observer only and intentionally leaves the host alive.

CLI surface for operators:

```bash
pnpm stn host status
pnpm stn host handoff --dry-run
pnpm stn host handoff --fidelity processes|screen
pnpm station:devbox status           # warns if host build ≠ this checkout's CLI
```

Manual UX check (optional): use one isolated config/state directory with
`station_persistent_agents = true`. Launch build A, start a hosted pane, print a
marker, leave a long command running, record its pane PID and PTY instance, and
exit the UI. Launch build B without `STATION_HOST_HANDOFF`; it must report the
unchanged `HOST_UPGRADE_BLOCKED` refusal while A's pane PID stays alive. Then run
the same native TUI launch as `STATION_HOST_HANDOFF=1 <build-B-stn>` against that
state. The pane must warm-reattach with the same PID and PTY instance, show the
pre-handoff marker, and display new live output. Legacy or different-protocol
Hosts still refuse handoff and must be stopped explicitly only after their
sessions are accounted for.

## Hosted Workflow Security

External GitHub Actions must use reviewed full commit SHAs with human-readable version comments. Repository-local actions and reusable workflows are tied to the checked-out commit and are exempt from external pinning. Every checkout disables persisted credentials.

Dependabot proposes individual action-pin updates each week. Reviewers must verify official repository ownership, release notes, changed runtime and permissions, and the tag-to-SHA correspondence before merging; Dependabot is an update mechanism, not an approval mechanism.

The nightly Claude compatibility lane intentionally resolves npm's current `latest` release once, validates and installs that exact version, and records the resolved version, installed version, and registry-reported integrity in the run summary. That integrity value is run evidence, not an independent trust root. Authentication uses a dedicated, limited, environment-scoped credential available only to the real-Claude execution step.

Release write access is limited to jobs that create, inspect, or publish draft releases. Public-install verification is tokenless. `tests/diagnostics/ci-workflow-policy.test.ts` enforces action pins, checkout credential handling, release permissions, and nightly secret scope.

## Experimental Pre-Alpha Release

Before tagging, an administrator must enable GitHub immutable releases; the
workflow token cannot read that administration setting. The workflow validates
that release tags use supported release SemVer without `+` build metadata,
exactly equal `v${package.json.version}`, come from a commit on `origin/main`,
and have no existing GitHub release. Pushing a `v*` tag runs the callable
standard CI workflow, `pnpm smoke:release`, native binary build and smoke jobs
for all four supported targets, archive/checksum assembly, and an authenticated
installer smoke against the resulting GitHub release draft. The four native
release builds use one archive-packaging helper. Assembly stamps the validated
tag into the existing `embedded_version=""` marker and publishes that
`install.sh` beside the archives. Draft-install jobs download and run the actual
stamped draft asset with the captured numeric release ID and no version
argument. After all four native installs pass, the workflow re-downloads the
six draft assets,
verifies them against the build checksum, and uploads an immutable
`accepted-release-candidate-*` Actions artifact containing the commit, release
ID, asset IDs, and checksums. Draft install and candidate-recording jobs use
contents write permission because GitHub exposes draft releases only to
identities with push access, but their steps only read release metadata and
assets. Only draft creation and manual promotion mutate releases. The tag
workflow never publishes the draft automatically. Promotion publishes the
accepted draft, then four native jobs download the exact-tag public installer
without GitHub credentials or a `gh` executable and run it end to end.

### Launcher PATH release acceptance

For every release candidate, retain the complete installer output and
distinguish two successful setup lanes. Running setup through the absolute
installed fallback while its directory is absent from `PATH` must exit
successfully and preserve the all-three launcher warning, exact installed
paths, a safely quoted current-shell PATH block, optional PATH-not-alias
convenience guidance with all-three `command -v` checks, and absolute doctor and
launch commands. That mismatch output must not recommend executing bare `stn`
commands. Running the installer's current-shell block first must make setup's
final current-process probe clean and keep completion concise.

Neither lane proves future-login behavior. Setup must not emit a future-shell
export or modify a startup file. Copy the installer's future-shell export into
a user-chosen configuration, open a genuinely new login shell, and physically
verify all three aliases with `test ... -ef` before accepting the release.
Repeat the mismatch lane with one shadowed alias and an install directory
containing spaces and apostrophes. Source-checkout acceptance separately
requires the preserved `pnpm --dir <checkout> station:link` command when
linking is declined.

The public candidate is experimental pre-alpha `v0.0.0-pre-alpha.5.1`. The old
`v0.7.1-rc.*` releases were internal previews, not predecessors in the public
version line. `v0.7.1-rc.8` is retained as the installed-version fixture that
proves the intentional version-number reset:

1. Enable GitHub immutable releases, confirm the release commit is on `main`
   with `package.json` and runtime reporting at `0.0.0-pre-alpha.5.1`, then create
   and push `v0.0.0-pre-alpha.5.1`.
2. Confirm every release job passed and the successful run contains exactly one
   `accepted-release-candidate-0.0.0-pre-alpha.5.1-attempt-*` artifact.
3. Install the draft on clean native machines for `darwin-arm64`, `darwin-x64`,
   `linux-arm64`, and `linux-x64`, then complete the manual UX gate below.
4. Install `v0.7.1-rc.8`, upgrade to the accepted candidate, and confirm the
   lower public version number does not block replacement. Confirm the complete
   version and all three launchers after every transition.
5. Dispatch `promote-release.yml` with the successful release run ID, tag
   `v0.0.0-pre-alpha.5.1`, and the manual-acceptance confirmation. It rechecks the
   successful run SHA, immutable candidate manifest, tag commit, release ID,
   asset IDs, the stamped installer, and all hashes immediately before
   publishing that exact draft. Its four public-install jobs must then pass.
6. Mark the historical assetless `v0.1.0` release as a prerelease before the
   announcement so the repository does not present a stable channel. Leave the
   Homebrew tap untouched; Homebrew is not currently supported.

Published tags and assets are immutable. Once two binary releases exist,
recovery may explicitly reinstall the prior version, but the release line moves
forward with a superseding patch; it never deletes, retags, or overwrites a
published release.

If a transient workflow failure leaves an unpublished draft, delete only that
draft and rerun the unchanged tag workflow. If the source needs a fix, leave
the pushed tag alone and use the next prerelease tag. Never delete or mutate a
published release.

Installer acceptance uses both `<install-dir>/.station-install.lock` and
`<data-home>/station/.station-install.lock`. Their sole corresponding
`<install-dir>/.station-install.lock/owner-*` and
`<data-home>/station/.station-install.lock/owner-*` files record the PID,
requested tag and the token embedded in each filename. The command
lock is acquired first and the license lock second, with the duplicate path
skipped, and they are released in reverse order. Cleanup removes only its
token-specific owner file and revalidates the directory inode so it cannot
remove a replacement owner's lock. Either refusal must name the lock and
readable owner PID, state that the existing
Station installation was unchanged, and tell the user to wait and retry; a
license-lock refusal also releases the command lock without making a release
request. The installer never auto-removes an uncertain lock. Only after
confirming that no installer with the recorded PID is alive may an operator
remove the affected lock directory manually and retry.

The staged binary's `--version` probe must finish within 10 seconds. Its
watchdog returns 124 for timeout and 125 for timer failure, bounds output at the
filesystem level, TERM/KILLs and reaps the probe, removes common GitHub and
Actions token variables from the child environment, and shows at most 4096
sanitized bytes of compatibility stderr. Every potentially blocking public
`curl` or draft-only `gh` operation is a tracked file-backed child; HUP, INT,
and TERM forward to that
child, use the same TERM/KILL/reap cleanup, and exit 129, 130, and 143.

The verified `stn` rename is the sole runtime commit point. Immediately before
it, both aliases must still be exact symlinks to `stn` and binary/license
destinations must retain accepted types. A failure with the staged `stn` still
present restores the old license and removes only aliases this attempt created.
If the staged `stn` disappeared, activation is ambiguous: preserve the new
license and aliases, exit nonzero, and print the absolute `stn --version`
inspection command without claiming the previous installation was unchanged.

SIGKILL cannot clean up and may leave either lock or a stage behind. Atomic
rename makes process-level readers observe a coherent complete old or new
binary. Power loss is different: because the installer does not fsync the file
or containing directories, it makes no post-power-loss durability guarantee;
old/new cross-filesystem `LICENSE` metadata may also remain.

### VirtualBuddy clean-mac preparation

Use a fresh VirtualBuddy guest for the primary macOS first-run lane. The guest
covers only the native target reported by `uname -m`; it does not replace the
other release targets. Install macOS updates, Xcode Command Line Tools,
Homebrew, GitHub CLI, Node.js 24, and Codex or another supported agent CLI, then
verify the development-ready baseline:

```sh
sw_vers
uname -m
xcode-select -p
git --version
brew --version
gh --version
node --version
codex --version
```

Take a `dev-ready-before-station` snapshot before authenticating. Do not
preinstall Station, Worktrunk, tmux, or Hunk; this lane must prove
that guided setup identifies and installs the missing Station dependencies.
Authenticate GitHub and confirm private-repository access:

```sh
gh auth login --hostname github.com
gh auth status --hostname github.com
gh repo view jeremy0dell/station
```

When validating the agent-led install prompt on macOS, start the agent in its
normal sandbox after these host-Terminal checks succeed. A sandbox-only auth
failure must remain inconclusive until the agent retries with scoped
host/Keychain access; all later authenticated `gh repo` and `gh api` operations
must use that same access context without reading, printing, requesting, or
exporting a token. If scoped host access is unavailable, run the exact tagged
temporary-file installer in the host Terminal and let the agent resume through
the absolute installed `stn` path.

Start each agent CLI you plan to select once and complete its normal sign-in. Then create
a disposable Git project for the acceptance run:

```sh
mkdir -p "$HOME/Developer/station-smoke"
cd "$HOME/Developer/station-smoke"
git init -b main
printf '# Station installation smoke test\n' > README.md
git add README.md
git -c user.name='Station Smoke' \
  -c user.email='station-smoke@example.invalid' \
  commit -m 'Initial commit'
```

Before installing, `command -v stn` must print nothing and
`~/.local/bin/stn` must not exist. Do not use the published-install recipe for
an unpublished candidate; wait for a successful `release` workflow run and use
its numeric run ID in the accepted-candidate recipe below.

Install the accepted candidate from a successful release workflow run on each
clean test machine. Set `release_run_id` to that run's numeric ID; the recipe
downloads its candidate manifest and uses the exact draft ID and commit that
promotion will verify:

```sh
(
  set -eu
  umask 077
  export GH_HOST=github.com
  tag=v0.0.0-pre-alpha.5.1
  version=${tag#v}
  release_run_id=123456789
  case "$release_run_id" in
    ''|*[!0-9]*) echo "release_run_id must be numeric" >&2; exit 1 ;;
  esac
  test "$(
    gh run view "$release_run_id" --repo jeremy0dell/station \
      --json conclusion --jq '.conclusion'
  )" = success
  test "$(
    gh run view "$release_run_id" --repo jeremy0dell/station \
      --json workflowName --jq '.workflowName'
  )" = release
  run_attempt="$(
    gh run view "$release_run_id" --repo jeremy0dell/station \
      --json attempt --jq '.attempt'
  )"
  case "$run_attempt" in
    ''|*[!0-9]*) echo "release run attempt must be numeric" >&2; exit 1 ;;
  esac
  candidate_dir="$(mktemp -d)"
  installer="$(mktemp)"
  trap 'rm -rf "$candidate_dir"; rm -f "$installer"' EXIT
  gh run download "$release_run_id" \
    --repo jeremy0dell/station \
    --name "accepted-release-candidate-$version-attempt-$run_attempt" \
    --dir "$candidate_dir"
  manifest="$candidate_dir/manifest.json"
  asset_ids="$candidate_dir/asset-ids.txt"
  test -f "$manifest"
  test -f "$asset_ids"
  manifest_field() {
    node -e '
      const { readFileSync } = require("node:fs");
      const value = JSON.parse(readFileSync(process.argv[1], "utf8"))[process.argv[2]];
      if (typeof value !== "string" && typeof value !== "number") process.exit(1);
      process.stdout.write(String(value));
    ' "$manifest" "$1"
  }
  manifest_tag="$(manifest_field tag)"
  manifest_repository="$(manifest_field repository)"
  manifest_run_id="$(manifest_field workflowRunId)"
  manifest_run_attempt="$(manifest_field workflowRunAttempt)"
  commit="$(manifest_field commit)"
  release_id="$(manifest_field releaseId)"
  test "$manifest_tag" = "$tag"
  test "$manifest_repository" = jeremy0dell/station
  test "$manifest_run_id" = "$release_run_id"
  test "$manifest_run_attempt" = "$run_attempt"
  printf '%s\n' "$commit" | grep -Eq '^[0-9a-f]{40}$'
  case "$release_id" in
    ''|*[!0-9]*) echo "candidate release ID must be numeric" >&2; exit 1 ;;
  esac
  test "$(gh api "repos/jeremy0dell/station/commits/$tag" --jq '.sha')" = "$commit"
  installer_asset_id="$(awk -F= '$1 == "install.sh" { print $2 }' "$asset_ids")"
  case "$installer_asset_id" in
    ''|*[!0-9]*) echo "candidate installer asset ID must be numeric" >&2; exit 1 ;;
  esac
  gh api -H 'Accept: application/octet-stream' \
    "repos/jeremy0dell/station/releases/assets/$installer_asset_id" > "$installer"
  test -s "$installer"
  sh -n "$installer"
  grep -Fx "embedded_version=\"$tag\"" "$installer"
  STATION_INSTALL_RELEASE_ID="$release_id" sh "$installer"
)
```

This draft-only environment variable is for release acceptance; normal installs
use the published-release recipe in [Install](install.md).

For the primary VirtualBuddy user-flow pass, start with `XDG_DATA_HOME` unset
and `~/.local/bin` absent from `PATH`, and retain the complete installer output.
Follow the installer's printed current-shell block exactly; on this clean lane
it must name all three missing launchers and end by running `stn setup`. Allow
guided setup to install Worktrunk, tmux, and Hunk, select one or
more authenticated agents, consent to required Station tracking artifacts, and
optionally install the tmux binding. Confirm the first selection becomes the
default only for a new config, every explicit selection receives its own harness
block, and each unprepared artifact-backed selection receives a required consent
prompt before config or provider mutation. Verify final output says Prepared,
not runtime Ready; for Codex it must also name possible `/hooks` review.
Confirm setup writes a zero-project config without adopting the disposable
repository, then run:

```sh
stn --version
stn setup check --json
stn hooks doctor worktrunk
stn doctor
stn tui
```

On the welcome screen, press `Enter` or `Space`. On the empty dashboard, run
first-project onboarding from **Add your first project** three independent ways:
pointer-only through the visible CTA and folder/action controls, direct commands
beginning with `A`, and arrows plus `Enter`. Each pass must select the disposable
Git repository and must refuse an ordinary non-Git folder. Then press `N` and run
Create Session pointer-only, with `P/N/A/C`, and with arrows plus `Enter`; verify
focus remains visible, agent health remains readable without color, and Save/Back
work in the name editor. Ask the authenticated agent to edit
the disposable README, confirm the transcript and diff appear, then quit and
reopen `stn tui` and confirm the session remains.

If the compiled tmux binding was enabled, use `tmux prefix + Space` for the cold
open, close the popup with the same chord, and use it again for a warm reopen.
Confirm both opens are silent in the calling pane and the warm open reuses the
existing `_station-ui` session. Finally confirm the installer did not read or
edit shell startup files. Copy the one future-shell export it printed into a
shell configuration you choose,
open a new login shell, and verify all three physical launcher resolutions and
`stn --version`. The installer, not the user-facing PATH text alone, must have
verified those launchers after installation. The agent-led continuation uses the
absolute installed `stn` path and reports future-shell PATH as unverified until
this new-shell check passes; its own `command -v` result is not user-shell
evidence.
Repeat isolated first-run acceptance for Claude, Codex, Cursor, and OpenCode,
using separate provider homes and verifying missing, current, drifted, and probe-
failure artifacts. Each current artifact must permit the first managed launch;
each missing or drifted artifact must block setup and new launch. Run a Pi-only
lane to prove no external hook artifact is required. In a multiple-CLI lane,
check/plan must report selection required and dry-run/apply must perform zero
writes. For Codex, verify setup does not mutate trust or `[features] hooks`, the
Prepared output names `/hooks` review, and approving the current definition can
produce a Station event.

For shared-hook ownership acceptance, use two Station launchers and one isolated
provider home. Install each target with launcher A, then run plan, doctor, and
install from launcher B. Plan and doctor must identify A as the current owner;
`install --yes` must leave every provider artifact byte-for-byte unchanged and
report the ownership conflict. `install --yes --takeover` must transfer the
marker and generated command to B. Repeat uninstall from A to prove it cannot
remove B's artifact. Finally run setup apply from A and confirm setup reports the
conflict without synthesizing `--takeover`.

Preserve the exact command and output at the first failure; for a runtime
failure with no known trace ID, start with `stn debug trace --latest-failure`.

For each target, install through the authenticated stamped draft asset into a clean home and
manually verify the actual user experience, not a dashboard override:

1. Install into a clean default `HOME` with `XDG_DATA_HOME` unset and an install
   directory absent from `PATH`. Confirm all three missing launchers are named,
   every shell startup file remains absent, the one future-shell export is
   safely quoted for a user-chosen shell configuration, the current-shell block
   runs `hash -r` plus `stn setup`, and the absolute `stn` fallback works.
2. Repeat with existing zsh and bash startup files containing distinct sentinel
   bytes and modes, startup-file symlinks, an older launcher shadowing the
   install, and custom install directories containing spaces and apostrophes.
   Confirm two installs leave every startup file, inode, mode, symlink, and
   target unchanged. Copy the printed export manually into the file you choose,
   open a new login shell, and physically verify all three launchers. Also
   confirm a normalized install path containing `:` fails before any release
   request or installer-created path. With all three launchers already resolving
   physically to the install directory, confirm the short `Next: run stn setup`
   success message.
3. With the installed binary's runtime `PATH` containing neither Node nor Bun,
   run bare `stn` outside tmux. Confirm the real OpenTUI first-run screen draws
   and connects to a healthy Observer.
4. Open a shell pane, run `sleep 30`, press Ctrl-Z, run `fg`, then press Ctrl-C.
5. Run `stn setup` from `HOME` or Desktop. Confirm it creates a zero-project
   config without adopting that directory. In a lane with no agent CLI, select
   all offered agents and confirm no installer starts an agent, begins sign-in,
   or edits a shell startup file. Make one installer fail and confirm later
   selections still run; setup must continue when any selected CLI re-probes as
   runnable and must name every unavailable selection. Then verify both
   `stn hooks doctor worktrunk` and the `worktrunk-hooks` row in full
   `stn doctor` are `ok` without `--hook-bin`. In the open TUI, press `Enter` on
   **Add your first project**, choose a Git repository, and confirm the TUI
   reconnects and shows it after activation on the same Observer socket.
6. Accept the compiled install's optional popup binding and confirm
   `~/.tmux.conf` contains the marked generated command and exact sibling
   `stn-tmux-popup` fallback. Start a fresh tmux server with
   `PATH=/usr/bin:/bin`; `tmux prefix + Space` must open the popup without a
   restart or tmux PATH mutation. Change the marked key, source the file, rerun
   setup, and confirm the custom key is preserved. Also confirm `stn popup`
   remains the direct diagnostic path.
7. Deliver a provider event through `stn-ingress` and confirm it appears in
   Station.
8. Complete the local `0.7.0-host-a` → `0.7.0-host-b` procedure above with a
   live hosted PTY and confirm `HOST_UPGRADE_BLOCKED` preserves its terminal and
   scrollback before the idle host is replaced.
9. In terminal A, continuously run the installed `stn --version`. In terminal
   B, repeatedly reinstall the draft. Terminal A may print only
   `0.0.0-pre-alpha.5.1`:
   never command-not-found or malformed output. After each transition, confirm
   `stn-ingress` and `stn-tmux-popup` still link to `stn`, so the runtime never
   has mixed entrypoints. Repeat the same checks while alternating the draft
   with published internal preview `v0.7.1-rc.8` in both directions.
10. In an isolated home, test abandoned locks separately at
    `<install-dir>/.station-install.lock` and
    `<data-home>/station/.station-install.lock` with representative owner
    metadata. Follow each printed inspection, dead-PID confirmation, manual
    removal, and retry instruction exactly; never remove a lock while its owner
    may be alive.
11. Interrupt a real authenticated upgrade with Ctrl-C. Confirm the prior TUI
   still opens, the installer exits with status 130 and leaves no owned lock or
   stage, then retry successfully.
12. Run `promote-release.yml` only after steps 1-11 pass. Confirm it selects the
    successful release run's `accepted-release-candidate-*` artifact, verifies
    the exact draft asset IDs and hashes, and publishes that draft without
    replacing any asset.

Record the oldest supported macOS version or built-against glibc version in the
release notes. The current documented floors are macOS 13 and glibc 2.39.
Signing and notarization are not part of the initial public pre-alpha; integrity
is the exact-tag GitHub asset plus `SHA256SUMS` verification and immutable
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
STATION_REAL_TMUX=1 pnpm test:tmux-popup:real
pnpm station:devbox:tmux:smoke
pnpm test:e2e:claude:real
pnpm test:e2e:codex:real
pnpm test:e2e:cursor:real
pnpm test:e2e:pi:real
pnpm test:e2e:opencode:real
pnpm test:e2e:real:local
pnpm test:e2e:real:local tests/e2e/real/real-native-tui-mouse.test.ts
pnpm test:e2e:real:codex-hooks
```

The real tmux popup lane requires the root pnpm dependencies and the `station/`
Bun dependencies, Bun 1.3.14, Python 3, tmux, and these prerequisite builds:

```bash
pnpm build
pnpm build:binary -- --version "$(node -p 'require("./package.json").version')"
```

The compiled acceptance artifact must use the checkout's package display
version so its managed-binding signature matches the source-side fast-path
builder. `pnpm station:devbox:tmux:smoke` requires only the source build
(`pnpm build`); the compiled popup lane additionally requires
`pnpm build:binary`.

Set `STATION_TMUX_BIN` when the tmux executable is not available as `tmux`. The lane
creates a disposable Git project and isolates `HOME`, the XDG directories,
config, Observer and Host sockets, state, layout, and the Codex, Claude, Cursor,
and OpenCode homes. It addresses tmux only through a private
`tmux -L <unique-label> -f /dev/null` server. It aggregates cleanup failures,
verifies that its recorded processes and temporary root are gone, and remains
excluded from ordinary PR and `main` CI.

The lane also exercises the compiled generated binding. Its deterministic
dashboard source connects through the normal Observer protocol socket and uses
a strictly parsed snapshot; it is never injected into the renderer store. Warm
reopen must retain the hidden session, renderer, and Observer PIDs even with an
invalid config. Fast-path and fallback failures must produce no pane output, leave
`#{pane_in_mode}` at `0`, and return control without an Escape dismissal. Use
direct `stn popup` when detailed failure output is needed.

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

### Primary-workflow interaction acceptance

For dashboard interaction changes, manually verify native Station and the tmux
popup with three independent passes:

1. Pointer: complete first-project onboarding and create a named session using
   only visible controls (typing text is allowed).
2. Direct commands: use `A`, the displayed Add Project commands, then `N` and
   `P/N/A/C` for Create Session.
3. Focus: use arrows plus `Enter` for folder lists, review actions, and name
   editor actions at both wide and minimum supported widths.

Also open Remove Session and Fork Session from a disposable row. Verify Delete/Keep with pointer,
Y/N, and Left/Right plus Enter; then verify Fork Name/Copy/Fork with pointer and keyboard focus,
including Copy-focused Enter toggling without submitting.

Git-invalid Add Project submit must stay disabled, native Create Session must
open a Station-managed pane, and the popup must continue through its configured
terminal adapter.

## TypeScript And Data Rules

- Use canonical symbol names. The Biome `no-one-to-one-aliases` plugin rejects
  direct named type aliases and renamed named imports or exports. Namespace
  imports and constructed types remain valid; a compatibility boundary must use
  a local `biome-ignore lint/plugin` suppression with a concrete reason.
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

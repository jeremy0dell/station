# System Dependencies

station ships Worktrunk, tmux, Claude Code, Codex, Cursor, Pi, and OpenCode as external provider integrations. They are not npm packages bundled into the workspace. The primary first-run path is:

```bash
stn setup
```

This configures the core local workflow: the required tools, an agent CLI, and your first project. Optional integrations can be added later.

The local checkout also expects Node.js 24.2+ (and below 25) and pnpm 11 for development. Real-provider test lanes remain opt-in.
`stn setup system --check` reports those versions, but it does not change the active Node or pnpm
installation automatically.

## Setup Commands

```bash
stn setup
stn setup check
stn setup check --json
stn setup plan
stn setup plan --json
stn setup apply --yes
stn setup apply --dry-run
stn setup system --check
stn setup system --yes
```

Exit codes:

- `0`: required core setup is ready, or a read-only plan completed.
- `1`: required core setup is missing or an apply action failed.
- `2`: invalid setup command arguments.

`stn setup check` and `stn setup plan` are read-only. `stn setup apply --dry-run` performs no writes or installs. Direct `stn setup system` also requires an explicit mode: use `--check` for read-only reporting or `--yes` to apply Homebrew installs for missing Worktrunk, tmux, Bun, diffnav, and git-delta.

## Dependency Tiers

Required for the default useful workflow:

- Worktrunk / `wt`
- tmux
- Bun — bare `stn` renders the terminal UI by shelling out to `bun run` against the station workspace, so the dashboard cannot launch without it
- diffnav and git-delta (`delta`) — diffnav powers the "See diff (split right)" automation and renders through delta, so the two are required together
- git (the binary) and a git repository for the first project
- one supported agent CLI: Claude Code, Codex, Cursor Agent, OpenCode, or Pi

On macOS, the Command Line Tools provide git and the compilers Homebrew needs.
`stn setup` detects a missing-git binary distinctly from "not inside a repo" and,
on macOS, reports missing Command Line Tools with the `xcode-select --install`
remediation. `scripts/setup/bootstrap.sh` preflights both before touching Homebrew.

Recommended after setup:

- tmux popup binding (`Ctrl-b Space`) for opening and closing the dashboard overlay
- Worktrunk shell integration
- `stn doctor`

Optional later:

- GitHub integration
- notifications
- extra harness CLIs
- provider hook installation, when not accepted during guided setup
- advanced tmux and popup tuning beyond the starter binding

## Worktrunk And Tmux

The Worktrunk provider shells out to `wt`. Install Worktrunk before using a config with:

```toml
[defaults]
worktree_provider = "worktrunk"
```

The tmux provider shells out to `tmux` for the workbench and popup local-use path. Guided
`stn setup` can append a marked `Ctrl-b Space` binding to `~/.tmux.conf` when you accept the
recommended popup binding step. Inside tmux, setup can also load that binding into the current
tmux server so a restart or manual `tmux source-file ~/.tmux.conf` is not required.

The generated binding uses a resolved `stn-tmux-popup` launcher. In a development checkout this
may be the checkout's `integrations/terminal/tmux/bin/stn-popup` path rather than a bare command.
Run `pnpm station:link` only when you want bare `stn`, `stn-ingress`, and `stn-tmux-popup` commands
available globally.

Use `terminal.tmux.command` when tmux is installed but not on the observer or popup launcher PATH:

```toml
[terminal.tmux]
command = "/opt/homebrew/bin/tmux"
```

On macOS, setup installs missing core tools directly when Homebrew is available:

```bash
stn setup apply --yes
```

The compatibility script remains available for development checkouts:

```bash
pnpm setup:system:check
pnpm setup:system
```

`pnpm setup:system:check` delegates to `stn setup system --check`. Bare `pnpm setup:system` is the development-checkout compatibility apply path and delegates to `stn setup system --yes`. Dependency logic lives in the TypeScript CLI.

If the system check reports Node.js 22.x or pnpm 8.x, switch them deliberately with your normal
toolchain manager instead of letting setup mutate the machine:

```bash
fnm install 24 && fnm use 24
# or:
nvm install 24 && nvm use 24

corepack enable
corepack prepare pnpm@11.0.0 --activate
```

The upstream Worktrunk install docs currently recommend:

```bash
brew install worktrunk && wt config shell install
```

See https://worktrunk.dev/worktrunk/#install for other package managers.

## Resolution Order

The Worktrunk provider resolves the command in this order:

```text
worktree.worktrunk.command
STATION_WORKTRUNK_BIN
wt
```

Use the config field when `wt` is installed but not on the observer's `PATH`:

```toml
[worktree.worktrunk]
command = "/opt/homebrew/bin/wt"
```

## Diagnostics

`stn doctor` reports Worktrunk availability through provider health. When `wt` is missing, provider health includes:

```text
status = unavailable
lastError.code = WORKTRUNK_UNAVAILABLE
diagnostics.attemptedCommand
diagnostics.resolvedPath, when found on PATH
diagnostics.version, when available
diagnostics.installHint
```

The same provider-health evidence is included in `stn debug bundle`, so a failed `session.create` can be tied back to the missing external binary. Failed Worktrunk commands can also surface redacted command diagnostics through `stn command get <commandId>` and `stn debug trace <traceOrCommandId>`.

`stn doctor` also runs a CLI-side `renderer-runtime` check: when Bun is not on PATH it reports a `warn` (degraded) finding with code `BUN_RUNTIME_MISSING`, because bare `stn` cannot render the TUI without `bun run` even when the observer is healthy. This catches an already-set-up machine that later loses Bun.

## Hooks

Guided `stn setup` can enable and install Worktrunk lifecycle hooks plus the selected Claude, Codex,
Cursor, or OpenCode agent hooks. Worktrunk lifecycle hooks are optional when automation is
configured to skip them. `worktree.worktrunk.use_lifecycle_hooks = false` makes automated Worktrunk
mutations use `--no-hooks`; `true` makes them use `--yes`; unset leaves Worktrunk's default prompt
behavior in place.
`stn setup check --json` and `stn doctor` report the effective mode and validate that the installed
`wt` supports any required automation flag. The hook commands are generated with the resolved STATION
config path, observer socket, state directory, spool directory, and `stn-ingress` launcher. If you
decline hook setup but later want hook delivery, install later with:

```bash
stn hooks install worktrunk --yes
stn hooks install claude --yes
stn hooks install codex --yes
stn hooks install cursor --yes
stn hooks install opencode --yes
```

Use the matching doctor commands to verify hook files and config intent:

```bash
stn hooks doctor worktrunk
stn hooks doctor claude
stn hooks doctor codex
stn hooks doctor cursor
stn hooks doctor opencode
stn event-hooks doctor
```

## Compatibility Script

```bash
pnpm setup:system:check
pnpm setup:system
pnpm setup:system --yes
pnpm setup:system --no-brew
```

Use `stn setup` for user setup. Use `pnpm setup:system:check` when validating a development checkout's system dependencies, and `pnpm setup:system` when you want the compatibility wrapper to apply missing Homebrew installs.

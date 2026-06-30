# Install

This setup path is for a local development checkout. station remains a private workspace package for this milestone; there is no public npm package or publish flow yet.

## Quick start (macOS)

From a fresh clone, one script installs the system dependencies via Homebrew, builds the workspace, and links the `stn` command:

```bash
./scripts/setup/bootstrap.sh
stn setup
stn
```

`bootstrap.sh` runs `brew bundle` (Node 24, Bun, Worktrunk, tmux, diffnav, git-delta), then `pnpm install`, `pnpm build`, and `pnpm link --global`. If you manage your own runtimes, the manual steps below are equivalent. (A single prebuilt binary is the post-alpha goal — it needs the runtime unification tracked in `docs/`.)

## Requirements

- Node.js 24.x
- pnpm 11
- Worktrunk `wt` for real Worktrunk workflows
- tmux for the reference terminal provider and popup local-use path
- Claude Code, Codex, Cursor, Pi, or OpenCode only when running those real harness providers

## Fresh Checkout

From the repository root:

```bash
pnpm install
pnpm build
pnpm stn setup
pnpm smoke:release
```

After STATION is installed:

```text
STATION is installed.

Next:
  stn setup

This configures the core local workflow: the required tools, an agent CLI, and your first project.
Optional integrations can be added later.
```

`pnpm smoke:release` builds by default, creates an isolated temporary config, runs `bin/stn doctor`, `reconcile`, `snapshot --json`, `debug bundle`, and the scripted-agent lane, then stops the observer and removes the temp state.

Guided setup writes a first-project config, can enable Worktrunk and selected-agent hooks, and can install the tmux popup binding. When bare `stn` launchers are not on `PATH`, setup uses launcher paths from the current checkout for generated tmux and hook commands and offers `pnpm --dir <checkout> link --global` as the convenience path for bare terminal commands.

Useful smoke options:

```bash
pnpm smoke:release -- --skip-build
pnpm smoke:release -- --skip-scripted
pnpm smoke:release -- --keep-temp
```

## Local Command

During development, either use the repo-local command:

```bash
pnpm stn doctor
pnpm stn reconcile --reason manual
pnpm stn snapshot --json
pnpm stn
```

or link the built CLI after setup:

```bash
pnpm station:link
stn doctor
```

The tmux popup binding and generated provider hooks no longer require a global link when setup can resolve the current checkout launchers. Linking is still useful when you want to type bare `stn` from arbitrary directories.

## Local Real Config

Prefer `stn setup` for a first real config. Use [examples/local-real-config.toml](../examples/local-real-config.toml) only when you want to manually edit a fuller real-tool starting point. Copy it to `~/.config/station/config.toml`, update the project root, and keep the managed Worktrunk root policy unless you intentionally want to show main or external worktrees.

```bash
mkdir -p ~/.config/station
cp examples/local-real-config.toml ~/.config/station/config.toml
```

Run `stn doctor` after editing the config. Doctor should report config diagnostics, Worktrunk availability, effective Worktrunk automation mode, hook setup status when hooks are expected, SQLite health, provider health, local-state retention, and debug-bundle availability.

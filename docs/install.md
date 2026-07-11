# Install

Station is distributed internally as authenticated private GitHub release assets. There is no public package or public download channel.

## Private Binary

Authenticate `gh` for `jeremy0dell/station`, then run the installer directly from the private repository:

```bash
gh auth login --hostname github.com
(
  set -e
  installer="$(mktemp)"
  trap 'rm -f "$installer"' EXIT
  GH_HOST=github.com gh api repos/jeremy0dell/station/contents/scripts/install.sh \
    -H "Accept: application/vnd.github.raw+json" > "$installer"
  test -s "$installer"
  sh "$installer" --version v0.1.1-rc.1
)
```

Only after that block succeeds:

```bash
stn setup
stn
```

The explicit RC is the A5 validation baseline. Once `v0.1.1` is published, omitting `--version` selects the latest stable release:

```bash
(
  set -e
  installer="$(mktemp)"
  trap 'rm -f "$installer"' EXIT
  GH_HOST=github.com gh api repos/jeremy0dell/station/contents/scripts/install.sh \
    -H "Accept: application/vnd.github.raw+json" > "$installer"
  test -s "$installer"
  sh "$installer"
)
```

Use `--version` whenever an exact install or rollback is required.

Pass `--install-dir PATH` to override the default `~/.local/bin`; run `scripts/install.sh --help` from a checkout for the complete command surface.

The installer:

- accepts only `darwin-arm64`, `darwin-x64`, `linux-arm64`, and `linux-x64`;
- downloads the exact `stn-v{version}-{os}-{arch}.tar.gz` asset and `SHA256SUMS` through authenticated `gh api` calls (`{version}` excludes the tag's leading `v`);
- verifies the matching SHA-256 before extraction and rejects an unexpected archive manifest;
- stages the verified binary on the destination filesystem and requires its `--version` to match, so an incompatible OS/libc/CPU artifact or version mismatch fails before replacing an existing command;
- replaces the compiled `stn`, `stn-ingress`, and `stn-tmux-popup` paths by atomic rename, preserving an existing install on any pre-install failure;
- installs the redistributed `LICENSE` under `${XDG_DATA_HOME:-$HOME/.local/share}/station/`;
- removes `com.apple.quarantine` from the verified binary defensively on macOS; and
- prints `stn setup` plus a PATH hint only when the selected bin directory is not already on `PATH`.

The compiled binary launches the native TUI and Observer without Node.js, pnpm, Bun, `node_modules`, or a source checkout. External programs are installed separately and gate only the features that use them: Git and Worktrunk for managed worktrees, tmux for popup/provider behavior, diffnav and git-delta for diff automation, and a supported agent CLI for agent sessions.

Rollback is the same authenticated explicit-version install. Published tags and assets are immutable; do not delete, move, or overwrite them. If a stable release is bad, reinstall the prior tag for recovery and publish a higher patch release containing the revert or fix.

## Development Checkout

The source checkout remains the development path. On macOS, one script installs the development dependencies via Homebrew, builds the workspace, and links the source `stn` command:

```bash
./scripts/setup/bootstrap.sh
stn setup
stn
```

`bootstrap.sh` runs `brew bundle` (Node 24, Bun, Worktrunk, tmux, diffnav, git-delta), then `pnpm install`, `pnpm build`, the Bun UI install (`cd station && bun install && bun run link:station && bun run repair:node-pty`), and `pnpm station:link`. That final command uses pnpm 11's supported global-add path to expose `stn`, `stn-ingress`, and `stn-tmux-popup` while keeping them bound to the checkout. The Bun step matters: `station/` is a separate Bun workspace, not a pnpm-workspace member, so `pnpm install` never installs it — skip it and bare `stn` refuses to launch with an install hint (the underlying failure is "@opentui not found"). If you manage your own runtimes, the manual steps below are equivalent. A single prebuilt binary is the post-alpha goal — the design and phased roadmap live in [Single-binary Station](single-binary.md); until then, the draft Homebrew tap path is documented in [Homebrew packaging](homebrew.md).

## Development Requirements

For a complete source-development workflow, `stn setup check` exits 1 until these tools are present. A compiled binary can still launch when a feature-gated tool is missing:

- Git, run from inside the git repository you want to manage (macOS: the Command Line Tools)
- Worktrunk `wt` for core worktree setup
- tmux for the reference terminal provider and popup path
- Bun — source-checkout `stn` renders the TUI through `bun run`; compiled `stn` embeds the renderer
- diffnav and git-delta for the "See diff (split right)" automation
- One agent CLI: Claude Code, Codex, Cursor, OpenCode, or Pi

`bootstrap.sh`'s `brew bundle` installs the brew-available subset (Worktrunk, Bun, tmux, diffnav, git-delta, plus keg-only Node 24); git / Command Line Tools and the agent CLI are obtained separately.

Node.js 24.2+ (and below 25) and pnpm 11 are dev/build prerequisites for this checkout, validated by `stn setup system --check` (not `stn setup check`); setup does not install or change them (use corepack for pnpm, and a Node version manager or `brew node@24` for Node). The repo selects the current Node 24 release with `.node-version` and `.nvmrc` (`24`), so fnm/nvm use the supported release in the checkout instead of falling back to your global default (asdf reads these only with `legacy_version_file = yes` in `~/.asdfrc`).

## Fresh Development Checkout

From the repository root:

```bash
pnpm install
pnpm build
cd station && bun install && cd ..   # Bun UI lane (separate workspace; pnpm does not install it)
pnpm stn setup
pnpm smoke:release
pnpm smoke:install
```

`cd station && bun install` is required for the terminal UI: bare `stn` renders it by shelling into `bun run` against `station/`, so without the install `stn` refuses to launch and prints the install hint (historically a raw "@opentui not found" error) even though the Bun binary is healthy. `stn doctor` reports this lane explicitly (a `renderer-runtime` warning with code `STATION_UI_NOT_INSTALLED`).

After STATION is installed:

```text
STATION is installed.

Next:
  stn setup

This configures the core local workflow: the required tools, an agent CLI, and your first project.
Optional integrations can be added later.
```

`pnpm smoke:release` builds by default, creates an isolated temporary config, runs `bin/stn doctor`, `reconcile`, `snapshot --json`, `debug bundle`, and the scripted-agent lane, then stops the observer and removes the temp state.

`pnpm smoke:install` exercises latest and explicit-version selection, all four platform mappings, checksums, archive safety, atomic replacement, rollback, symlinks, license placement, authentication failure, and PATH hints against local fake release assets. It does not contact GitHub or modify the real home directory.

Guided setup writes a first-project config, can enable Worktrunk and selected-agent hooks, and can install the tmux popup binding. When bare `stn` launchers are not on `PATH`, setup uses launcher paths from the current checkout for generated tmux and hook commands and offers `pnpm --dir <checkout> station:link` as the convenience path for bare terminal commands.

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

or link all three checkout launchers after setup:

```bash
pnpm station:link
stn doctor
```

The tmux popup binding and generated provider hooks no longer require a global link when setup can resolve the current checkout launchers. Linking is still useful when you want bare `stn`, `stn-ingress`, and `stn-tmux-popup` from arbitrary directories.

## Local Real Config

Prefer `stn setup` for a first real config. Use [examples/local-real-config.toml](../examples/local-real-config.toml) only when you want to manually edit a fuller real-tool starting point. Copy it to `~/.config/station/config.toml`, update the project root, and keep the managed Worktrunk root policy unless you intentionally want to show main or external worktrees.

```bash
mkdir -p ~/.config/station
cp examples/local-real-config.toml ~/.config/station/config.toml
```

Run `stn doctor` after editing the config. Doctor should report config diagnostics, Worktrunk availability and stale registrations, effective Worktrunk automation mode, hook setup status when hooks are expected, SQLite health, provider health, local-state retention, and debug-bundle availability.

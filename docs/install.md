# Install

Station is distributed internally as authenticated private GitHub release assets. There is no public package or public download channel.

## Private Binary

On a development-ready Mac, have Xcode Command Line Tools, Homebrew, GitHub CLI access to `jeremy0dell/station`, and Codex or another supported agent CLI ready. Node.js can be present, but the compiled Station binary does not use it.

Start in the Git repository you want Station to manage, authenticate `gh`, then fetch and run the installer for the first binary baseline:

```bash
cd /path/to/your/git-project
gh auth login --hostname github.com
(
  set -eu
  umask 077
  export GH_HOST=github.com
  tag=v0.7.0
  installer="$(mktemp)"
  trap 'rm -f "$installer"' EXIT
  gh api --method GET \
    -H 'Accept: application/vnd.github.raw+json' \
    -f ref="$tag" \
    repos/jeremy0dell/station/contents/scripts/install.sh > "$installer"
  test -s "$installer"
  sh -n "$installer"
  sh "$installer" --version "$tag" --persist-path
)
```

Keep `tag=v0.7.0` for an exact install. After `v0.7.0` is published, replace that assignment with the following to resolve the latest stable tag while still fetching installer code and artifacts from that same tag:

```bash
tag="$(GH_HOST=github.com gh api repos/jeremy0dell/station/releases/latest --jq '.tag_name')"
```

The recipe never falls back to `main`. `gh` handles private-repository authentication for both the bootstrap and the installer's release discovery and asset downloads. Because `v0.7.0` is the first binary release, immutable rollback to a prior binary becomes available only after the next binary release.

### Complete first-run setup

The installer block installs the Station binaries and, with the explicit `--persist-path` consent above, adds the install directory to the supported login-shell profile. It does not configure the current project. The recipe begins by changing into the Git repository that `stn setup` will use as the first Station project. Because profile changes apply to future login shells, the remaining handoff for the current shell is:

```bash
PATH="$HOME/.local/bin${PATH:+":$PATH"}"
export PATH
hash -r

stn --version
stn setup
stn doctor
stn tui
```

If the installer reported a PATH mismatch, its printed current-shell block is the authoritative equivalent and already ends with `stn setup`. When running the installer outside these recipes, change into the project repository before using that block. If you used `--install-dir`, use its printed path instead of `~/.local/bin`.

Guided setup checks or offers to install Worktrunk, tmux, diffnav, and git-delta through Homebrew; requires one supported agent CLI; writes `~/.config/station/config.toml` for the current repository; starts or restarts the Observer; and optionally installs Worktrunk and agent hooks, Worktrunk shell integration, and the `Ctrl-b Space` tmux popup binding. Setup checks that the selected agent command runs, but it does not authenticate that provider, so complete the agent CLI's normal sign-in before starting a real session. The compiled Station binary itself does not require Node.js, pnpm, or Bun.

The PATH assignment above affects only the current shell. `--persist-path` adds an idempotent entry to the login-shell profile selected from `SHELL` (`.zprofile` for zsh, the first existing bash login profile, or `.profile` for POSIX shells) while preserving existing content such as Homebrew setup. Omit the flag to leave profiles unchanged; unless the exact entry is already present, the installer prints the idempotent command you can run instead, even when its own shell temporarily resolves the launchers. `stn tui` forces the full workspace both inside and outside tmux. After onboarding, bare `stn` opens that workspace outside tmux and the read-only popup dashboard inside tmux.

On the cold-boot welcome screen, press `Enter` or `Space` to open project view. Press `N`, review the project, generated session name, and agent in the **Create Session** dialog, then press `Enter` on **Create session** to start the agent session.

Pass `--install-dir PATH` to override the default `~/.local/bin`, and combine it with `--persist-path` to persist that exact custom directory; run `scripts/install.sh --help` from a checkout for the complete command surface.

The installer:

- accepts only `darwin-arm64`, `darwin-x64`, `linux-arm64`, and `linux-x64`;
- downloads the exact `stn-v{version}-{os}-{arch}.tar.gz` asset and `SHA256SUMS` through authenticated `gh api` calls (`{version}` excludes the tag's leading `v`);
- verifies the matching SHA-256 before extraction and rejects an unexpected archive manifest;
- stages the verified binary on the destination filesystem and requires its `--version` to match within 10 seconds, so a hung or incompatible OS/libc/CPU artifact and an embedded-version mismatch fail without replacing an existing command; compatibility failures include at most 4096 sanitized bytes of probe stderr;
- keeps `stn-ingress` and `stn-tmux-popup` as stable symlinks to `stn`, installs the redistributed `LICENSE` under `${XDG_DATA_HOME:-$HOME/.local/share}/station/`, then atomically renames the verified `stn` last as the sole runtime commit point;
- removes `com.apple.quarantine` from the verified binary defensively on macOS; and
- resolves all three bare launchers after installation. If any is missing or shadowed, it names every mismatch, prints a safely quoted current-shell block that prepends the install directory, runs `hash -r`, and starts `stn setup`, and also prints the absolute installed `stn` path. Profile persistence occurs only with `--persist-path`; otherwise it prints an exact opt-in command and leaves the profile unchanged.

### Concurrent and interrupted installs

Every install serializes both mutated resources with these locks:

- `<install-dir>/.station-install.lock` (by default
  `~/.local/bin/.station-install.lock`) for the commands; and
- `<data-home>/station/.station-install.lock` (by default
  `~/.local/share/station/.station-install.lock`) for `LICENSE`.

Each lock's sole `owner-*` file records the installer PID, requested tag or
`latest`, and the unique ownership token embedded in its filename. Cleanup
removes only that token-specific file and revalidates the lock inode, so an
earlier installer cannot remove a replacement lock. The installer acquires
the command lock first and the license lock second, skips the second acquisition
if both paths coincide, and releases them in reverse order. A refusal happens
before release lookup or download, names
the lock and readable owner PID, states that the existing Station installation
was unchanged, and tells the user to wait and retry. A license-lock refusal
releases the command lock and performs no release API request.

The installer never guesses that either lock is stale. For an abandoned lock,
read its sole `<install-dir>/.station-install.lock/owner-*` or
`<data-home>/station/.station-install.lock/owner-*` file and confirm that no
installer process with the recorded PID is alive. Only then remove that lock
directory manually and retry the same install. Do not remove a lock while its
owner may still be running. Legacy locks with a single `owner` file remain
readable for safe refusal and manual recovery.

The staged `stn --version` probe has a 10-second supervised deadline and a
bounded output file. Timeout status 124 means the watchdog terminated, killed
if necessary, and reaped the probe; status 125 means the timer machinery
failed. Common GitHub and Actions token variables are removed from the probe's
environment. A loader or compatibility failure prints no more than 4096 sanitized
bytes of probe stderr. HUP, INT, and TERM forward to the active child, run the
same TERM/KILL/reap and rollback path, and exit with status 129, 130, and 143
respectively, so Ctrl-C does not return to an interrupted install.

Immediately before commit, the installer revalidates both aliases as exact
symlinks to `stn` and the accepted binary and license destination types. Before
the final rename, a caught failure restores the prior license and removes only
an alias that this attempt successfully created and that still matches it. If
a failed final `mv` leaves the staged `stn` present, rollback restores the
previous state and the installer reports it unchanged. If the staged `stn`
disappeared, activation may have committed: the installer preserves the new
license and aliases, exits nonzero, and prints an absolute
`<install-dir>/stn --version` inspection command. It does not claim that the previous installation
was unchanged in that ambiguous case. Post-commit cleanup failures are warnings.

SIGKILL cannot run shell cleanup, so it can leave a stale lock or staging path;
recover a lock only with the inspection-and-manual-removal procedure above.
Atomic rename gives coherent process-level visibility—continuous readers see a
complete old or new runtime—but this installer does not fsync the files or
containing directories. It therefore makes no post-power-loss durability
guarantee, and power loss can also leave old/new cross-filesystem `LICENSE`
metadata. Inspect the absolute installed `stn --version` and both locks before
retrying after a machine loss.

The compiled binary launches the native TUI and Observer without Node.js, pnpm, Bun, `node_modules`, or a source checkout. External programs are installed separately and gate only the features that use them: Git and Worktrunk for managed worktrees, tmux for popup/provider behavior, diffnav and git-delta for diff automation, and a supported agent CLI for agent sessions.

After a second binary version exists, rollback is the same authenticated
explicit-version install. Published tags and assets are immutable; do not
delete, move, or overwrite them. If `v0.7.0` itself is bad, publish a higher
version containing the revert or fix because there is no earlier binary tag.

## Development Checkout

The source checkout remains the development path. On macOS, one script installs the development dependencies via Homebrew, builds the workspace, and links the source `stn` command:

```bash
./scripts/setup/bootstrap.sh
stn setup
stn
```

`bootstrap.sh` runs `brew bundle` (Node 24, Bun, Worktrunk, tmux, diffnav, git-delta), then `pnpm install`, `pnpm build`, the Bun UI install (`cd station && bun install && bun run link:station && bun run repair:node-pty`), and `pnpm station:link`. That final command uses pnpm 11's supported global-add path to expose `stn`, `stn-ingress`, and `stn-tmux-popup` while keeping them bound to the checkout. The Bun step matters: `station/` is a separate Bun workspace, not a pnpm-workspace member, so `pnpm install` never installs it — skip it and bare `stn` refuses to launch with an install hint (the underlying failure is "@opentui not found"). If you manage your own runtimes, the manual steps below are equivalent. The compiled release design and phased roadmap live in [Single-binary Station](single-binary.md); the separate source-package path is documented in [Homebrew packaging](homebrew.md).

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

`pnpm smoke:install` exercises latest, explicit, and draft selection; strict
authenticated API arguments; all four platform mappings; isolated-home login
profile persistence, minimal-PATH fresh shells, PATH shadow behavior;
checksum/archive/probe failures; dual-lock concurrency and stale recovery;
rollback and ambiguous commit points; continuous readers; HUP/INT/TERM/SIGKILL;
and runner self-interruption against local fake release assets. Every child and
the overall runner have deadlines. It does not contact GitHub or modify the real
home directory.

Guided setup writes a first-project config, can enable Worktrunk and selected-agent hooks, and can install the tmux popup binding. Generated tmux and hook commands persist the resolved absolute launcher paths, whether they came from an installed runtime or the current checkout, so later processes do not depend on setup's PATH. When bare `stn` launchers are not on `PATH`, setup offers `pnpm --dir <checkout> station:link` as the convenience path for bare terminal commands.

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

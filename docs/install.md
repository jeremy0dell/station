# Install Station

Station is distributed through authenticated GitHub release assets in the
private `jeremy0dell/station` repository. This procedure assumes your GitHub
account already has read access; it does not require or display a personal
access token.

## Binary Requirements

The compiled binary supports these targets:

- macOS on Apple silicon (`darwin-arm64`)
- macOS on Intel (`darwin-x64`)
- Linux on arm64 (`linux-arm64`)
- Linux on x64 (`linux-x64`)

Install the [GitHub CLI](https://cli.github.com/) before continuing. The binary
install itself does not require a source checkout, Node.js, pnpm, Bun, Xcode, or
Homebrew. `stn setup` handles the separate tools needed for the complete agent
workflow after Station is installed.

## Let Your Agent Install and Validate Station

If you prefer an agent-led install, paste this prompt into a coding agent on the
target machine:

```text
Install Station private preview candidate v0.7.1-rc.4 and validate setup on this machine.

Use the private GitHub repository jeremy0dell/station through GitHub CLI.

Safety and scope:
- First run `gh auth status --hostname github.com`, then verify repository
  access with `gh repo view jeremy0dell/station`. Never ask me to paste,
  extract, or print credentials. If authentication or repository access fails,
  stop and ask me to run `gh auth login --hostname github.com` myself.
- Do not clone the repository or build from source. Use release tag
  `v0.7.1-rc.4`, read `docs/install.md` from that same tag with authenticated
  `gh api`, and follow its temporary-file installer procedure. If that release
  is not published yet, stop instead of falling back to another ref.
- Never fetch installer code from `main` and never pipe network output directly
  into a shell.
- Install to `~/.local/bin` unless I approve another location. Do not edit any
  shell startup file. Apply PATH changes only to the current shell and show me
  the exact export I can add later.
- Do not infer or add the current directory as a Station project.

Validation:
1. Verify `command -v stn`, `command -v stn-ingress`, and
   `command -v stn-tmux-popup`, then run `stn --version`.
2. Run `stn setup plan --json`, summarize every proposed install or write, and
   ask for approval before applying it.
3. Run the guided `stn setup` and let me answer its choices. If you cannot pass
   through an interactive prompt, ask me to run it, then continue afterward.
4. Run `stn setup check --json` and `stn doctor`.
5. Report the installed path and version, whether setup reports
   `summary.requiredOk: true`, doctor health, and any remaining manual steps.
   A valid zero-project config is acceptable. Do not claim success while a
   required check is failing.
```

The agent should stop at authentication or approval boundaries rather than
inventing credentials or setup choices.

## 1. Authenticate GitHub CLI

Sign in with the GitHub account that can read `jeremy0dell/station`:

```bash
gh auth login --hostname github.com
gh auth status --hostname github.com
gh repo view jeremy0dell/station --json nameWithOwner --jq '.nameWithOwner'
```

If GitHub CLI is already authenticated, skip the login command. The repository
check should print `jeremy0dell/station`; a not-found response means the active
account cannot read the private repository. GitHub CLI supplies its stored
authentication to the API calls below, so do not add credentials to the recipe.

## 2. Install the Current Preview Candidate

From any directory, run:

```bash
(
  set -eu
  umask 077
  export GH_HOST=github.com
  tag=v0.7.1-rc.4
  # After the first stable release, use:
  # tag="$(GH_HOST=github.com gh api repos/jeremy0dell/station/releases/latest --jq '.tag_name')"
  installer="$(mktemp)"
  trap 'rm -f "$installer"' EXIT
  gh api --method GET \
    -H 'Accept: application/vnd.github.raw+json' \
    -f ref="$tag" \
    repos/jeremy0dell/station/contents/scripts/install.sh > "$installer"
  test -s "$installer"
  sh -n "$installer"
  sh "$installer" --version "$tag"
)
```

`v0.7.1-rc.4` is the current private-binary candidate. `v0.7.1-rc.3` remains
published as its immutable rollback; the earlier `v0.7.0` and `v0.7.1-rc.1`
candidates remained unpublished. Run this recipe after the candidate is
published. Keep the fixed assignment for an exact prerelease install. After the
first stable release, use the commented assignment to resolve the latest stable
tag while still fetching installer code and artifacts from that same immutable
tag. The recipe never falls back to `main`, never prints GitHub credentials, and
never pipes network output directly into a shell.

The installer selects the matching platform archive, verifies it against
`SHA256SUMS`, and installs these launchers in `~/.local/bin` by default:

```text
stn
stn-ingress
stn-tmux-popup
```

It also installs the redistributed license under
`${XDG_DATA_HOME:-$HOME/.local/share}/station/`.

After this candidate is published, immutable rollback to `v0.7.1-rc.3` uses the
same exact-version procedure below.

## 3. Verify the Install

The installer physically verifies all three launchers. If the install directory
is not visible in the current shell, it prints an exact current-shell recovery
block and one export command for future shells. For the default directory, the
current-shell commands are:

```bash
PATH="$HOME/.local/bin${PATH:+":$PATH"}"
export PATH
hash -r

command -v stn
stn --version
```

`command -v stn` should resolve to `~/.local/bin/stn`, and `stn --version`
should print the installed release version. If another `stn` shadows the binary,
use the exact PATH block or the `Absolute fallback` printed by the installer.

The PATH assignment affects only the current shell. Copy the installer's exact
export into the chosen shell configuration if you want it applied in future
shells. The installer does not read, create, or edit shell startup files.

## Install an Exact Version

To install an exact release or return to published `v0.7.1-rc.3`, use the same
recipe with this assignment instead of the latest-release lookup:

```bash
tag=v0.7.1-rc.3
```

The installer code and artifacts still come from that same tag. The earlier
`v0.7.0` and `v0.7.1-rc.1` candidates remained unpublished.

## Use a Custom Install Directory

Change the final installer invocation to pass an absolute or home-relative
path:

```bash
sh "$installer" --version "$tag" --install-dir "$HOME/bin"
```

Use the PATH and absolute commands printed by that install rather than the
default `~/.local/bin` examples. The normalized install directory cannot
contain `:` because PATH uses `:` to separate entries. This validation happens
before GitHub requests, temporary-directory creation, or destination mutation.

## 4. Complete First-Run Setup

Run setup only after `stn --version` succeeds:

```bash
stn setup
stn doctor
stn tui
```

Setup checks or offers to install Worktrunk, tmux, diffnav, and git-delta;
requires one supported agent CLI; writes a valid zero-project
`~/.config/station/config.toml`; starts or restarts the Observer; and offers to
install provider hooks, Worktrunk shell integration, and the `Ctrl-b Space`
tmux popup binding. Complete the selected agent CLI's own sign-in before
starting a real session.

Setup never adopts its current directory or an ancestor repository. On the
empty dashboard, choose **Add your first project**, select a folder inside an
existing Git repository, and confirm its detected Git root. Then press `N`,
review the **Create Session** dialog, and choose **Create session** to start the
agent session. The complete walkthrough is in [Quick start](quick-start.md).

The installer and setup have separate ownership:

| Concern | Owner |
| --- | --- |
| Download, verify, and install the binary artifacts | Station installer |
| Verify all three launcher paths physically | Station installer |
| Print current-shell, future-shell, and absolute recovery commands | Station installer |
| Choose or edit a shell configuration | User |
| Write Station configuration and install integrations | `stn setup` |
| Choose the first Git project | User in Station |

The installer:

- accepts only `darwin-arm64`, `darwin-x64`, `linux-arm64`, and `linux-x64`;
- downloads the exact `stn-v{version}-{os}-{arch}.tar.gz` asset and `SHA256SUMS` through authenticated `gh api` calls (`{version}` excludes the tag's leading `v`);
- verifies the matching SHA-256 before extraction and rejects an unexpected archive manifest;
- stages the verified binary on the destination filesystem and requires its `--version` to match within 10 seconds, so a hung or incompatible OS/libc/CPU artifact and an embedded-version mismatch fail without replacing an existing command; compatibility failures include at most 4096 sanitized bytes of probe stderr;
- keeps `stn-ingress` and `stn-tmux-popup` as stable symlinks to `stn`, installs the redistributed `LICENSE` under `${XDG_DATA_HOME:-$HOME/.local/share}/station/`, then atomically renames the verified `stn` last as the sole runtime commit point;
- removes `com.apple.quarantine` from the verified binary defensively on macOS; and
- physically resolves all three bare launchers after installation. If any is missing or shadowed, it names every mismatch, prints one safely quoted future-shell export for the user's chosen shell configuration, prints a current-shell block that prepends the install directory, runs `hash -r`, and starts `stn setup`, and prints an absolute installed `stn` fallback. If all three launchers already resolve to the installed runtime, it prints only `Next: run stn setup`.

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

Rollback is the same authenticated explicit-version install. Published tags and
assets are immutable; do not delete, move, or overwrite them. If a published
binary is bad, reinstall the prior published version and ship a higher version
containing the revert or fix.

## Development Checkout

The source checkout remains the development path. On macOS, one script installs the development dependencies via Homebrew, builds the workspace, and links the source `stn` command:

```bash
./scripts/setup/bootstrap.sh
stn setup
stn
```

`bootstrap.sh` runs `brew bundle` (Node 24, Bun, Worktrunk, tmux, diffnav, git-delta), then `pnpm install`, `pnpm build`, the Bun UI install (`cd station && bun install && bun run link:station && bun run repair:node-pty`), and `pnpm station:link`. That final command uses pnpm 11's supported global-add path to expose `stn`, `stn-ingress`, and `stn-tmux-popup` while keeping them bound to the checkout. The Bun step matters: `station/` is a separate Bun workspace, not a pnpm-workspace member, so `pnpm install` never installs it — skip it and bare `stn` refuses to launch with an install hint (the underlying failure is "@opentui not found"). If you manage your own runtimes, the manual steps below are equivalent. See [Development](development.md) for the current source workflow and test gates.

## Development Requirements

For a complete source-development workflow, `stn setup check` exits 1 until these tools are present. A compiled binary can still launch when a feature-gated tool is missing:

- Git (macOS: the Command Line Tools); choose the repository explicitly after setup
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

This configures the core local workflow: the required tools, an agent CLI, and a zero-project config.
Optional integrations can be added later.
```

`pnpm smoke:release` builds by default, creates an isolated temporary config, runs `bin/stn doctor`, `reconcile`, `snapshot --json`, `debug bundle`, and the scripted-agent lane, then stops the observer and removes the temp state.

`pnpm smoke:install` exercises latest, explicit, and draft selection; strict
authenticated API arguments; all four platform mappings; startup-file
non-interaction, safely evaluated PATH guidance for spaces and apostrophes,
normalized-colon preflight, and physical PATH shadow behavior;
checksum/archive/probe failures; dual-lock concurrency and stale recovery;
rollback and ambiguous commit points; continuous readers; HUP/INT/TERM/SIGKILL;
and runner self-interruption against local fake release assets. Every child and
the overall runner have deadlines. It does not contact GitHub or modify the real
home directory.

Guided setup writes a zero-project config, can enable Worktrunk and selected-agent hooks, and can install the tmux popup binding. Add the first Git repository explicitly from Station after setup. Generated tmux and hook commands persist the resolved absolute launcher paths, whether they came from an installed runtime or the current checkout, so later processes do not depend on setup's PATH. When bare `stn` launchers are not on `PATH`, setup offers `pnpm --dir <checkout> station:link` as the convenience path for bare terminal commands.

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

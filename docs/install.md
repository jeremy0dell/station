# Install Station

Station is experimental pre-alpha software. The current public version is
`v0.0.0-pre-alpha.4`.

## Binary Requirements

The compiled binary supports these targets:

- macOS 13 or newer on Apple silicon (`darwin-arm64`)
- macOS 13 or newer on Intel (`darwin-x64`)
- glibc 2.39 or newer Linux on arm64 (`linux-arm64`)
- glibc 2.39 or newer Linux on x64 (`linux-x64`)

Windows and musl Linux are not supported. The binary install needs `curl` and
either `sha256sum` or `shasum`; it does not require a GitHub account, GitHub CLI,
a source checkout, Homebrew, Node.js, pnpm, or Bun. `stn setup` handles the
separate tools needed for the complete agent workflow after Station is
installed. Report feedback through
[GitHub Issues](https://github.com/jeremy0dell/station/issues).

Station uses the platform `lsof` executable (`/usr/sbin/lsof` on macOS,
`/usr/bin/lsof` on Linux) to prove that an unreachable Unix socket has no live
owner. Its absence does not block a fresh Observer, but setup reports a
recommended warning because stale-socket recovery and build handoff must refuse
to proceed without that evidence. Linux VM images can install it with
`sudo apt-get install lsof` (Debian/Ubuntu) or `sudo dnf install lsof`
(Fedora/RHEL); macOS normally includes it.

## Let Your Agent Install and Validate Station

If you prefer an agent-led install, paste this prompt into a coding agent on the
target machine:

```text
Install experimental Station v0.0.0-pre-alpha.4 and validate setup on this machine.

Safety and scope:
- Do not clone the repository or build from source. Use only
  `https://github.com/jeremy0dell/station/releases/download/v0.0.0-pre-alpha.4/install.sh`.
- Install to `~/.local/bin` unless I approve another location. Do not edit any
  shell startup file. If the installer reports a PATH mismatch, do not assume
  an export persists across agent tool calls or reaches my Terminal. Use the
  absolute installed `stn` path for every remaining agent command, show me the
  exact future-shell export, and treat it as an unfinished manual step until I
  verify all three launchers in a new shell.
- Do not infer or add the current directory as a Station project.

Validation:
1. Verify all three absolute installed launcher paths and run `stn --version`
   through the absolute installed path. Record `command -v stn`,
   `command -v stn-ingress`, and `command -v stn-tmux-popup` only as evidence
   about the current agent execution context.
2. Run the guided `stn setup` through the absolute installed path and let me
   answer its choices. If you cannot pass through an interactive prompt, ask me
   to run it, then continue afterward.
3. Run `stn setup check --json` and `stn doctor` through the absolute installed
   path.
4. Report the installed path and version, whether setup reports
   `summary.requiredOk: true`, doctor health, future-shell verification state,
   and any remaining manual steps. A valid zero-project config is acceptable.
   Do not claim success while a required check is failing or future-shell PATH
   remains unverified.
```

The agent should stop at approval boundaries rather than inventing setup
choices.

## Install the Exact Public Pre-Alpha

From any directory, run:

```bash
curl -fsSL https://github.com/jeremy0dell/station/releases/download/v0.0.0-pre-alpha.4/install.sh | sh
```

The released `install.sh` is stamped with `v0.0.0-pre-alpha.4`. With no
arguments it downloads only that tag's matching native archive and
`SHA256SUMS` over unauthenticated HTTPS. The old `v0.7.1-rc.*` releases were
internal previews, not predecessors in the public version line.

The installer selects the matching platform archive, verifies it against
`SHA256SUMS`, and installs these launchers in `~/.local/bin` by default:

```text
stn
stn-ingress
stn-tmux-popup
```

It also installs the redistributed license under
`${XDG_DATA_HOME:-$HOME/.local/share}/station/`.

## Verify the Install

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
shells. If an agent runs the assignment, it does not change your Terminal or a
later login shell; the agent should continue through the absolute installed
`stn` path and report future-shell PATH as unverified until you check all three
launchers in a new shell. The installer does not read, create, or edit shell
startup files.

Successful setup preserves the final probe's current-process launcher
mismatch under **Remaining**, including the selected absolute launcher paths.
When installed launchers share one directory, setup also repeats a safely
quoted current-shell PATH block and uses the absolute selected `stn` executable
for its immediate doctor and launch commands. It explains that the absolute
commands already work and that configuring the shorter `stn` name is optional.
For that convenience, use PATH rather than a `stn` alias so all three launcher
names resolve together; setup names the directory, leaves shell-configuration
selection to the user, and prints `command -v` checks for all three names. It
does not edit a startup file or generate a future-shell export. If the installer
current-shell block repaired PATH before setup, the final probe is clean and
setup stays concise, but a future login shell remains unverified until you test
it separately.

## Use a Custom Install Directory

Pass an absolute or home-relative path through the exact installer:

```bash
curl -fsSL https://github.com/jeremy0dell/station/releases/download/v0.0.0-pre-alpha.4/install.sh | \
  sh -s -- --install-dir "$HOME/bin"
```

Use the PATH and absolute commands printed by that install rather than the
default `~/.local/bin` examples. The normalized install directory cannot
contain `:` because PATH uses `:` to separate entries. This validation happens
before network requests, temporary-directory creation, or destination mutation.

## Complete First-Run Setup

Run setup only after `stn --version` succeeds. Guided setup requires a real terminal connected to
both stdin and stdout; piping answers is unsupported. If a coding agent cannot pass through that
TTY, it must ask you to run `stn setup` directly and continue with read-only JSON checks afterward.

```bash
stn setup
stn setup check --json
stn doctor
stn tui
```

Setup uses immediate Y/N controls and navigable agent menus. Guided output starts with a compact
read-only inspection step, then shows only the current decision or blocker. Before installing
required tools, it names the selected installations, links their official Homebrew Formulae pages,
and identifies the installation mechanism; the complete machine inventory remains available
through `stn setup check`. Later consent prompts name the command or home-relative target they may
change and call out important non-effects such as preserving shell files, provider trust, unrelated
hooks, and explicit project selection. Station asks before installing tools or updating Station,
provider, shell, or tmux configuration. Ctrl-C cancels safely: completed
bootstrap, installer, config, hook, shell, or tmux changes remain committed, and rerunning setup
inspects the current state before continuing. Native Homebrew and agent-installer output remains
live between explicit Station start and finish boundaries; no Clack prompt or spinner competes for
the terminal.

Setup checks or offers to install or upgrade Worktrunk, tmux, diffnav, and git-delta;
requires a runnable supported agent CLI; writes a valid zero-project
`~/.config/station/config.toml`; starts or restarts the Observer; and offers
Worktrunk shell integration and the `Ctrl-b Space` tmux popup binding. With no
config, exactly one runnable agent CLI is inferred and identified; several
runnable CLIs require explicit guided selection. When multiple CLIs are selected for a new config,
setup asks which selected CLI should be the default. Check, plan, dry-run, and noninteractive apply
never choose the catalog-first CLI in an ambiguous case. An existing config always preserves and
marks its global default, even when another CLI is available or selected.

If no supported agent CLI is runnable, setup presents one multiselect containing Claude Code,
Codex, Cursor Agent, OpenCode, and Pi. An empty selection declines installation; selected installers
run independently in the selected order, and one failure does not prevent later choices. On macOS with Homebrew available,
Codex and Claude Code use the official casks and OpenCode and Pi use fully
qualified official core formulae; Cursor uses its unattended vendor installer.
Without a usable Homebrew package, Codex runs with the vendor's documented
noninteractive mode under an isolated installer home, OpenCode receives
`--no-modify-path`, and npm fallbacks install under `~/.local` with lifecycle
scripts disabled. Setup never starts an agent, enters its sign-in or onboarding
flow, or edits a shell startup file while installing an agent. Each accepted
agent is attempted independently, then setup re-probes the actual CLI. If one
install fails but another runnable agent is available, setup reports the failed
selection and continues; if none is runnable, it stops with recovery guidance.
For every accepted selection, setup prints a clear install heading, temporarily
suspends its own prompt reader, streams the child installer's terminal output,
and prints an explicit completion or failure line before moving on. A quiet or
slow progress bar is therefore still bracketed by visible Station status.

Installing Station itself through Homebrew remains unsupported. Homebrew is
only a setup mechanism for third-party workflow tools and agent CLIs. Its
official macOS bootstrap requires administrator access and may show the normal
password and confirmation prompts after the explicit Station consent prompt.

For required Claude, Codex, Cursor, and OpenCode selections, guided setup
explains that Station needs tracking and asks for consent before changing config
or provider files. Declining stops before a new config or `install_hooks` intent
is written. Noninteractive `apply --yes` is consent for these Station-owned
artifacts, not for provider trust bypass or unrelated hook changes. Setup
re-probes config and artifacts after applying and exits from those fresh facts.
Pi has no external hook artifact requirement. Complete each enabled agent CLI's
own sign-in before starting a real session.

If setup writes the config but cannot activate it, it leaves the config and the
incumbent Observer untouched, prints the exact error and recovery commands, and
exits nonzero before installing remaining tracking artifacts. Restore the socket
access/evidence named by that error, run the printed
`stn --config ... observer restart`, then run the printed setup command to
finish and re-probe those artifacts. Restoring a live socket to mode `0600`
lets Station reconnect to its original process.

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
| Print install-time current-shell, future-shell, and absolute recovery | Station installer |
| Repeat final current-shell recovery and absolute next commands | `stn setup` |
| Choose or edit a shell configuration | User |
| Write Station configuration and install integrations | `stn setup` |
| Choose the first Git project | User in Station |

The installer:

- accepts only `darwin-arm64`, `darwin-x64`, `linux-arm64`, and `linux-x64`;
- downloads the exact `stn-v{version}-{os}-{arch}.tar.gz` asset and `SHA256SUMS` from the stamped public tag with unauthenticated `curl` (`{version}` excludes the tag's leading `v`);
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

Each lock's sole `owner-*` file records the installer PID, requested tag, and
the unique ownership token embedded in its filename. Cleanup
removes only that token-specific file and revalidates the lock inode, so an
earlier installer cannot remove a replacement lock. The installer acquires
the command lock first and the license lock second, skips the second acquisition
if both paths coincide, and releases them in reverse order. A refusal happens
before a release download, names
the lock and readable owner PID, states that the existing Station installation
was unchanged, and tells the user to wait and retry. A license-lock refusal
releases the command lock and performs no release request.

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

Every public version carries its own exact-tag stamped installer asset.
Published tags and assets are immutable; do not delete, move, or overwrite
them. If a published binary is bad, reinstall a known-good published version
and ship a higher version containing the revert or fix.

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

`lsof` is a recommended recovery dependency rather than a launch prerequisite:
fresh startup works without it, while stale-socket recovery and Observer build
handoff remain blocked until holder evidence is available.

`bootstrap.sh`'s `brew bundle` installs the brew-available subset (Worktrunk,
Bun, tmux, diffnav, git-delta, plus keg-only Node 24); Git / Command Line Tools
are obtained separately, and guided `stn setup` can offer the supported agent
CLIs described above.

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

`pnpm smoke:install` exercises stamped and explicit public selection plus
release-ID-scoped authenticated draft acceptance; strict download arguments;
all four platform mappings; startup-file
non-interaction, safely evaluated PATH guidance for spaces and apostrophes,
normalized-colon preflight, and physical PATH shadow behavior;
checksum/archive/probe failures; dual-lock concurrency and stale recovery;
rollback and ambiguous commit points; continuous readers; HUP/INT/TERM/SIGKILL;
and runner self-interruption against local fake release assets. Every child and
the overall runner have deadlines. It does not contact GitHub or modify the real
home directory.

Guided setup writes a zero-project config, can enable optional Worktrunk hooks, requires prepared tracking artifacts for selected/default Claude, Codex, Cursor, and OpenCode harnesses, and can install the tmux popup binding. Add the first Git repository explicitly from Station after setup. Generated tmux and hook commands persist the resolved absolute launcher paths, whether they came from an installed runtime or the current checkout, so later processes do not depend on setup's PATH. Hook setup validates the active `stn` runtime and its exact `stn-ingress` sibling; an unrelated launcher elsewhere on `PATH` cannot satisfy that pair. Successful output describes these artifacts as **Prepared**, not runtime Ready. Codex may still require `/hooks` review; setup does not mutate trust state, enable unrelated hooks, or claim delivery was verified. When bare `stn` launchers are not on `PATH`, setup offers `pnpm --dir <checkout> station:link` as the convenience path for bare terminal commands.

Useful smoke options:

```bash
pnpm smoke:release -- --skip-build
pnpm smoke:release -- --skip-scripted
pnpm smoke:release -- --keep-temp
```

## Local Command

During development, either use the repo-local command:

```bash
pnpm stn hooks doctor worktrunk
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

Run `stn hooks doctor worktrunk` and `stn doctor` after editing the config.
Both surfaces validate the same canonical Worktrunk hook commands; full doctor
additionally reports config diagnostics, Worktrunk availability and stale
registrations, effective automation mode, SQLite health, provider health,
local-state retention, and debug-bundle availability.

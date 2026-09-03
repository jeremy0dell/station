# Install Station

Station is experimental pre-alpha software. The current public version is
`v0.0.0-pre-alpha.14.3`.

## Binary Requirements

The compiled binary supports:

- macOS 13 or newer on Apple silicon (`darwin-arm64`)
- macOS 13 or newer on Intel (`darwin-x64`)
- glibc 2.39 or newer Linux on arm64 (`linux-arm64`)
- glibc 2.39 or newer Linux on x64 (`linux-x64`)

Windows and musl Linux are not supported. Installation requires `curl` and
either `sha256sum` or `shasum`; it does not require a GitHub account, GitHub CLI,
a source checkout, Homebrew, Node.js, or Bun.

The complete workflow also uses external tools configured by `stn setup`.
Station requires the platform `lsof` executable to prove Station Host and socket
ownership. On Linux, install it with `sudo apt-get install lsof` (Debian/Ubuntu)
or `sudo dnf install lsof` (Fedora/RHEL). See
[System dependencies](system-dependencies.md) for the complete setup contract.

## Let Your Agent Install and Validate Station

If you prefer an agent-led install, paste this prompt into a coding agent on the
target machine:

```text
Install experimental Station v0.0.0-pre-alpha.14.3 and validate setup on this machine.

Safety and scope:
- Do not clone the repository or build from source. Use only
  `https://github.com/jeremy0dell/station/releases/download/v0.0.0-pre-alpha.14.3/install.sh`.
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
curl --disable -fsSL https://github.com/jeremy0dell/station/releases/download/v0.0.0-pre-alpha.14.3/install.sh | sh
```

The installer downloads only the stamped tag's matching native archive and
`SHA256SUMS`. It verifies the checksum, archive contents, and embedded version
before atomically activating `stn`. It installs these launchers in
`~/.local/bin` by default:

```text
stn
stn-ingress
stn-tmux-popup
```

It also installs the license and an ownership receipt used by `stn update`. It
does not read, create, or edit shell startup files, and installation does not add
the current directory as a Station project. The compiled runtime contract is in
[Single-binary Station](single-binary.md).

## Verify the Install

The installer physically verifies all three launcher names. If the install
directory is not visible in the current shell, it prints a current-shell PATH
block, a future-shell export for your chosen shell configuration, and an
`Absolute fallback` command. For the default directory, run:

```bash
PATH="$HOME/.local/bin${PATH:+":$PATH"}"
export PATH
hash -r

command -v stn
command -v stn-ingress
command -v stn-tmux-popup
stn --version
```

All three names should resolve under `~/.local/bin`, and `stn --version` should
print the installed release version. The PATH assignment affects only the
current shell. Add the installer's exact export to your chosen shell
configuration if you want it applied in future shells, then verify all three
names in a new shell.

## Use a Custom Install Directory

Pass an absolute or home-relative path through the exact installer:

```bash
curl --disable -fsSL https://github.com/jeremy0dell/station/releases/download/v0.0.0-pre-alpha.14.3/install.sh | \
  sh -s -- --install-dir "$HOME/bin"
```

Use the PATH and absolute commands printed by that install. The normalized
directory cannot contain `:` because PATH uses `:` to separate entries. The
installer rejects that path before network requests,
temporary-directory creation, or destination mutation.

## Complete First-Run Setup

Run setup after `stn --version` succeeds:

```bash
stn setup
stn setup check --json
stn doctor
stn tui
```

Guided setup needs a real terminal connected to stdin and stdout. It asks before
installing tools or changing Station, provider, shell, or tmux configuration.
Setup never starts an agent or enters its sign-in flow. Each accepted agent is
attempted independently; Station streams the child installer's terminal output
and reports completion or failure before continuing.

Setup writes a valid zero-project `~/.config/station/config.toml`; it never
adopts the current directory or an ancestor repository. Add the first Git
project explicitly in Station. See [Quick start](quick-start.md) for that flow
and [Configuration](configuration.md) for later changes.

## Update Station

Inspect the complete update plan before applying it:

```sh
stn update --dry-run --json
stn update
```

Dry run is read-only. Station detects the installation owner, and
package-manager-owned installs defer to that manager unless you explicitly use
`stn update --drive-package-manager`. Updates default to preserving a busy
compatible Station Host; uncertain preservation fails closed. `--no-handoff`
opts out and can leave the new TUI unable to use the incumbent Host.

After a normal exit, the TUI may report:

```text
Station <version> is available — run `stn update`
```

See [Single-binary Station](single-binary.md) for update ownership and runtime
compatibility boundaries.

## Interrupted Install Recovery

The installer serializes changes to the commands and license, validates staged
artifacts before the binary commit, and refuses conflicting destination paths.
An interruption before that commit leaves the existing Station installation
unchanged. If activation may have committed, the installer exits nonzero and
prints the absolute `stn --version` command to inspect the result.

If an interrupted process leaves a lock, inspect its sole owner file at
`<install-dir>/.station-install.lock/owner-*` or
`<data-home>/station/.station-install.lock/owner-*`. Remove the lock manually
only after confirming that no installer with the recorded PID is alive, then
retry the same exact-tag install.

Atomic rename gives readers a complete old or new runtime, but the installer
makes no post-power-loss durability guarantee because it does not `fsync` files
or directories. After power loss, inspect the absolute installed `stn --version`
and both lock directories before retrying.

## Develop from Source

Source development has separate runtime and isolation requirements. Start with
[Development](development.md), then use [Local development](local-development.md)
and [Testing](../tests/README.md) for the appropriate workflow and checks.

Report installation problems through
[GitHub Issues](https://github.com/jeremy0dell/station/issues).

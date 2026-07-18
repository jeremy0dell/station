<p align="center">
  <img src="./station/assets/station-icon.svg" alt="Station logo" width="64" height="64">
</p>

# station

**Run multiple AI coding agents from one terminal, without them fighting over your code.**

Station gives every agent an isolated Git worktree, keeps its terminal session alive, and shows all active projects and sessions in one terminal workspace. Bring Claude Code, Codex, Cursor, OpenCode, or Pi; Station coordinates the surrounding work without replacing the harness.

<p align="center">
  <img width="1728" height="1048" alt="Station terminal workspace showing multiple agent panes and a toggleable dashboard" src="https://github.com/user-attachments/assets/358c6c52-800f-496a-ada0-c8c291c8c33f" />
  <br>
  <em>Terminal multiplexing with a toggleable dashboard.</em>
  <br><br>
  <img width="1030" height="613" alt="Station dashboard listing projects, worktrees, and live agent sessions" src="https://github.com/user-attachments/assets/fe73f04d-bb05-461d-ae01-92e10d42b929" />
  <br>
  <em>One live view of every project, worktree, and agent session.</em>
</p>

## Why Station

- **Isolated worktrees** keep concurrent agents from editing the same checkout.
- **Persistent terminal sessions** continue running when the Station UI closes.
- **Live agent status** shows which sessions are working, ready, or need attention.
- **One TUI** creates, opens, renames, and removes sessions across projects.
- **Built-in diagnostics** provide health checks, trace lookup, and redacted debug bundles.

<p align="center">
  <img width="1728" height="1047" alt="Station diff view showing an agent transcript beside its working-tree changes" src="https://github.com/user-attachments/assets/6aaa96da-4827-4216-b994-4cfb2b0fb29f" />
  <br>
  <em>Follow an agent and review its changes without leaving the terminal.</em>
</p>

## Install the binary

This procedure installs Station from authenticated GitHub release assets and
assumes your GitHub account can read the private `jeremy0dell/station`
repository. Install the [GitHub CLI](https://cli.github.com/) first. The binary
does not require Node.js, pnpm, Bun, or a source checkout.

### 1. Authenticate GitHub CLI

```sh
gh auth login --hostname github.com
gh auth status --hostname github.com
gh repo view jeremy0dell/station --json nameWithOwner --jq '.nameWithOwner'
```

If GitHub CLI is already authenticated, skip the login command. The repository
check should print `jeremy0dell/station`; a not-found response means the active
account cannot read the private repository. The commands below use the existing
authentication, so do not paste credentials into the install command.

### 2. Install the current preview candidate

Run this from any directory:

```sh
(
  set -eu
  umask 077
  export GH_HOST=github.com
  tag=v0.7.1-rc.2
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

`v0.7.1-rc.2` is the current private-binary candidate; the earlier
`v0.7.0` and `v0.7.1-rc.1` candidates remained unpublished. Run the recipe
after the candidate is published. It fetches the installer and binary from the
same immutable release tag, verifies the release checksum, and installs `stn`,
`stn-ingress`, and `stn-tmux-popup` in `~/.local/bin` by default. It does not
expose or print your GitHub credentials. After the first stable release, the
commented assignment resolves the latest stable tag. Immutable rollback begins
with the second published binary release because there is no earlier published
binary artifact.

### 3. Verify and start Station

The installer prints an exact PATH command if `~/.local/bin` is not visible in
the current shell. For the default install directory, run:

```sh
PATH="$HOME/.local/bin${PATH:+":$PATH"}"
export PATH
hash -r

command -v stn
stn --version
stn setup
stn doctor
stn
```

The installer never edits shell startup files or adds the current directory as
a project. See [Install](docs/install.md) for supported platforms, exact-version
installs, custom install directories, and recovery. Then follow the
[Quick start](docs/quick-start.md) to create the first agent session.

### Let your agent install and validate Station

Paste this prompt into a coding agent running on the machine where you want
Station installed:

```text
Install Station private preview candidate v0.7.1-rc.2 and validate setup on this machine.

Use the private GitHub repository jeremy0dell/station through GitHub CLI.

Safety and scope:
- First run `gh auth status --hostname github.com`, then verify repository
  access with `gh repo view jeremy0dell/station`. Never ask me to paste,
  extract, or print credentials. If authentication or repository access fails,
  stop and ask me to run `gh auth login --hostname github.com` myself.
- Do not clone the repository or build from source. Use release tag
  `v0.7.1-rc.2`, read `docs/install.md` from that same tag with authenticated
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

## How it works

Station combines four runtime roles:

- The **observer** reconciles project, worktree, terminal, harness, and
  repository state into one current graph.
- The **TUI** renders that graph and submits typed commands without reaching
  into providers directly.
- The **CLI** handles setup, health checks, snapshots, observer lifecycle, and
  debugging.
- **Integrations** adapt Worktrunk, tmux, supported agent harnesses, and GitHub
  behind provider boundaries.

Read [Overview](docs/overview.md) for the mental model and
[Harnesses](docs/harnesses.md) for agent-status coverage.

## Documentation

Start at the [documentation home](docs/index.md), or go directly to:

- [Quick start](docs/quick-start.md) — add a project and run the first agent
- [Install](docs/install.md) — installation, verification, updates, and recovery
- [Configuration](docs/configuration.md) — runtime, project, harness, and
  workspace settings
- [Harnesses](docs/harnesses.md) — supported agents and status coverage
- [Diagnostics](docs/diagnostics.md) — health checks and support evidence
- [Limitations and workarounds](docs/limitations.md) — current user-visible
  constraints
- [Development](docs/development.md) — contributor environment and test gates
- [Architecture](docs/architecture.md) — repository boundaries and sources of
  truth

## Development

Source development uses Node.js 24.2+ (and below 25), pnpm 11, and Bun
1.3.14.

```sh
pnpm install
pnpm build
cd station && bun install && cd ..
pnpm test:all
```

See [Development](docs/development.md) and
[Local development](docs/local-development.md) before running provider-backed
or real-agent lanes.

## Release status

Station v0.7 is a private preview for local daily use. The authenticated
binary supports macOS and Linux on arm64 and x64. User-facing commands and
configuration may change between preview releases.

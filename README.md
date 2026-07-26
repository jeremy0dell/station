<p align="center">
  <img src="./station/assets/station-icon.svg" alt="Station logo" width="64" height="64">
</p>

# station

**Run multiple AI coding agents from one terminal, without them fighting over your code.**

Station gives every agent an isolated Git worktree, keeps its terminal session alive, and shows all active projects and sessions in one terminal workspace. Bring Claude Code, Codex, Cursor, OpenCode, or Pi; Station coordinates the surrounding work without replacing the harness.

## Install

Station is experimental pre-alpha software. Install the current public version,
`v0.0.0-pre-alpha.1`, with one command:

```sh
curl -fsSL https://github.com/jeremy0dell/station/releases/download/v0.0.0-pre-alpha.1/install.sh | sh
```

See the [installation guide](docs/install.md) for supported platforms, runtime
floors, verification, custom directories, and recovery.

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

## Installation details

The version-stamped installer downloads only that tag's archive and
`SHA256SUMS`, verifies the checksum and archive manifest, and atomically installs
`stn`, `stn-ingress`, and `stn-tmux-popup` in `~/.local/bin`. It needs `curl`
and either `sha256sum` or `shasum`; it does not need a GitHub account, GitHub
CLI, Node.js, pnpm, Bun, or a source checkout.

Supported native targets and runtime floors:

- macOS 13 or newer on Apple silicon (`darwin-arm64`) or Intel (`darwin-x64`)
- glibc 2.39 or newer Linux on arm64 (`linux-arm64`) or x64 (`linux-x64`)
- Windows and musl Linux are not supported

### Verify and start Station

The installer prints an exact PATH command if `~/.local/bin` is not visible in
the current shell. For the default install directory, run:

```sh
PATH="$HOME/.local/bin${PATH:+":$PATH"}"
export PATH
hash -r

command -v stn
stn --version
stn setup
stn setup check --json
stn doctor
stn
```

This PATH assignment affects only the shell where it runs. An agent tool shell
does not update your Terminal or future login shells; use the installer's
absolute `stn` fallback for agent-side continuation, and keep future-shell PATH
as an unfinished manual step until a new shell resolves all three launchers.
The installer never edits shell startup files or adds the current directory as
a project. See [Install](docs/install.md) for supported platforms, exact-version
installs, custom install directories, and recovery. Then follow the
[Quick start](docs/quick-start.md) to create the first agent session.

### Let your agent install and validate Station

Paste this prompt into a coding agent running on the machine where you want
Station installed:

```text
Install experimental Station v0.0.0-pre-alpha.1 and validate setup on this machine.

Safety and scope:
- Do not clone the repository or build from source. Use only
  `https://github.com/jeremy0dell/station/releases/download/v0.0.0-pre-alpha.1/install.sh`.
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

Station `v0.0.0-pre-alpha.1` is an experimental pre-alpha. User-facing commands,
configuration, state, and release packaging may change without compatibility.
The old `v0.7.1-rc.*` releases were internal previews, not predecessors in the
public version line. Report feedback and bugs through
[GitHub Issues](https://github.com/jeremy0dell/station/issues).

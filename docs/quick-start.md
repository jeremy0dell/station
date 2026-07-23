# Quick Start

This guide starts with an installed Station binary. If `stn --version` does not work yet, follow [Install](install.md) first.

## 1. Run Setup

```sh
stn setup
```

Setup checks the tools Station uses, requires at least one supported agent CLI, and lets you enable one or more detected CLIs. For a new config, the first selection becomes the default. Setup writes `~/.config/station/config.toml`, starts the observer, and offers provider-specific hooks and the tmux popup binding. It does not add a project automatically.

Complete each enabled agent CLI's own sign-in before using it for a real session. Confirm the environment is ready:

```sh
stn doctor
```

## 2. Launch Station

```sh
stn
```

Outside tmux, this opens the full terminal workspace. Inside an existing tmux session, bare `stn` opens the read-only dashboard popup; use `stn tui` when you want the full workspace there.

On a cold boot, press `Enter` or `Space` to open project view.

## 3. Add a Project

On an empty dashboard:

1. Press `Enter` or `A` on **Add your first project**.
2. Choose a folder inside an existing Git repository.
3. Review the detected Git root and confirm it.

Station resolves a nested folder to its repository root. It does not add an ordinary non-Git directory.

## 4. Create an Agent Session

1. Press `N` to open **Create Session**.
2. Review the project, generated session name, and agent harness.
3. Change a field if needed.
4. Press `Enter` on **Create session**.

Station creates an isolated worktree, launches the selected agent, and opens its terminal pane. The dashboard tracks the session as it works, becomes ready, or needs attention.

## 5. Navigate the Workspace

| Action | Key |
| --- | --- |
| Open the focused session | `Enter` |
| Move between dashboard rows | `Up` / `Down` |
| Jump to the next session needing you | `Tab` |
| Create another session | `N` |
| Search sessions | `/` |
| Open help | `H` or `?` |
| Toggle the project dashboard | `Ctrl-O` |
| Exit Station | `Ctrl-Q` |

The on-screen footer and help overlay are the authoritative key reference for the active screen.

## 6. Leave and Return

Exit the UI with `Ctrl-Q` or close the outer terminal. Station-owned panes continue running in the background host. Run `stn` again to restore the workspace and reattach to live panes.

Use `stn doctor` if a session does not reconnect or a provider appears unavailable.

## Next Steps

- [Configuration](configuration.md) — change defaults, projects, hooks, and workspace behavior.
- [Harnesses](harnesses.md) — see what each agent integration can report.
- [Diagnostics](diagnostics.md) — learn the health and support commands.
- [Limitations and workarounds](limitations.md) — understand current preview constraints.

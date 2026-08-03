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

On an empty dashboard, **Add your first project** is a real action. Click it, press `A`, or focus it and press `Enter`.

In the folder flow, a single click selects a row. Use the visible **Open**, **Choose**, **Parent**, **Search**, and **Cancel** controls to continue with the pointer, or use their displayed keys. Review the detected Git root, then use **Add project**; if no Git root is detected, **Choose folder** remains the focused recovery action.

Station resolves a nested folder to its repository root. It does not add an ordinary non-Git directory. Pointer-only, direct-command, and arrow-plus-`Enter` paths all use the same admission rules.

## 4. Create an Agent Session

1. Press `N` to open **Create Session**.
2. Review the interactive **Project (P)**, **Name (N)**, and **Agent (A)** rows.
3. Click a row, use its direct command, or move focus with arrows and press `Enter`.
4. Activate **Create session (C)** with the pointer, `C`, or focused `Enter`.

The name editor exposes **Name**, **Save**, and **Back** controls. `Up`/`Down` moves focus, `Left`/`Right` edits the text cursor while Name is focused, and the visible pointer controls can save or return without a keyboard action key.

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

### Optional persistent filter

The persistent free-text workflow is currently default-off. Enable it in
`~/.config/station/config.toml`, then reopen Station so renderer composition reads the flag:

```toml
[feature_flags]
dashboard_persistent_filter = true
```

Press `/` to edit a soft preview: rows stay in place while visible-text matches highlight and
nonmatches dim. Press `Tab`, then `S`, `P`, or `A` to add a Status, Project, or Agent condition.
Toggle values with their visible slot keys or with arrows plus `Space`; `Enter` or `[✓]` applies
the condition, while `Left` or `[←]` returns to the field chooser. `Esc` from either stage, or
clicking outside the panel, closes the condition menu and discards only its unapplied changes.

Free text and separate fields are ANDed; values inside one field are ORed. `Ctrl-U` clears the
complete draft. Press `Enter` from text editing to apply a hard filter—even when free text is blank
and conditions are selected. Matches inside collapsed projects still contribute to the count;
the project disclosure remains clickable so you can show or hide those matching sessions. Use
`/ edit` or `Esc clear` from the footer with either keyboard or
pointer. `Q` closes while retaining the applied free text and conditions for the next warm reopen.

## 6. Leave and Return

Exit the UI with `Ctrl-Q` or close the outer terminal. Station-owned panes continue running in the background host. Run `stn` again to restore the workspace and reattach to live panes.

Use `stn doctor` if a session does not reconnect or a provider appears unavailable.

## Next Steps

- [Configuration](configuration.md) — change defaults, projects, hooks, and workspace behavior.
- [Harnesses](harnesses.md) — see what each agent integration can report.
- [Diagnostics](diagnostics.md) — learn the health and support commands.
- [Limitations and workarounds](limitations.md) — understand current preview constraints.

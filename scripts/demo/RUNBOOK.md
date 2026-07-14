# Demo and screenshot runbook

Station has two complementary demo modes:

- The static showcase is instant and deterministic. It renders convincing mock data but does not create repositories or launch sessions.
- The staged workspace is live. It creates isolated repositories, real Git worktrees, current harness defaults, local hooks, observer state, and a dedicated `stationdemo` tmux session. Its files live under `~/.station-demo`.

Neither mode reads projects from your normal Station config.

## Static showcase

From the repository root:

```sh
cd station
STATION_SOURCE=mock STATION_SCENARIO=showcase bun run station
```

Use this for a zero-setup overview or as a fallback during a recording.

## Live multi-repository workspace

The source checkout must be built, both dependency lanes must be installed, and the normal development tools from `Brewfile` must be available:

```sh
pnpm install
pnpm build
(cd station && bun install)
scripts/demo/stage.sh
~/.station-demo/run.sh
```

Staging performs network clones. Linux is still a sizable checkout even though it is shallow and sparse, because the demo intentionally materializes code through three directory levels.

The generated `run.sh` forces the full Station workspace even when invoked from tmux. It exports isolated Station and provider paths before launching the TUI.

### What gets staged

| Project | Source | Branch worktrees | Default harness |
| --- | --- | ---: | --- |
| linux | shallow public clone, `master` | 3 | Claude |
| ghostty | shallow public clone, `main` | 2 | Codex |
| svelte | shallow public clone, `main` | 1 | OpenCode |
| is-even | shallow public clone, `master` | 1 | Pi |
| t3-code | generated local monorepo, `main` | 10 | Cursor |

That is five configured projects and 17 non-main worktree rows. A sixth local repository, `~/.station-demo/repos/web`, is deliberately omitted so the **Add Project** flow has something safe to add.

The public clones retain their real `origin` URLs, while GitHub metadata polling is disabled in the demo config. The generated `t3-code` fixture is a full local repository rather than a sparse clone.

### Sparse depth

The four public clones include root files and files nested one, two, or three directories below the repository root. Directories below that boundary remain excluded. Linked worktrees inherit the same sparse definition.

For example:

```sh
cd ~/.station-demo/repos/linux
git sparse-checkout list
find . -maxdepth 4 -type f | head -80
```

Inside Station, open a Linux row with `[+sh]` and run the same `find` command to show that the workspace contains meaningful source structure rather than only root-level files.

### Harness and terminal behavior

Staging does not silently start 17 agents or terminal processes. Rows initially show no agent. Opening a blank row launches the project's configured default harness in the isolated workspace; **New Session** lets you select any configured harness explicitly.

Current config supports a default per project, not a declarative default per branch. The historical mixed T3 branch assignments therefore become one supported project default, Cursor. Select a different harness in **New Session** when demonstrating a mixed T3 fleet.

Hooks are installed only for CLIs found on the machine. Missing harness CLIs do not prevent staging, but their assigned rows cannot launch until those CLIs are installed and signed in. Hook install and doctor output is recorded in `~/.station-demo/hooks.txt`.

### Isolation and reset

The live demo keeps these paths under `~/.station-demo`:

- Station config, observer database/logs, sockets, and native layout
- Worktrunk config and managed worktrees
- Codex, Claude, Cursor, and OpenCode config homes
- the generated launcher and hook report

Codex authentication and Cursor's Git/SSH configuration are linked into their isolated homes when present, so real harnesses can still authenticate. Staging and reset do not rewrite the source checkout or normal Station config.

Reset with:

```sh
scripts/demo/reset.sh
```

Reset gracefully stops the isolated observer, checks the demo observer and persistent-host socket owners, stops the `stationdemo` tmux session, and then removes the demo root. A non-empty root must carry the marker created by `stage.sh` or match the prior demo config signature; reset refuses an unrecognized directory.

To use a different location for both commands:

```sh
export STATION_DEMO_ROOT=/path/to/station-demo
scripts/demo/stage.sh
"$STATION_DEMO_ROOT/run.sh"
scripts/demo/reset.sh
```

Custom roots may contain spaces, but must not contain `.` or `..` path components, quotes, backslashes, or newlines; staging rejects values that cannot be represented safely in the generated TOML.

## Suggested captures

Use a fixed terminal size such as 120x34, a clean high-contrast theme, and a Nerd Font.

| Shot | How |
| --- | --- |
| Overview | Use the static showcase, wait for the first settled frame, then capture. |
| Live fleet | Stage the workspace, launch `~/.station-demo/run.sh`, and show all five projects and 17 rows. |
| Default launch | Open one blank row from each project to show its project harness assignment. |
| Explicit launch | Press `N`, choose the T3 project and a non-Cursor harness, then create the session. |
| Browse code | Open a Linux shell and run `find . -maxdepth 4 -type f \| head -80`. |
| Add project | Press `A` and select `~/.station-demo/repos/web`. |
| Run checks | Open the added `web` project, split with `Ctrl-\`, then run `./check.sh`. |
| See diff | Focus `web`, then use **See diff (split right)** to render its planted change. |

Use PNG for stable overview frames and GIF/video for interactions. Never record against your normal observer when the demo can provide equivalent data.

## Optional check automation

The **See diff** automation is built in. To add a split-pane check command for the staged demo, append this to `~/.station-demo/config.toml` after staging. Providing `automations` replaces the defaults, so both entries are included:

```toml
[workspace]

[[workspace.automations]]
id = "see-diff"
label = "See diff (split right)"
[[workspace.automations.steps]]
split = "right"
anchor = "origin"
command = "git -c color.ui=always diff | delta --paging=always"
run = "execute"
focus = true

[[workspace.automations]]
id = "run-checks"
label = "Run checks (split below)"
[[workspace.automations.steps]]
split = "below"
command = "./check.sh"
run = "execute"
focus = true
```

Rerunning `stage.sh` regenerates the config and removes this manual addition.

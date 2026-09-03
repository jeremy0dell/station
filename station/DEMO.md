# Station Demo

This is a short presenter walkthrough for Station's terminal workspace and
dashboard. It is not a complete feature or keybinding reference. Press `H` or
`?` in the dashboard for current controls, and use
[TUI Development](../docs/tui.md) for the durable interaction contract.

## Choose a safe lane

Start with the deterministic mock. From the repository root:

```bash
cd station
STATION_SOURCE=mock STATION_SCENARIO=showcase bun run station
```

The `showcase` fixture uses example projects and identifies itself as mock data.
It does not connect to an Observer or display local project and session data.
Exit the native workspace with `Ctrl-Q`.

For screenshots or recordings, follow the
[demo and screenshot runbook](../scripts/demo/RUNBOOK.md). It owns terminal
setup, capture isolation, staging, and reset instructions.

### Optional isolated live lane

Use the live lane only when the demo needs to create a Project, worktree, or
agent session. From the repository root:

```bash
scripts/demo/stage.sh
stn --config ~/.station-demo/config.toml
# After exiting Station, from another shell:
scripts/demo/reset.sh
```

Staging replaces `~/.station-demo`; reset deletes it and stops only the Observer
and tmux session selected by that demo configuration. Review the capture runbook
before running either script. Do not substitute your normal Station config or
Observer for a recorded demo. Live agent creation also requires an installed,
authenticated harness.

## Mock-first walkthrough

The core walkthrough takes a few minutes and does not require live services.

### 1. Open the project view

If the Welcome screen appears, select **Open project view** and press `Enter`
(or click it). If a terminal pane is already visible, press `Ctrl-O` to open the
dashboard overlay.

Say: "Station gives every agent session across every Project one terminal-first
control surface."

Point out the banner identifying the fixture as mock data. The `showcase`
snapshot provides recognizable example Projects, working and idle agents,
attention states, diffs, pull requests, and checks without exposing local data.

### 2. Navigate by meaning, not coordinates

- Move with `Up` and `Down`, or hover and click a dashboard cell.
- Press `Tab` to jump to the next session needing attention.
- Activate a Project header with `Enter` or click it to fold or expand its
  sessions.

Say: "Keyboard and pointer actions target the same Project, Group, or session
identity, so filtering and layout changes do not retarget an action by row
position."

### 3. Filter the same view

Press `/`, type `linux`, and press `Enter`. The dashboard keeps the matching
Project context while filtering the session view. Press `Esc` to clear the
applied filter.

Say: "The dashboard is a view over current Station state; filtering does not
change Project or Group membership."

### 4. Let Help own the keys

Press `H` or `?` to open in-app Help, then `Esc` to close it. Use Help during the
presentation instead of reciting a copied key table; it stays aligned with the
current screen and renderer.

If the presentation is specifically about Groups, rerun the same mock path with
`STATION_SCENARIO=grouped-many-projects`. Group headers contain their direct
members and can be folded like Project headers. Keep this as a variation, not a
second feature inventory.

### 5. Close cleanly

Press `Q` to close the current dashboard surface. In the native workspace,
press `Ctrl-Q` to exit Station.

To demonstrate a connection outage, use the deterministic `disconnected` mock
scenario in a separate run. Do not stop a user's Observer for the presentation.

## Optional live walkthrough

Run these steps only in the isolated live lane above. They intentionally mutate
the staged demo data under `~/.station-demo`.

### 1. Add the staged Project

Press `A`, choose `~/.station-demo/repos/web`, review it, and confirm. The script
stages that repository on disk but leaves it out of the initial config so the
addition is visible during the demo.

Say: "Station can register an existing repository without making the dashboard
the source of repository truth."

### 2. Create a session

Press `N`. The review sheet lets the presenter choose a Project, edit the
session **Name**, choose an agent, and select **Ungrouped**, an existing
same-Project root Group, or a new Group name. Move to **Create session** and
press `Enter`.

Say: "Station creates the worktree and launches the selected harness. The Name
is user-visible; Station keeps the generated Git branch identity separate."

Do not retry merely because focus or projection is delayed after creation. Wait
for the resulting session or the bounded warning shown by Station.

### 3. Show current contextual actions

Right-click a Project, Group, or session cell to show the actions available for
that target. Project, Group, and session menus differ; avoid describing the
dashboard or header surface as having no actions.

Use `H` or `?` for the current action keys. The useful presenter story is that
the same workflows are reachable through keyboard focus, visible action cells,
and contextual menus—not an exhaustive list of each route.

### 4. Rename without changing Git identity

Press `R`, choose the created session, enter a new display title, and confirm.
Rename changes the session title shown by Station. It does not rename the Git
branch.

### 5. Reset the isolated lane

Exit Station, then run `scripts/demo/reset.sh` from the repository root. The
reset is intentionally scoped to the demo config, `stationdemo` tmux session,
and `~/.station-demo` tree.

## Reference boundaries

- [Demo and screenshot runbook](../scripts/demo/RUNBOOK.md): privacy-safe
  capture setup, live staging, and reset.
- [TUI Development](../docs/tui.md): current user-visible keys, mutation safety,
  and terminal ownership behavior.
- [Dashboard Architecture](../docs/dashboard-architecture.md): contributor
  ownership and dependency boundaries.

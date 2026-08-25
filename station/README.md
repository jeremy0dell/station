# Station Workspace

Station is the Bun-executed `@station/workspace` package in the repository's
root Bun workspace. Its OpenTUI, native-renderer, and PTY dependencies remain
declared on this package, while Node 24 remains the authoritative source runtime
for the CLI, Observer, and default PTY bridge.

## Runtime

- Bun: `1.4.0`
- Node: required for the default Station-local `node-pty` bridge
- Native `cc`: required only to build the opt-in controlling-terminal helper
- OpenTUI: `@opentui/core@0.4.1`, `@opentui/react@0.4.1`
- React: `19.2.7`

The root `station:devbox` command activates the repository Bun and Node versions
for its child process and performs the frozen root install. Other host scripts
do not install Bun, Node, Zig, OpenTUI, or native requirements on the host machine.

## Run In Container

```bash
station/scripts/run-container.sh
station/scripts/run-container.sh --mock
station/scripts/run-container.sh --hot
station/scripts/run-container.sh --mock --hot
station/scripts/run-container.sh --hot --mock
```

The container lane uses named Docker volumes for `node_modules` and Bun cache.
It is the preferred dependency-isolation path.

## Run On Host

```bash
station/scripts/doctor.sh
station/scripts/run-host.sh
station/scripts/run-host.sh --mock
station/scripts/run-host.sh --hot
station/scripts/run-host.sh --hot --mock
```

Host mode requires Bun `1.4.0`. The default PTY bridge also requires Node;
set `STATION_NODE=/path/to/node` to override its executable. The opt-in
`STATION_PTY_IMPL=bun` path instead requires the helper built by
`bun run build:ctty-helper`. Host mode is for explicit local development only.

## STATION State Source

`Ctrl-O` toggles the read-only STATION mode overlay above the shell pane: live
projects, worktrees, sessions, and agent statuses plus a calm connection
status line. While the overlay is up, input is swallowed (the hidden shell
cannot receive keystrokes) until `Ctrl-O` returns to the pane.

`STATION_SOURCE` selects where that state comes from.

- unset, empty, or `observer`: connect to the local observer through the
  shared `@station/client` runtime. The socket path is
  `STATION_OBSERVER_SOCKET_PATH` if set, else `$XDG_RUNTIME_DIR/station/observer.sock`,
  else `~/.local/state/station/run/observer.sock` (mirrors the repo's
  `@station/config` resolution). With no observer running, the overlay shows a
  calm `reconnecting since …` line; if the observer goes away later, the last
  good snapshot stays visible with a `display-only` status.
- `mock`: serve the Station-owned, contract-shaped fixture without touching
  any socket.

Examples:

```bash
STATION_SOURCE=mock station/scripts/run-host.sh
station/scripts/run-container.sh --mock
```

Bun also loads local env files, so `station/.env.local` can hold
`STATION_SOURCE=mock` for local Station development.

## Configuration (`[workspace]`)

Station reads workspace settings from `[workspace]` in
`~/.config/station/config.toml` (or `STATION_CONFIG_PATH`). Every key is optional
and has a default, so a missing section behaves identically to an empty one. The
section schema is strict: a typo'd key or value degrades to defaults with a
warning rather than refusing to start.

- `welcome_on_boot` (boolean, default `true`) — show the welcome intro over the
  restored layout on a cold boot; dismiss it to drop into your sessions. Set
  `false` to boot straight in. Under `bun --hot` the store is preserved across
  reloads, so the intro only appears on a true cold boot, not a hot reload.
- `scroll_on_output` (`"freeze"` | `"shift"` | `"follow"`, default `"freeze"`)
  — how a pane's viewport reacts when new output arrives **while you are
  scrolled up** reading history: `freeze` keeps the same lines in view (output
  accumulates below), `shift` holds a fixed distance from the bottom (the view
  slides), `follow` snaps back to the live bottom. At the bottom every mode
  tracks live output identically.
- `scrollback_lines` (integer `0`-`10000`, default `10000`) — normal-buffer
  history retained by each pane screen; lower values reduce memory and resize
  work, and changes apply to newly created screens. Warm Host reattachment uses
  a separate, smaller raw-output replay budget.

## Persistence (aux panes + layout)

Station persists its pane layout to `~/.local/state/station/station/layout.json`
(`XDG_STATE_HOME` honored; override with `STATION_LAYOUT_PATH`). On a cold
boot it restores the saved geometry: agent/aux shells respawn fresh in their
saved working directory, and any pane whose PTY is still live in the
`station-station-host` daemon **warm-reattaches** with scrollback. See
`docs/architecture.md` for the host/warm-cold-reattach model and
`docs/local-development.md` for the dev host workflow.

## Root Workspace Dependencies

Station declares each directly imported `@station/*` package with `workspace:*`.
One root install links those packages through Bun's isolated linker, and the
developer-facing Station scripts check the published build identity before
launching or testing:

```bash
bun install
bun run build
bun run --cwd station station
```

`build:ensure` returns immediately when current inputs, package output, and the
published identity agree; otherwise it performs the root build once. Bare
launchers, hooks, ingress delivery, and compiled binaries never build during
runtime work and continue to reject stale output. `scripts/doctor.sh` checks the
root install and build identity without mutating either.

## Terminal PTY

The Station app has a local `src/terminal/` boundary for creating PTYs. The
Node/node-pty bridge remains the default and is intentionally app-local to the
Station workspace. `STATION_PTY_IMPL=bun` selects `Bun.Terminal` and wraps the
payload with the controlling-terminal helper; build it first with
`bun run build:ctty-helper`. `STATION_PTY_IMPL=bun-nocctty` is an explicit
degraded escape hatch: it launches without the helper, so shell job control and
orphan-cleanup guarantees do not apply. Station never falls back to it
automatically. See [Configuration](../docs/configuration.md) for all accepted
selector values.

### 2026-06-11 POC Status

This commit proves the first Station PTY path end to end:

- Station opens directly into a PTY-backed terminal pane.
- Bun owns the OpenTUI process.
- A small Node sidecar owns `node-pty`.
- Raw OpenTUI input is forwarded to the active PTY.
- `Ctrl-Q` is reserved for Station exit.
- `Ctrl-C` is forwarded to the shell.

This section recorded the first POC, which only stripped ANSI into a text node.
Station now has a real VT parser and terminal screen model under
`src/terminal/vt/` (`screen.ts`, `rows.ts`, plus conformance, stress, and
selection tests), so panes render a proper terminal buffer. Cursor movement,
wrapping, alternate screen, prompt redraws, colors, and full-screen TUIs are now
in scope, and formatting bugs against the VT model are worth filing.

Run the explicit bridge and Bun smoke probes with:

```bash
cd station
bun run test:pty
bun run build:ctty-helper
bun run test:pty:bun
```

If this fails, keep the failure local to Station; PTY runtime work stays in the
Station workspace rather than the shared STATION packages.

The bridge smoke command runs a Station-local `node-pty` repair first because Bun can
extract `spawn-helper` without its executable bit. Station runs `node-pty` in a
Node sidecar while Bun owns the OpenTUI process. Keep those workarounds local to
the Station workspace.

## Manual Verification

Run the Station app and verify:

- the terminal enters a full-screen OpenTUI view
- on a cold boot the Welcome screen renders; `Enter`/`Space` drops into the pane grid
- at least one bordered terminal pane renders with a shell process id in the title
- the Station button renders the overlapping-square Station mark in the corner
- typed shell commands echo and render output in the focused pane
- `Ctrl-O` toggles the read-only dashboard overlay; `Ctrl-C` is delivered to the shell process
- `Ctrl-Q` exits back to the shell
- terminal resize keeps the panes visible

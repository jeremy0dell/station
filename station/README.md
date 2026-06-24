# Station Workspace

Station runs on its own Bun lane, intentionally outside the root pnpm
workspace, so OpenTUI, Bun, and native renderer / PTY dependencies stay off
the main pnpm/Node toolchain.

## Runtime

- Bun: `1.3.14`
- Node: required for the Station-local `node-pty` sidecar
- OpenTUI: `@opentui/core@0.4.0`, `@opentui/react@0.4.0`
- React: `19.2.7`

The host scripts check dependencies and fail clearly. They do not install Bun,
Node, Zig, OpenTUI, or native requirements on the host machine.

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

Host mode requires Bun `1.3.14` and Node to already be active. Set
`STATION_NODE=/path/to/node` to override the Node executable used by the
PTY sidecar. Host mode is for explicit local development only.

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

## Configuration (`station.toml`)

Station reads an optional `station.toml` from `~/.config/station/station.toml`
(honoring an absolute `XDG_CONFIG_HOME`). Every key is optional and has a
default, so a missing file behaves identically to an empty one. The schema is
strict: a typo'd key or value degrades to defaults with a warning rather than
refusing to start.

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

## Persistence (aux panes + layout)

Station persists its pane layout to `~/.local/state/station/station/layout.json`
(`XDG_STATE_HOME` honored; override with `STATION_LAYOUT_PATH`). On a cold
boot it restores the saved geometry: agent/aux shells respawn fresh in their
saved working directory, and any pane whose PTY is still live in the
`station-station-host` daemon **warm-reattaches** with scrollback. See
`docs/architecture.md` for the host/warm-cold-reattach model and
`docs/local-development.md` for the dev host workflow.

## Consuming The Shared @station Packages

Live observer mode consumes the repo's built packages: `@station/client`,
`@station/dashboard-core`, and their `@station/contracts`, `@station/protocol`, and
`@station/runtime` graph. Build them at the repo root before running Station:

```bash
pnpm install
pnpm build
```

`scripts/link-station-packages.sh` symlinks the directly imported `@station`
packages into `station/node_modules`; the linked packages resolve their
own dependencies through the repo's pnpm layout. Bun's `file:` dependencies
copy the package without its transitive graph and Bun's `link:` protocol routes
through the global `bun link` registry, so neither works from this isolated
workspace — the symlink script is the proven mechanism. `bun install` prunes
the links, so every package script that needs them (`station`, `dev`, `test`,
`typecheck`) re-runs the link script first, and `scripts/doctor.sh` checks the
dists exist. The container lane mounts the repo root so the same links resolve
inside the container.

## Terminal PTY

The Station app has a local `src/terminal/` boundary for creating PTYs. The
first backend uses `node-pty`; it is intentionally app-local to the Station
workspace.

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

Run the explicit smoke probe with:

```bash
cd station
bun run test:pty
```

If this fails, keep the failure local to Station; PTY runtime work stays in the
Station workspace rather than the shared STATION packages.

The smoke command runs a Station-local `node-pty` repair first because Bun can
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

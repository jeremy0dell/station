# Local Development

How to try your changes **in a worktree, isolated to that worktree, with no
global state** — and how that applies to each of STATION's runtime surfaces
(the Station UI — native workspace in a plain terminal, read-only dashboard in a
tmux popup — and the headless CLI).

> This is the orientation doc for "run my checkout safely." For environment/test
> gates and data-shape conventions see [development.md](development.md); for trace
> IDs and runtime evidence see [debugging.md](debugging.md); for boundaries see
> [architecture.md](architecture.md); for the Station OpenTUI/React UI in
> `station/` see [tui.md](tui.md).

---

## 1. The one thing to understand: isolate the observer

Every STATION surface (the Station UI, the CLI) is a client of one **observer** process.
The observer owns the socket, the SQLite DB, logs, diagnostics, and the hook
spool. By default they all live in the **global** state dir `~/.local/state/station`
and the observer is configured by `~/.config/station/config.toml`. If you run your
checkout against that, you are sharing state with — and can disrupt — your real
day-to-day agents.

**Isolation = point at a config whose observer `state_dir` is worktree-local and
whose `socket_path` is unique to that checkout.** There is **no
`STATION_STATE_DIR` env var**; isolation is config-only. The selector is the
**global `--config <path>` flag**, which must
come **before** the subcommand and applies to *every* observer-backed command:

```bash
# from the worktree root; runs THIS checkout's code (see §5)
node apps/cli/dist/main.js --config /abs/iso-config.toml observer start
node apps/cli/dist/main.js --config /abs/iso-config.toml snapshot --json
node apps/cli/dist/main.js --config /abs/iso-config.toml observer stop
```

A minimal isolated config — copy your real config and override two keys (the
rest, e.g. worktrunk/harness, can stay so worktree rows still appear):

```toml
schema_version = 1

[observer]
state_dir   = "/abs/worktree/.dev-state/observer"
socket_path = "/tmp/stn-example-checkout/observer.sock"
# ...your real [defaults], [worktree.worktrunk], [harness.*] ...
```

Convention: keep all worktree-local runtime state under **`.dev-state/`** at the
worktree root. It is gitignored. Keep Unix sockets on a short path when the
checkout root is long; macOS rejects overlong socket paths. The observer's
station-host socket auto-follows beside the configured observer socket.

### ⚠️ The tmux gotcha (why "everything already has an agent")

**tmux is machine-global** — there is one tmux server per user. The `tmux`
terminal provider enumerates *every* agent pane on your machine, and
terminal-bound harness discovery then marks each of those worktrees as already
having a running agent. In a fresh isolated observer those agents show up as
state `unknown` (no hook events reached this observer to classify them), and
`unknown` counts as "running" — so the UI reports **"this worktree already has a
running agent"** and refuses to launch.

For a clean isolated sandbox (the common case), set the default terminal to noop
so the observer lists no terminal targets and worktree rows stay openable:

```toml
[defaults]
terminal = "noop-terminal"
```

The `native` terminal provider is always registered separately, so host-backed
Station launches still work. The exception is when you are specifically testing
the **classic tmux integration**. Do not point an isolated Observer at the
default tmux server: use the private tmux devbox in §2a, which supplies a
checkout-keyed wrapper/socket and never enumerates or mutates default tmux.

---

## 2. Station UI (runs under Bun) — the turnkey path

Station is the full-screen STATION-owned workspace with PTY-backed panes. For an
isolated Station with **persistent agents** (close/reopen the UI and reattach to
the same running agent), one command does everything:

```bash
# preferred: one command from any checkout/worktree root (builds first if needed)
pnpm station:devbox               # start the isolated observer + Station
pnpm station:devbox dev           # same sandbox, with Bun hot reload for station/src/**
pnpm station:devbox restart       # rebuild + recycle the observer (agents survive)
pnpm station:devbox status        # which observer/host am I on? (+ global, read-only)
pnpm station:devbox logs --follow # tail the isolated observer/host/cli logs
pnpm station:devbox stop          # stop the observer + host (keeps .dev-state)
pnpm station:devbox reset --yes   # wipe this checkout's .dev-state
```

`station:devbox` is a thin root delegator over the nested Bun scripts below, which
remain the implementation and still work directly from the package dir:

```bash
cd station
bun run station:isolated          # isolated observer + persistence flag + Station
bun run station:isolated dev      # same sandbox, with Bun hot reload
bun run station:isolated:stop     # tear down the observer + host for this worktree
```

`station:isolated` does everything needed for a self-contained sandbox:
- generates a worktree-local config (`.dev-state/config.toml`: state relocated
  under `.dev-state`, socket relocated under a short checkout-keyed temp path,
  `terminal = "noop-terminal"`, persistence flag on, supported
  harness hook flags on);
- exports `STATION_HOST_ENTRY` (so the host can spawn) and
  `STATION_OBSERVER_SOCKET_PATH` (so Station connects to this observer);
- sets `CODEX_HOME=.dev-state/codex-home`, seeds it with a symlink to your real
  `~/.codex/auth.json` (shared login) and a copy of `config.toml` (isolated
  snapshot), and installs the codex status hooks **there** — so the launch guard
  (below) is satisfied and launched agents report to **this** observer, with your
  global `~/.codex` left untouched;
- installs the claude status hook for the isolated observer (its artifact + script
  land under `.dev-state/observer`, which is what the launch guard checks) so a
  claude-default worktree also clears the guard; sets
  `CLAUDE_CONFIG_DIR=.dev-state/claude-home` so that install never touches your
  global `~/.claude` and the launched claude reads an isolated config; auth is not
  seeded (see note below);
- sets `STATION_CURSOR_HOME=.dev-state/cursor-home`, seeds git identity/SSH
  links into that isolated Cursor home, and sets
  `OPENCODE_CONFIG_DIR=.dev-state/opencode-config`, then installs Cursor and
  OpenCode hooks there as well;
- starts the isolated observer and opens Station.

Use `pnpm station:devbox dev` for the same isolated stack with `bun --hot` UI
reload. It keeps the observer, state, hooks, and host under `.dev-state`, but UI
edits under `station/src/**` reload in place.

The observer + agents are left running when Station exits, so close/reopen
reattaches.

> Codex, Claude, Cursor, and OpenCode get isolated hooks/provider homes. For
> Claude the script installs the station status hook for the isolated observer —
> the artifact + script land under `.dev-state/observer`, which is what the
> launch guard checks, so a claude-default worktree clears the guard. It also
> exports `CLAUDE_CONFIG_DIR=.dev-state/claude-home` so that install never
> touches your global `~/.claude/settings.json` and the launched claude reads an
> isolated config (the observer inherits the env and the host→PTY spawn merges it
> down). Auth is **not** seeded: on macOS claude keeps credentials in the Keychain
> (machine-global, not under `CLAUDE_CONFIG_DIR`), so the sandbox stays logged in;
> on a file-credential platform expect a one-time `claude` login. Your global
> `~/.claude/settings.json` is never modified.

Test the persistence loop:
1. Open a worktree row → launches a fresh host-backed agent.
2. Quit Station (`q`) — the agent keeps running in the detached host.
3. Re-run `bun run station:isolated` → the **same** agent reattaches with its scrollback.

Inspect what the host owns / watch the timeline:

```bash
pnpm station:devbox status
tail -f .dev-state/observer/logs/station-host.jsonl
```

### Headless persistence (no UI, no observer)

To verify the persistence mechanism itself without the Station UI:

```bash
bun run e2e:persist     # start → close → reopen → kill, prints PASS/FAIL
bun run host:dev        # hold a host + demo agent on a wt-local socket
bun run host:list       # inspect it (defaults to this worktree's host)
```

These use their own worktree-local state under `station/.dev-state`
and touch nothing global.

---

## 2a. Private tmux popup devbox (+ live dashboard reload)

Use this lane when the surface under test is the real tmux popup rather than
the native Station workspace:

```bash
# prerequisites for this checkout
pnpm build
cd station && bun install && cd ..

# terminal A: start/reuse and remain the cleanup owner
pnpm station:devbox tmux dev

# terminal B: attach an ordinary client to the private base session
pnpm station:devbox tmux attach
# inside it: Ctrl-b Space opens/toggles the production Station popup
```

`tmux dev` prints the checkout identity, disposable root, exact tmux binary,
private label/socket/wrapper, `/dev/null` config, Station config/state/socket
paths, base and `_station-ui` sessions, discovered CLI/renderer/Observer/Host
owners, and the exact attach/log/stop commands. `tmux start` creates the same
HMR-enabled lane but returns immediately.

The disposable root is `/tmp/stn-dbx-<checkout-hash>` and contains:

- isolated `HOME`, XDG, runtime, temp, config, state, layout, log, spool, and
  diagnostics paths;
- empty Codex, Claude, Cursor, and OpenCode homes—no copied or linked auth,
  config, Git, or SSH material;
- a committed disposable Git project;
- one recorded wrapper that always executes the resolved tmux binary with the
  private `-L` label and `-f /dev/null`;
- a failing bare-`tmux` shim, so a child cannot silently reach default tmux.

The generated config uses `noop-worktree`, `tmux`, and `noop-harness`, disables
GitHub metadata and hook auto-start, and points at the isolated live Observer.
The popup binding invokes the built CLI's `popup` command. Its long-lived hidden
CLI owns renderer-control IPC; only the Bun dashboard child is overridden with
`bun --hot --no-clear-screen src/dashboardRenderer/main.tsx`.

During an edit reachable from the dashboard under `station/src/**`, the tmux
server, attached base client, `_station-ui` pane/CLI parent, Bun PID, IPC
channel, Observer, visible nested client, and optional Host remain stable.
React/OpenTUI renderer resources, the dashboard store, Station client/source,
and popup listeners are disposed and recreated inside that Bun process.

Changes outside that source-only boundary need a coherent restart:

```bash
pnpm station:devbox tmux stop
pnpm build
pnpm station:devbox tmux dev
```

Use a full stop/start for package output, CLI, Observer, provider, protocol,
tmux integration, Host, PTY, dependency, or Station-link changes. There is no
`tmux restart` command because those processes and the popup build signature
must move together.

Inspect or clean up without touching global Station/default tmux:

```bash
pnpm station:devbox tmux status
pnpm station:devbox tmux logs --follow
pnpm station:devbox tmux stop
pnpm station:devbox tmux reset --yes
```

`status` is private/read-only. `stop`, Ctrl-C, SIGHUP, and SIGTERM kill only the
recorded private server, then validate Observer/Host socket, pidfile, `lsof`,
process command, and start-time evidence before escalating. If ownership cannot
be proven gone, cleanup retains the root and wrapper as evidence instead of
using `pkill` or broad/default-server operations.

Manual HMR check:

1. Open the popup with `Ctrl-b Space` and record `tmux status`.
2. Add a harmless visible label in
   `station/src/dashboardRenderer/FullscreenDashboard.tsx`.
3. Confirm the open popup repaints and the reported server, base pane, hidden
   CLI, Bun renderer, Observer, nested client, and optional Host PIDs are stable.
4. Revert the label and confirm it disappears.
5. Press Esc, reopen with `Ctrl-b Space`, and confirm the hidden CLI/renderer
   and Observer are reused.
6. Detach and stop the lane; `status` should report stopped and the private root
   and sockets should be absent.

The opt-in automated version is `pnpm station:devbox:tmux:smoke`. It temporarily
edits that component in place, restores its exact bytes in `finally`, audits
every wrapper call, and verifies startup rollback plus SIGINT/SIGHUP/SIGTERM
cleanup.

---

## 2b. Dogfooding: Station against your real observer (+ live UI reload)

The isolated path above is for sandboxed testing. To use Station as your daily
driver against your **real** observer (the one tracking your actual agents),
point it at the global observer instead of an isolated one.

One-time setup:
1. Enable persistence in your real config (`~/.config/station/config.toml`):
   ```toml
   [feature_flags]
   station_persistent_agents = true
   ```
   Keep `terminal = "tmux"` — Station launches always go through the host-backed
   `native` provider regardless, so the default only affects tmux-launched agents.
2. Build the checkout your observer runs from, then restart it so it picks up the
   flag + persistence code:
   ```bash
   pnpm build && pnpm stn observer restart
   ```
   No `STATION_HOST_ENTRY` is needed: the observer resolves the Bun host
   entry from its own checkout (`resolveStationHostEntry` in
   `apps/cli/src/observerProviders.ts`); the env var only overrides it for a
   non-standard layout or a pinned host build.

Then run Station against the real observer (with `XDG_RUNTIME_DIR` unset it
defaults to the global socket; otherwise set `STATION_OBSERVER_SOCKET_PATH` to the
observer's configured `socket_path`):
```bash
cd station && bun run station
```

- New agents launched from Station are **host-backed and persistent** — quit and
  reopen Station and they reattach with scrollback.
- Agents already running in **tmux** coexist (Station shows them) but it cannot
  host someone else's tmux session, so opening those worktrees says "already
  running." Going exclusively Station means launching new agents from Station and
  letting the tmux ones age out.

### Hot-reloading Station UI while you develop

To see UI changes live, run the **`dev`** script (`bun --hot`) instead of
`station`, **from the worktree you're editing** — it hot-reloads your edits and
still connects to your real observer by default:
```bash
pnpm station:ui-dev
```
There is no "push it to main to see it" step. The Station UI is a Bun process
that talks to the observer over a socket, so a worktree's UI runs directly
against the same observer your global build started — edit a component / layout /
input file and it reloads in place. The split:

- **Station UI** (`station/src/**`) → hot-reloads from
  the worktree you run `bun run dev` in.
- **Observer / providers / persistent host / protocol+contracts** → run from the
  *built* checkout the observer was started from. Changes there need
  `pnpm build` + `stn observer restart`. (If you change the protocol/contracts,
  the worktree UI must also be on a compatible commit.) The host runs the
  observer's checkout too, so host changes need that rebuild — not just the UI reload.

---

## 3. Launching via the CLI (`stn tui`)

```bash
pnpm dev                                  # rebuild @station/cli on change, isolated by default
pnpm dev --config /abs/other-config.toml  # ...against a specific observer/config
node apps/cli/dist/main.js --config /abs/iso-config.toml tui   # one-shot, no watcher
```

`pnpm dev` rebuilds `@station/cli` on change and launches `stn tui`. With no
explicit config it generates `.dev-state/tui-dev/config.toml` from your real
config, relocates the observer `state_dir` under this checkout, uses a short
checkout-keyed temp socket path, and preconfigures isolated Codex, Claude,
Cursor, and OpenCode hooks for that observer. The CLI shells out to the Bun renderer in `station/`: a bare terminal
launches the **native Station workspace** (its own PTY panes); inside tmux it
opens the **read-only dashboard** in a tmux popup (tmux owns the panes there). It
passes explicit `--config` choices straight through, and `stn tui` auto-starts
the observer for the configured socket. The generated default config uses
`terminal = "noop-terminal"`, so it avoids machine-global tmux pane discovery.
If you pass an explicit config with `terminal = "tmux"` for tmux-integration
testing, the popup dashboard can still show your real tmux agents (see the tmux
gotcha in §1).

> `pnpm dev` rebuilds the **Node CLI**, not the Bun renderer. To hot-reload the
> Station UI itself as you edit `station/src/**`, use `pnpm station:ui-dev` from §2b.

---

## 4. Headless / CLI

Any observer-backed command takes `--config` and hits the isolated observer:

```bash
node apps/cli/dist/main.js --config /abs/iso-config.toml snapshot --json
node apps/cli/dist/main.js --config /abs/iso-config.toml observe --include-snapshot --duration 3s --json
node apps/cli/dist/main.js --config /abs/iso-config.toml reconcile
node apps/cli/dist/main.js --config /abs/iso-config.toml debug logs
```

---

## 5. Prerequisites & running your checkout's code

- **Node.js 24.2+ (and below 25) / pnpm 11.** First time: `pnpm install && pnpm build`. The observer
  and CLI **spawn from `dist/`**, so rebuild after changing observer/CLI/provider
  code (`pnpm build`, or `pnpm dev` which watches `@station/cli`).
- **Run this checkout's CLI** with `pnpm stn …` or `node apps/cli/dist/main.js …`
  from the worktree root — not a globally-installed `stn`, which may point
  elsewhere. (`pnpm station:link` mutates all three global launchers; avoid it for isolated dev.)
- **Station (Bun) workspace** is off the pnpm/Node build. After a root `pnpm build`:
  `cd station && bun install && bun run link:station && bun run repair:node-pty`.
  The `bun run station*`/`host*`/`e2e:persist` scripts do the link/repair for you.

### Test gates (run before claiming green)

```bash
pnpm typecheck && pnpm lint
pnpm test:unit && pnpm test:contracts && pnpm test:integration
# Station (Bun): bun test does NOT typecheck — run typecheck separately
cd station && bun run link:station && bun test && bun run typecheck
```

Observer integration tests spawn from `dist` (build first). The Station UI tests
run under `bun test` in `station/` — the OpenTUI test renderer drives golden-frame
snapshots (`*.golden.test.tsx.snap`); `bun test` does not typecheck, so run
`bun run typecheck` separately. See [development.md](development.md) for the full matrix.

---

## 6. Gotchas (read these before filing a bug)

- **"This worktree already has a running agent" on every row** → the tmux gotcha
  (§1). Use `terminal = "noop-terminal"` in the isolated config; `station:isolated`
  already does.
- **Station persistence silently doesn't persist** → the observer resolves the
  Bun host entry from its own checkout, so no env var is normally needed — but
  `bun` must be on the observer's PATH (or set `STATION_BUN`), or the host is
  reported "unavailable" and PTYs fall back to non-persistent with no error. Set
  `STATION_HOST_ENTRY` only to override the resolved path (non-standard
  layout / pinned host build).
- **"<harness> status hooks are not installed" on launch** → the launch path
  (`externalLaunch.ts` → `assertHooksInstalledOrThrow`) refuses to spawn an agent
  whose status hooks aren't installed *for this observer*, so it never spawns a
  half-wired agent. Supported provider hooks normally live in global provider
  homes (`~/.codex`, `~/.claude`, `~/.cursor`, or `~/.config/opencode`), so the
  isolated lanes redirect those homes before installing hooks. Codex uses
  `CODEX_HOME`; Claude uses `CLAUDE_CONFIG_DIR`; Cursor uses `STATION_CURSOR_HOME`;
  OpenCode uses `OPENCODE_CONFIG_DIR`. Codex auth is a symlink to your real
  `~/.codex/auth.json`; Cursor gets symlinks for git identity and SSH material
  so commits still work from its isolated `HOME`; Claude auth usually comes from the macOS Keychain.
  The generated hooks only fire for STATION-launched sessions (they early-exit
  unless `STATION_SESSION_ID` and `STATION_WORKTREE_ID` are set), so they never
  disturb your global agents.
  `pnpm dev` / `pnpm station:tui-dev` and `pnpm station:devbox` both do this
  preflight for Codex, Claude, Cursor, and OpenCode under their own `.dev-state`
  roots, and launched agents carry the same isolated provider-home env.
- **Station connects to the wrong observer** → it reads `STATION_OBSERVER_SOCKET_PATH`;
  point it at the isolated socket. `station:isolated` exports it and prints it.
- **`observer stop` hangs / `OBSERVER_STOP_FAILED`** → an observer mid-reconcile
  can outlast the stop poll window; SIGTERM triggers the same graceful path.
  `station:isolated:stop` does a best-effort graceful stop then SIGKILLs the
  process **scoped to this worktree's state dir** (never the global observer).
- **`--config` after the subcommand is ignored** → it is a global flag:
  `stn --config X observer start`, not `stn observer start --config X`. Reuse the
  same `--config` for `stop`/`status` or you target the wrong observer.
- **No `STATION_STATE_DIR` env var exists** → isolation is config-only
  (`[observer] state_dir` + `socket_path`).
```

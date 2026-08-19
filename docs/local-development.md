# Local Development

Use this guide to run the current checkout without disturbing Station state or
sessions owned by another checkout. For contributor setup see
[Development](development.md), for test gates see [Testing](../tests/README.md),
for runtime evidence see [Debugging](debugging.md), and for renderer and terminal
work see [TUI development](tui.md).

## Fast path

Open a second terminal, enter the worktree under test, and start its isolated
Station devbox with UI hot reload:

```sh
cd /path/to/the-worktree
test -d node_modules || pnpm install --frozen-lockfile
pnpm station:devbox dev
```

The command builds this checkout and gives it a private `.dev-state`, Observer,
Station Host, socket, provider homes, and hook configuration. Another checkout's
devbox and hosted sessions keep running. Quitting the UI also leaves this
checkout's runtime and hosted sessions available for the next start. Reopening
an exact build reuses its Observer; when the checkout build changes, the same
command cooperatively recycles only this checkout's Observer, refreshes and
validates its private provider hooks, and then opens the UI. The persistent Host
and its agents remain running through that Observer replacement.

Do not run `pnpm station:link`, `pnpm station:reset`, or a globally installed
`stn` while comparing worktrees. Those commands can select or mutate a different
checkout.

## Choose a lane

| Need | Command |
| --- | --- |
| Isolated Station | `pnpm station:devbox` |
| Isolated Station with UI HMR | `pnpm station:devbox dev` |
| Force a rebuild and isolated Observer recycle | `pnpm station:devbox restart` |
| Isolated real tmux popup | `pnpm station:devbox tmux dev` |
| Node CLI watcher with generated isolation | `pnpm dev` |
| Headless command against the devbox | `pnpm stn --config .dev-state/config.toml <command>` |
| UI HMR against the real Observer | `pnpm station:ui-dev` |

Prefer the isolated devbox. The real-Observer lane is deliberately non-isolated
and should be used only when the change must interact with actual Station state.

## Devbox lifecycle

```sh
pnpm station:devbox start
pnpm station:devbox dev
pnpm station:devbox restart
pnpm station:devbox status
pnpm station:devbox logs --follow
pnpm station:devbox stop
pnpm station:devbox reset -- --yes
```

- `start` builds, ensures the isolated Observer exactly matches the checkout,
  prepares private hooks, and opens the isolated Station workspace.
- `dev` performs the same exact-build preparation and adds Bun hot reload for
  changes under `station/src/**`.
- `restart` rebuilds and recycles the Observer while the persistent Host and its
  agents survive and reconnect. It remains useful when an exact build needs a
  deliberate recycle; ordinary build changes do not require it.
- Changes to Station Host code require `stop` followed by `start`; `restart`
  intentionally preserves the current Host.
- `status` inspects this checkout's Observer and Host and reports the separate
  global Observer read-only.
- `logs` reads this checkout's Observer, Host, and CLI logs.
- `stop` stops the checkout-local Observer and Host but preserves `.dev-state`.
- `reset -- --yes` stops the lane and deletes `.dev-state`, including its
  database, diagnostics, provider homes, hook artifacts, and reattachable state.

Use reset only when this checkout's runtime and sessions are disposable.

## Isolation and safety

The devbox generates `.dev-state/config.toml`, places Observer state under
`.dev-state`, and uses a short checkout-keyed socket directory. Its default
terminal is `noop-terminal`, so the isolated Observer does not enumerate agents
from the machine-global tmux server. Native Host-backed Station panes remain
available.

Codex, Claude, Cursor, and OpenCode receive checkout-local provider homes and
Station hook configuration. This protects global configuration and hook files,
but it is not complete credential isolation: a lane may reuse credentials from
the macOS Keychain or a deliberately linked authentication file.

The devbox refuses unsafe socket ownership or an inaccessible incumbent socket
rather than unlinking it. When it reports `OBSERVER_SOCKET_INACCESSIBLE`, keep
the existing process and state, follow the printed permission or `lsof` recovery
instructions, inspect `station:devbox status`, and retry the same start command.

Exact-build activation is scoped to the checkout-keyed socket in the generated
config. It uses the Observer's identity-pinned cooperative stop, never the
devbox `stop` teardown, and never signals, reaps, or unlinks an incumbent. A
failed replacement preserves `.dev-state`, the persistent Host, and hosted
agents. If the old Observer stopped before its successor failed, retry the same
`start` or `dev` command; do not reset the lane.

There is no `STATION_STATE_DIR` environment variable. Manual isolation uses
`[observer] state_dir` and `socket_path` in a config file. `--config` is a global
CLI option and must precede the subcommand:

```sh
pnpm stn --config .dev-state/config.toml snapshot --json
pnpm stn --config .dev-state/config.toml observe --duration 3s --json
```

## Private tmux popup

Use the private tmux lane for popup transport, geometry, lifecycle, or dashboard
HMR:

```sh
pnpm station:devbox tmux dev
# Ctrl-b Space opens or toggles Station
# Ctrl-b d detaches and cleans up the interactive lane
```

This lane uses a checkout-keyed tmux server, `/dev/null` tmux config, disposable
home and XDG directories, and an isolated live Observer. It never enumerates or
mutates the default tmux server.

Use split commands when automation or a persistent detached lane is needed:

```sh
pnpm station:devbox tmux start
pnpm station:devbox tmux attach
pnpm station:devbox tmux status
pnpm station:devbox tmux logs --follow
pnpm station:devbox tmux stop
pnpm station:devbox tmux reset --yes
```

Dashboard code under `station/src/**` hot-reloads in place. Package, CLI,
Observer, provider, protocol, tmux integration, Host, PTY, dependency, or link
changes require detaching or stopping the lane and running `tmux dev` again.
There is intentionally no tmux restart command because those owners must move
together.

`tmux reset --yes` removes only a verified private lane. If ownership cannot be
proved, cleanup retains its private root as evidence instead of using broad
process or default-server operations.

## Advanced lanes

`pnpm dev` watches the built Node CLI and opens `stn tui`. By default it creates
an isolated config under `.dev-state/tui-dev`; an explicit `--config` must name a
controlled development configuration. It does not hot-reload the Bun renderer.

`pnpm station:ui-dev` hot-reloads `station/src/**` against the selected real
Observer. It is native-UI only and can see or affect actual sessions. Observer,
provider, protocol, and Host changes still require rebuilding and deliberately
restarting the real runtime from the checkout that owns it.

Checkout popup code is not supported against the normal tmux server and real
Observer. Use the private tmux devbox for popup work.

## Troubleshooting

- **Every row already has an agent:** the selected Observer is seeing the
  machine-global tmux server. Use the generated devbox config or a private tmux
  lane.
- **Station connects to the wrong Observer:** check the printed socket and use
  the devbox's config for every headless command.
- **A launch reports missing status hooks:** use the devbox-generated provider
  home and hook configuration; `start` and `dev` repair and validate those
  private artifacts before opening the UI. Do not install test hooks into global
  homes.
- **`status` reports a Host build mismatch:** use `stop` followed by `start` to
  recycle the source Host after accounting for its sessions.
- **Cleanup or socket ownership is uncertain:** stop and follow
  [Debugging](debugging.md). Runtime inventory, guarded prune, socket evidence,
  and Host recovery are owned there.

The command grammar in `scripts/station-devbox.mjs` and
`scripts/station-tmux-devbox.mjs` is authoritative. Test selection and manual
TUI acceptance remain owned by [Testing](../tests/README.md) and
[TUI development](tui.md).

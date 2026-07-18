# TUI Development

Status: current contributor reference for the OpenTUI Station terminal UI in `station/` (`@station/workspace`), its boundaries, and its test expectations. Station v0.7 is a private preview.

Station is the terminal UI client. It renders observer snapshots and events, owns local interaction state, and dispatches typed observer commands. It does not derive runtime truth from providers. The classic Ink TUI (`apps/tui`) was retired; Station is now the sole terminal UI.

## Renderer And Entry Points

Station is built on OpenTUI (`@opentui/core` + `@opentui/react`) and `react`, running on its own Bun lane outside the root pnpm workspace (see `station/README.md`). There are two Bun entry points:

- `station/src/main.tsx` — the native Station workspace: real PTY-backed panes with host-backed persistence.
- `station/src/dashboardRenderer/main.tsx` — the standalone observer-backed dashboard (live
  observer data and commands, no panes).

Both entry points load `[tui].widgets` from the runtime config and render the same
configured-widget title chrome; widget settings update that shared config when a
config path is available.

Launch is driven by `apps/cli/src/commands/tui.ts`. A source checkout uses the Node CLI to launch the Bun renderer:

- Bare `stn` in a plain terminal launches the native workspace (Station owns its own panes).
- Inside tmux, `stn` opens the interactive observer-backed dashboard in a
  tmux popup without native Station panes. Selecting a native Station session
  shows that it runs in another terminal, dispatches no focus command, and
  keeps the popup open.
- `stn tui --dev-fake-dashboard` previews the dashboard with mock data (`STATION_SOURCE=mock`).

## Nested Workspaces

Station-owned PTYs carry a `STATION_PANE` marker bound to their current tmux
server and pane, or `1` when Station itself is outside tmux. From that context,
bare `stn` outside tmux and explicit `stn tui` refuse to open another native
workspace:

```text
Nested Station is disabled. (NESTED_TUI_DISABLED)
Hint: Press Ctrl-O to open Station, or use `stn tui --allow-nested` for testing.
```

`stn tui --allow-nested` permits only that launch. PTYs created by the nested
workspace are marked again, so another native workspace requires another
explicit override. There is no persistent config setting for nesting.

The policy targets only TUI entrypoints. CLI commands such as `snapshot`,
`doctor`, `debug`, `observer`, `command`, and `setup` remain available in
Station panes, as do help and version output. Bare `stn` inside tmux and
explicit `stn popup` keep their popup behavior. Tmux launchers mark their
`tui --popup` child, while a direct `stn tui --popup` still requires
`--allow-nested`. The mock dashboard remains available without an override.

The controlling-TTY single-instance guard is not sufficient here: each nested
pane has its own child PTY, so the outer workspace is not a same-TTY rival. The
tmux-context binding also prevents a server started from a Station shell or
Observer descendant from copying the marker into unrelated later panes, even
when different servers reuse the same pane id.

Persistent popups use a strict child-process IPC channel between the Node CLI and the Bun
dashboard renderer. The CLI composition root retains all terminal-provider authority; the
renderer sends only provider-neutral focus-origin and dismiss intents. When the CLI marks that
channel as required, a renderer that starts without it or loses it exits instead of continuing
without lifecycle control. Focus-success dismissal is scoped to the exact origin resolved for the
operation and the provider-owned popup claim/lease, preventing a stale renderer from dismissing a
replacement popup.

When the private tmux devbox runs the dashboard under Bun `--hot`, the CLI
parent and its IPC channel remain authoritative for the lifetime of
`_station-ui`. A source reload synchronously releases the prior OpenTUI stdin
owner, then unmounts the old React root, removes popup listeners, detaches the
old source/store, stops the old Station client, and recreates those renderer
resources inside the same Bun process. The renderer disposer deliberately does
not disconnect the CLI-owned IPC channel. Source build identity is verified
once per OS process so a harmless reload reuses the accepted identity; a new
process still verifies the current checkout and outputs.

You can also run the renderer directly during development:

```bash
cd station
bun run station                       # native workspace, live observer
STATION_SOURCE=mock bun run station   # native workspace, deterministic fixtures
bun run dashboard                     # interactive dashboard renderer without native panes
```

## Boundaries

- Keep the Station UI provider-neutral. Do not import provider packages, read SQLite, run `wt`, run `tmux`, run `git` or `gh`, or parse raw provider payloads.
- Keep terminal-provider mechanics behind CLI composition. The renderer-control contract carries
  typed product intents, results, and normalized focus origins, never provider commands, arguments,
  raw claims, or lease representations.
- Render normalized contracts from `@station/contracts` and use `@station/protocol` through the Station service/source layer.
- OpenTUI/React components should stay plain and readable. Runtime orchestration belongs in services or the Station state store, not presentation components.
- Selectors, screen transitions, command builders, event reducers, and fixtures should stay pure TypeScript. The render-framework-free dashboard logic lives in `@station/dashboard-core` and is consumed by the OpenTUI render layer.
- Station service code may use `@station/runtime` (and the shared `@station/client`) for observer IO, subscriptions, command dispatch, timeout, retry, cancellation, and cleanup boundaries. Prefer Effect in boundary code when a single path must coordinate async iterators, cancellation/interruption, cleanup, retry/reconnect, timeouts, and typed error conversion. Keep that Effect usage behind Promise/AsyncIterable facades for React callers.
- The UI may filter, group, sort, label, and decorate snapshot rows. It must not infer agent truth from provider-specific details.
- Treat `snapshot.sessions` as session-membership and session/activity-count truth. Dashboard rows,
  search, selection, and actions project those sessions and join `snapshot.rows` only for checkout
  metadata; bare worktrees remain inventory and do not appear in the primary session list.
- `terminal.focusable` describes external dashboard control, not native Station
  interaction. Native row activation resolves an advertised managed attachment
  and creates or reveals the local pane without dispatching `terminal.focus`;
  no attachment leaves the overlay open with an actionable notice.

## Surface Rules

- Treat the active UI as the full terminal canvas. Layout code should account for the terminal viewport, not a decorative parent container.
- Keep header, body, footer, overlays, prompts, and toasts from overlapping at narrow or short terminal sizes.
- The tmux popup runs the same interactive observer-backed dashboard without
  native Station panes. Its close behavior and footer copy must match popup
  semantics, such as `q/esc:close` when a warm dismissal is expected. `Ctrl-O`
  / header click toggles the STATION overlay; `Ctrl-Q` always exits Station.
  Persistent tmux sessions are signed by renderer command and build identity
  so an installed upgrade replaces, rather than reuses, a warm renderer pinned
  to an older Observer build.
- Do not add a row-level inspect/debug panel. Use CLI JSON, `stn doctor`, `stn snapshot --json`, and debug bundles for support evidence.
- Do not render `providerData` or raw provider debug payloads in ordinary UI surfaces.

## Mouse Coverage Boundaries

OpenTUI `mockMouse` tests cover renderer composition, semantic hit targets, hover styling, modal
interception, and equivalence with keyboard transitions. They do not prove terminal mouse-mode
negotiation, SGR parsing, PTY delivery, or tmux forwarding.

The fullscreen and tmux-popup dashboard routes primary-button clicks through its own thin adapter
into the same dashboard-core and keyboard transitions used by standalone keyboard input. Session
rows are resolved by their exact current row ID before their visible slot key is dispatched, so
observer-backed focus, start, resume, and picker behavior stays on the existing command path.
Pending rows remain inert; stale targets show bounded, deduplicated feedback. Project-header clicks
toggle collapse once on mouse-down, wheel events over child rows use dashboard scrolling, and active
modal surfaces intercept background clicks and scrolling.

Native and standalone rendering expose the same project actions. Quick-session
intent resolves the same project and default harness before terminal-specific
execution: native Station hosts the session in a Station pane, while the
standalone dashboard dispatches the configured terminal default. The
empty-project button uses that same quick-session intent, and the agent-picker
uses the shared project-default screen transition. Link cells use the same
validated platform opener. Shell actions delegate only their terminal effect:
native Station opens or focuses a Station pane, while a tmux popup sends a
strict renderer-control request to its CLI parent. The tmux adapter opens or
focuses one cwd-bound shell window in the exact invoking client session, then
dismisses that popup claim.

Real native mouse acceptance lives in
`tests/e2e/real/real-native-tui-mouse.test.ts`. It launches bare `stn` with `TMUX` and `TMUX_PANE`
removed while tmux remains only a fixed-size PTY/capture envelope. An attached client writes raw
SGR motion and down/up bytes, and the test proves project actions, hover, one collapse or expansion
per click, and a real Codex row launch reflected by the Observer. It never uses
`tmux send-keys` or OpenTUI `mockMouse` for mouse assertions.

The real tmux-popup boundary remains an acceptance-test responsibility, not dashboard routing
logic. `integrations/terminal/tmux/test/integration/popup-real.test.ts` sends outer-client SGR
motion, primary down/up, repeated clicks, and wheel input through a centered popup and verifies
hover, one action per complete click, deliberate repeated toggles, and
scrolling. It also clicks the project shell action twice, proving exact popup
dismissal and one reused cwd-bound window in the invoking client session.
Production tmux input forwarding remains unchanged unless that real
characterization fails before input reaches the renderer.

## Code Organization

The native workspace lives under `station/src/`; the shared, render-framework-free dashboard behavior lives in `@station/dashboard-core` (`packages/dashboard-core`).

- `station/src/sources/` and `station/src/state/` hold observer-source wiring, runtime state, and command dispatch (live mode dispatches through the single shared `@station/client` service).
- `station/src/input/` holds the router and keymap plumbing; runtime keyboard dispatch goes through the shared transition machine, with data-driven binding tables.
- `station/src/station/` holds the STATION overlay (the dashboard surface): `view/` is the OpenTUI render layer over `@station/dashboard-core`, `input/` is the overlay keymap and mouse routing, and `store/` is the overlay store.
- `station/src/terminal/` is the app-local PTY boundary (VT parser/screen model under `terminal/vt/`); `station/src/host/` is the PTY-host client for warm/cold reattach.
- In `@station/dashboard-core`: `selectors/` for snapshot-to-view grouping/filtering, `state/commandBuilders.ts` for typed observer command construction, `state/screens/*` for pure screen-owned key transitions, `state/observerBridge.ts` and `state/operations/*` for command/operation flow, and `components/`/`widgets/` for shared layout/content logic.
- Station may import only the linked `@station/*` packages (`client`, `config`, `contracts`, `dashboard-core`, `runtime`); it must never import `apps/tui` or `ink` (enforced by `station/src/station/importBoundaries.test.ts`).

## Testing

Station uses `bun test` (colocated `*.test.ts` / `*.test.tsx`), not vitest. `@station/dashboard-core` pure logic is unit-tested in `packages/dashboard-core/test`. For Station changes, choose the narrowest tests that prove the behavior, then add broader coverage only when the change crosses layers.

- Pure selectors, screen transitions, command builders, reducers, safe-error mapping, and state helpers belong in unit tests in `@station/dashboard-core`.
- Keymap and input behavior is anti-drift tested through the transition machine: `station/src/station/input/stationKeymap.test.ts` (machine-coverage, stale-binding, declared-vs-derived-outcome), sequence translation in `input/sequenceToTuiKey.test.ts`, and mouse guard/click-key equivalence in `input/stationMouse.test.ts`.
- Router/runtime conformance (reserved chords, modal swallow, paste, overlay-close) lives in `station/src/input/stationIntegration.test.ts`.
- Live command dispatch through the shared client (focus, jump-to-session, convergence, recovery) lives in `station/src/station/store/stationCommandDispatch.test.ts`.
- Rendering correctness uses golden frames: `station/src/station/view/dashboard.golden.test.tsx` (scenario × size matrix) and `view/modals.golden.test.tsx`. Use golden frames when exact terminal text, spacing, layout, footer placement, or clipping matters.
- Production popup acceptance lives in `integrations/terminal/tmux/test/integration/popup-real.test.ts`. Popup input and resize assertions must enter through an attached outer PTY, then prove the visible captured frame and converged nested-client/pane/renderer geometry; an internal store transition or command receipt is not sufficient evidence.
- Isolation is enforced by `station/src/station/importBoundaries.test.ts` (no `apps/tui`/`ink` imports, only linked `@station` packages, no local ported fork, no `focusable`).
- PTY/terminal behavior is tested under `station/src/terminal/` (VT conformance/stress) and via the smoke probes in the `test:pty` / `test:agents` scripts.

Useful focused commands:

```bash
cd station
bun test src/station/input/stationKeymap.test.ts
bun test src/station/view/dashboard.golden.test.tsx
bun test src/station/importBoundaries.test.ts
bun run test:vt          # terminal VT model
bun run test             # full Station suite (links @station packages first)

# dashboard-core pure logic (vitest), from the repo root:
pnpm exec vitest run packages/dashboard-core/test   # or: pnpm test:unit for the full unit suite
```

Before merging meaningful Station work, run at least the touched focused tests plus the deterministic gate required by the change. For cross-layer Station, observer, protocol, or command changes, prefer the full Station `bun run test` plus the repo `pnpm test:all`.

## Review Checklist

- Does the UI still consume snapshots/events and dispatch commands instead of reaching into providers?
- Are OpenTUI/React components free of observer IO, provider parsing, and runtime orchestration?
- Is shared dashboard logic kept in `@station/dashboard-core` rather than forked into the render layer?
- Are viewport-sensitive surfaces checked for clipping or overlap?
- Are popup/overlay labels and close behavior covered when changed?
- Did every touched component get source-adjacent coverage when behavior changed?
- Are unit tests proving pure selection/action/keymap logic separately from interaction tests?
- Is raw provider/debug evidence kept in CLI/debug-bundle paths rather than normal UI rendering?

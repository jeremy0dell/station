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

Station-owned PTYs carry `STATION_PANE=1` because Station, rather than any outer
tmux client, is their direct terminal boundary. From that context,
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
pane has its own child PTY, so the outer workspace is not a same-TTY rival. A
tmux server started from a Station shell supplies its own `TMUX` context, which
no longer matches the copied `STATION_PANE=1` marker in later panes.

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

## Child PTY Capability Environment

The outer terminal environment belongs to OpenTUI and remains unchanged so the
renderer can use the real host terminal. At the final Station-owned PTY spawn
boundary, inherited and per-launch environment values are merged, outer-renderer
identity and feature hints are removed, and Station applies `TERM=xterm-256color`,
`COLORTERM=truecolor`, and `TERM_PROGRAM=Station`. Per-launch values cannot replace
those fields or the derived `STATION_PANE` marker.

Ordinary locale, authentication, provider, project, worktree, and user environment
continues to pass through, including functional Git askpass and provider context.
Local PTYs preserve inherited `NO_COLOR` / `FORCE_COLOR` preferences. A
persistent Host may inherit those values from a headless provider hook rather
than a user terminal, so Host PTYs discard daemon-inherited copies and preserve
only values carried by the explicit launch request. Until Station can establish a
feature end to end for the current outer renderer, children must not infer it from
Ghostty, Kitty, WezTerm, iTerm2, Windows Terminal, Warp, or another outer renderer;
native Station currently advertises true color but neither an image protocol nor
OSC 8 hyperlinks. `TERM_PROGRAM=Station` preserves the renderer identity without
impersonating an outer emulator.

Outer-renderer variables are application conventions, not an exhaustive standard
registry. Station therefore maintains a curated set of known identity and capability
signals and couples changes to behavioral regressions such as the pinned
[Pi 0.80.10 detector](https://github.com/earendil-works/pi/blob/8dc78834cde4e329284cf505f9e3f99763df5529/packages/tui/src/terminal-image.ts#L65-L124).
Values that also carry authentication, provider, or user-preference behavior are not
blanket-scrubbed merely because a detector may inspect them.

`TMUX` and `TMUX_PANE` are removed because conventional capability probes treat
them as proof that tmux renders the child. Renderer-owned local PTYs retain a complete
outer pair as `STATION_OUTER_TMUX` and `STATION_OUTER_TMUX_PANE` for deliberate
commands such as
`TMUX="$STATION_OUTER_TMUX" TMUX_PANE="$STATION_OUTER_TMUX_PANE" tmux ...`.
Persistent Host PTYs expose neither value because a Host can outlive and reattach
through different renderers; its process environment is never current-renderer
provenance.
External tmux-provider sessions remain authoritative for their own environment and
do not pass through this native PTY policy.

The policy applies only when a local bridge, Bun, or Station Host PTY is created.
Existing live PTYs keep the environment captured at spawn and are never torn down to
adopt a capability-policy update.

The pinned Pi 0.80.10 detector fixture does not yet recognize Station or
`FORCE_HYPERLINK`; it intentionally remains `hyperlinks: false`. Inherited
hyperlink overrides are scrubbed and Station does not replace them. Capability
advertisement remains disabled until a coordinated Pi release and an
outer-terminal capability gate can land atomically; do not impersonate another
emulator or patch the fixture to claim behavior the published Pi executable does
not have.

## Native OSC 8 Hyperlinks

Native panes preserve hyperlink identity through the Station-owned terminal
pipeline: xterm resolves each active buffer cell's OSC 8 link to its URI,
link-aware VT spans preserve that URI across viewport and scrollback projection,
and OpenTUI attaches a native link ID to only the cells actually drawn inside
the pane. Adjacent same-style links remain distinct, and xterm owns overwrite,
erase, reset, reflow, scrollback eviction, and alternate-buffer lifetime.

Before handing a URI to OpenTUI, Station requires parseable absolute-URI syntax,
rejects invalid percent escapes, disallowed URI characters, terminal controls,
and malformed surrogate data, and enforces OpenTUI 0.4.1's 512-byte UTF-8 limit
without normalizing accepted values. A constant-time code-unit length gate bounds
all parsing and encoding work. Invalid links remain ordinary visible text.
OpenTUI emits OSC 8 only when its outer-terminal capability is enabled; the
outer terminal owns activation and URI policy. Station does not open or
shell-execute child-provided URIs, and terminal drag selection,
right-click, multi-click, wheel, and child mouse reporting remain unchanged.

Station Host records and replays raw PTY data events, so a complete replay feeds
the original OSC 8 open/close bytes back through xterm and restores link
metadata without a Host protocol change. A replay whose required bytes were
already truncated cannot reconstruct that state and remains owned by #216.

Manual validation in a hyperlink-capable outer terminal:

```sh
printf '\033[4m\033]8;;https://github.com/jeremy0dell/station/issues/196\033\\#196\033]8;;\033\\\033[24m\n'
```

The `#196` label should expose the exact issue URI. Repeat with adjacent links,
`file:` and `mailto:` targets, selection, scrollback, resize, and complete Host
reattach; pane borders and neighboring panes must remain unlinked.

## Boundaries

- Keep the Station UI provider-neutral. Do not import provider packages, read SQLite, run `wt`, run `tmux`, run `git` or `gh`, or parse raw provider payloads.
- Keep terminal-provider mechanics behind CLI composition. The renderer-control contract carries
  typed product intents, results, and normalized focus origins, never provider commands, arguments,
  raw claims, or lease representations.
- Render normalized contracts from `@station/contracts` and use `@station/protocol` through the Station service/source layer.
- OpenTUI/React components should stay plain and readable. Runtime orchestration belongs in services or the Station state store, not presentation components.
- Selectors, screen transitions, command builders, event reducers, and fixtures should stay pure TypeScript. The render-framework-free dashboard logic lives in `@station/dashboard-core` and is consumed by the OpenTUI render layer.
- New Session and Fork Session expose **Name** as the editable product concept. New Session initially names itself after its generated branch; Fork Session uses `<source>-fork` while its hidden branch carries a collision-resistant token that changes on each fresh open, so an unobserved Git-ref collision is recoverable by retrying. Later name edits may contain spaces and punctuation and never mutate that hidden branch identity. Quick Session uses its generated branch as the default name.
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
  to an older Observer build. Replacement kills through a compare-and-set on
  the signature just read, and a session whose signature is absent is treated
  as foreign and never killed; the popup refuses with a manual-resolution hint.
- Do not add a row-level inspect/debug panel. Use CLI JSON, `stn doctor`, `stn snapshot --json`, and debug bundles for support evidence.
- Do not render `providerData` or raw provider debug payloads in ordinary UI surfaces.

## Mouse Coverage Boundaries

OpenTUI `mockMouse` tests cover renderer composition, semantic hit targets, hover styling, modal
interception, and equivalence with keyboard transitions. They do not prove terminal mouse-mode
negotiation, SGR parsing, PTY delivery, or tmux forwarding.

The fullscreen and tmux-popup dashboard routes primary-button clicks through a thin adapter.
Workflow controls dispatch renderer-neutral semantic actions through `TuiStore.handleAction(...)`;
direct hotkeys and focused Enter decode to the same pure intents before transitions or effects run.
Dashboard-core owns action availability and resolution, while native Station and standalone/tmux
retain their terminal-specific effects after shared resolution. Session rows are resolved by their
exact current row ID before their visible slot key is dispatched, so
observer-backed focus, start, resume, and picker behavior stays on the existing command path.
Pending rows remain inert; stale targets show bounded, deduplicated feedback. Project-header clicks
toggle collapse once on mouse-down, wheel events over child rows use dashboard scrolling, and active
modal surfaces intercept background clicks and scrolling.

Bounded screens use one active-screen overlay layer. Dashboard-core exposes the narrow
`TuiScreenBehavior` contract, and the owning screen module supplies its safe `clickAway`
cancellation. Shared composition uses the presence of that capability for both the viewport
backdrop and background-hover suppression without knowing whether cancellation closes the screen,
backs up one step, or clears nested state. Active-screen controls retain hover, and individual
sheets continue swallowing inside input;
non-primary buttons, mouse-up, and wheel input remain consumed without dismissing or reaching the
dashboard. Remove, rename, and fork choose-row modes expose no click-away behavior so row clicks
and hover keep selecting; search and the dashboard likewise remain unchanged. In native Station,
the inner screen receives the click before the outer popup backdrop, so one click closes only the
topmost safe surface.

Native and standalone rendering expose the same project actions. Quick-session
intent resolves the same project and default harness before terminal-specific
execution: native Station hosts the session in a Station pane, while the
standalone dashboard dispatches the configured terminal default. The
empty-project button uses that same quick-session intent, and the agent-picker
uses the shared project-default screen transition. Link cells use the same
validated platform opener. The project-header shell control delegates only its
terminal effect: native Station opens or focuses a Station pane, while a tmux
popup sends a strict renderer-control request to its CLI parent. The tmux adapter
opens or focuses one cwd-bound shell window in the exact invoking client session,
then dismisses that popup claim. Its separate propagation-stopping cell prevents
it from also collapsing the project.

The zero-project dashboard renders **Add your first project** as a pointer
target that dispatches `dashboard.addProject`, producing the same Add Project
transition as `A` and focused `Enter`. Add Project controls dispatch stable
action IDs; core resolves those IDs to the same intents used by direct commands
and focused activation. Folder rows remain single-click selection targets. Choose
prefers a pasted absolute or home-relative path and otherwise commits the registered-list
cursor used by keyboard Enter; Open is enabled only for a navigable child or search row.
Review, id editing, success, and failure use a visible action focus cursor. Missing
Git-root review keeps submit disabled and stale disabled targets inert; these interaction
paths do not weaken project admission policy.

Create Session review renders Project, Name, Agent, and Create as full-width
interactive rows with visible `P`, `N`, `A`, and `C` commands. Arrow focus has a
non-color marker and contextual Enter helper; agent identity and its glyph plus
health text are separate spans. The name editor gives Name, Save, and Back
independent semantic controls, hides the text cursor while an action owns focus,
and reserves Left/Right for text-cursor movement while Name owns focus. Selecting
Name sets focus directly and never generates arrow input. Native pointer Create,
focused Enter, and direct `C` pass through one semantic Create resolver and shared
validation before producing the managed-pane effect; when validation disables Create,
all three activation paths remain inert. Standalone creation applies the same action
through its existing observer operation path.

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
scrolling. It also clicks the project-header shell action twice, proving exact
popup dismissal and one reused cwd-bound window in the invoking client session.
Production tmux input forwarding remains unchanged unless that real
characterization fails before input reaches the renderer.

## Code Organization

The native workspace lives under `station/src/`; the shared, render-framework-free dashboard behavior lives in `@station/dashboard-core` (`packages/dashboard-core`).

- `station/src/sources/` and `station/src/state/` hold observer-source wiring, runtime state, and command dispatch (live mode dispatches through the single shared `@station/client` service).
- `station/src/input/` holds the router and sequence plumbing; runtime keyboard
  dispatch goes through the shared transition machine, while only the dashboard
  keeps a binding table because its screen handler executes those actions directly.
- `station/src/station/` holds the STATION overlay (the dashboard surface): `view/` is the OpenTUI render layer over `@station/dashboard-core`, `input/` is the overlay keymap and mouse routing, and `store/` is the overlay store.
- `station/src/terminal/` is the app-local PTY boundary (VT parser/screen model under `terminal/vt/`); `station/src/host/` is the PTY-host client for warm/cold reattach.
- For managed Codex launches, the Station terminal provider selects a generic output-compatibility policy that both UI-owned fallback PTYs and Host-owned PTYs apply before replay storage and live delivery. It rewrites only the exact row-1 region scroll followed by its correlated cursor-and-erase repaint; both PTY boundaries remain provider-neutral, and manually starting Codex in an auxiliary shell remains outside this compatibility scope.
- Host retains complete transformed output and ordered resize transitions within a 256 KiB replay budget, plus a bounded Unicode-11 headless xterm model from the first byte. Attach returns exact ordered raw replay while complete; after eviction it prefers xterm's serializer plus a small Station-specific mode supplement. Capture retries between xterm parser boundaries. If exact reconstruction is unavailable at a safe boundary, Host returns no history and supplies RIS-prefixed control VT restoring the captured application-key, paste, mouse, focus, wrapping, buffer, and Kitty modes; Station applies it before nudging geometry for a child repaint. Live output and resize remain ordered behind the same barrier.
- Attachment-unavailable state is not process exit: version and exhausted-reconnect failures stop pane input and resize forwarding and show `attachment unavailable`, while only proven Host absence, an exited acknowledgement, or an exit frame reaches the pane-exit lifecycle. Lost historical replay fidelity keeps the pane attached and logs a typed degraded-snapshot diagnostic instead.
- In `@station/dashboard-core`: `selectors/` for snapshot-to-view grouping/filtering, `state/commandBuilders.ts` for typed observer command construction, `state/screens/*` for pure screen-owned key transitions, `state/observerBridge.ts` and `state/operations/*` for command/operation flow, and `components/`/`widgets/` for shared layout/content logic.
- Station may import only the linked `@station/*` packages (`client`, `config`, `contracts`, `dashboard-core`, `runtime`); it must never import `apps/tui` or `ink` (enforced by `station/src/station/importBoundaries.test.ts`).

## Testing

Station uses `bun test` (colocated `*.test.ts` / `*.test.tsx`), not vitest. `@station/dashboard-core` pure logic is unit-tested in `packages/dashboard-core/test`. For Station changes, choose the narrowest tests that prove the behavior, then add broader coverage only when the change crosses layers.

- Pure selectors, screen transitions, command builders, reducers, safe-error mapping, and state helpers belong in unit tests in `@station/dashboard-core`.
- Key and input behavior is tested at its behavioral owners: dashboard binding
  dispatch in `packages/dashboard-core/test/unit/state/keymap.test.ts`, screen
  transitions in dashboard-core, sequence translation in
  `input/sequenceToTuiKey.test.ts`, and mouse guard/click-key equivalence in
  `input/stationMouse.test.ts`.
- Router/runtime conformance (reserved chords, modal swallow, paste, overlay-close) lives in `station/src/input/stationIntegration.test.ts`.
- Live command dispatch through the shared client (focus, jump-to-session, convergence, recovery) lives in `station/src/station/store/stationCommandDispatch.test.ts`.
- Rendering correctness uses golden frames: `station/src/station/view/dashboard.golden.test.tsx` (scenario × size matrix) and `view/modals.golden.test.tsx`. Use golden frames when exact terminal text, spacing, layout, footer placement, or clipping matters.
- Production popup acceptance lives in `integrations/terminal/tmux/test/integration/popup-real.test.ts`. Popup input and resize assertions must enter through an attached outer PTY, then prove the visible captured frame and converged nested-client/pane/renderer geometry; an internal store transition or command receipt is not sufficient evidence.
- Isolation is enforced by `station/src/station/importBoundaries.test.ts` (no `apps/tui`/`ink` imports, only linked `@station` packages, no local ported fork, no `focusable`).
- PTY/terminal behavior is tested under `station/src/terminal/` (VT conformance/stress) and via the smoke probes in the `test:pty` / `test:agents` scripts.

Useful focused commands:

```bash
cd station
bun test src/station/input/stationMouse.test.ts
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

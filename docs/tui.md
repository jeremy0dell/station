# TUI Development

Status: current contributor reference for the OpenTUI interfaces in `station/`
(`@station/workspace`).

Station has two terminal renderer compositions: the native workspace, which owns
panes and PTYs, and the standalone dashboard used by fullscreen and tmux popup
launches. Both consume normalized Observer state through `@station/client` and
share the render-framework-free dashboard behavior in `@station/dashboard-core`.

This page owns durable TUI behavior and safety boundaries. Use
[Dashboard Architecture](dashboard-architecture.md) for dashboard state and
dependency ownership, [Configuration](configuration.md) for `[workspace]` and
`[tui]`, [Debugging](debugging.md#station-runtime) for runtime evidence, and
[Local development](local-development.md) for isolated development workflows.

## Renderers And Entry Points

| Entry | Surface |
| --- | --- |
| Bare `stn` outside tmux or explicit `stn tui` | Native workspace with Station-owned panes |
| Bare `stn` inside tmux or `stn popup` | Observer-backed dashboard in a tmux popup |
| `stn tui --dev-fake-dashboard` | Pane-free dashboard with deterministic mock data |

The native renderer starts at [`station/src/main.tsx`](../station/src/main.tsx).
The standalone renderer starts at
[`station/src/dashboardRenderer/main.tsx`](../station/src/dashboardRenderer/main.tsx).
Source runs from the repository root are:

```bash
bun run --cwd station station
STATION_SOURCE=mock bun run --cwd station station
bun run --cwd station dashboard
```

Both renderers load `[tui]` when they start. The native renderer also loads
`[workspace]`. An open renderer does not live-reload the post-create policy;
see [Configuration](configuration.md) for the complete field contract.

Command-capable native and popup launches require the caller's complete build
selector to equal the accepted Observer selector. A mismatch reports
`TUI_OBSERVER_BUILD_MISMATCH` before renderer, reconcile, popup, Host, PTY, or
layout effects begin. Mock mode is Observer-free and does not perform this
admission check. An Observer startup failure or renderer spawn failure exits
nonzero, and a signaled renderer exit is never reported as success.

Each native launch also starts one process-local, read-only update check with
no persistent cache. It never applies an update. Only a completed
version-changing result may print this notice after a normal, unsignaled,
zero-code renderer exit:

```text
Station <version> is available — run `stn update`
```

Popup and mock renderers do not perform this check.

## Authority And Safety Boundaries

### Observer and provider boundaries

- The TUI renders snapshots and events and submits typed commands. It must not
  import provider implementations, read Observer SQLite, run provider CLIs, or
  parse raw provider payloads.
- `@station/client` owns canonical in-process snapshot and connection state.
  Dashboard-local filters, collapse state, focus, screens, optimistic rows, and
  toasts are projections, not another source of runtime truth.
- `snapshot.sessions` is the session and activity authority. `snapshot.rows`
  supplies checkout metadata; a bare worktree is inventory and does not become a
  dashboard session. `snapshot.sessionGroups` exclusively owns Group membership.
- The UI may sort, group, filter, label, and decorate canonical data. It must not
  derive agent state from provider-specific details or use `debug.terminal` as
  action authority. Operator evidence stays in CLI and debug surfaces.
- Renderer compositions supply semantic capabilities for activation, session
  creation, worktree removal, shell opening, and dismissal. Dashboard-core does
  not infer native or tmux mechanics and does not create fallback capabilities.

The production import-boundary test enforces these dependency rules. Keep new
provider and filesystem behavior at an existing adapter or composition boundary
instead of teaching a component about it.

### Native TTY and Host ownership

Native Station admits at most one current renderer for an input TTY. Ownership
is an active private SQLite transaction paired with a cooperative Unix-socket
endpoint, not the presence of the claim file. A second renderer asks the current
owner to close and waits for release before entering raw mode. Station does not
signal the incumbent or delete the claim as a takeover mechanism; refusal and
timeout remain visible failures. Close the incumbent with `Ctrl-Q` and follow
[Debugging](debugging.md#station-runtime) before intervening manually.

Station Host may own PTYs beyond the lifetime of a renderer. A surviving Host
allows warm reattachment with retained output; a cold restore recreates shells
from the saved layout. Attachment availability and process liveness remain
separate: an unavailable attachment must not be reported as a process exit.

An advertised managed attachment is usable only when Station resolves exactly
one live Host PTY with the expected session and terminal lifetime. Missing,
duplicate, stale, or incompatible identity fails visibly and never falls back to
a new local PTY. Host output may have multiple viewers, but only the current
Host-issued controller may write or resize.

Exact Host convergence, recovery, socket evidence, and operator procedures are
owned by [Architecture](architecture.md) and
[Debugging](debugging.md#station-runtime); do not duplicate those algorithms
here.

### Nested workspaces

Station-owned child PTYs carry `STATION_PANE=1`. Bare `stn` outside tmux and
explicit `stn tui` refuse another native workspace from that context with
`NESTED_TUI_DISABLED`. `stn tui --allow-nested` authorizes only that invocation;
there is no persistent nesting setting.

The restriction applies to native TUI entry points, not ordinary commands such
as `stn snapshot`, `stn doctor`, or `stn debug`. Popup routing remains available
inside tmux. Each nested Station workspace marks its own children, so another
level requires another explicit override.

### Child terminal capabilities and privacy

OpenTUI receives the actual outer-terminal environment. Station-owned child
PTYs instead receive `TERM=xterm-256color`, `COLORTERM=truecolor`,
`TERM_PROGRAM=Station`, and the Station pane marker after inherited and
per-launch environment values are merged. Known outer-emulator identity and
capability hints, including `TMUX` and `TMUX_PANE`, are removed so a child cannot
mistake the outer renderer for its direct terminal.

Ordinary locale, authentication, provider, project, worktree, and user values
continue through the launch boundary. Renderer-owned local PTYs may expose a
complete outer tmux pair as `STATION_OUTER_TMUX` and
`STATION_OUTER_TMUX_PANE` for deliberate tmux commands. Persistent Host PTYs
expose neither pair because the Host can outlive or move between renderers.
Existing PTYs retain the environment captured when they were spawned.

Station advertises true color to children but not image or hyperlink support.
It can still render valid OSC 8 links emitted by a child when the outer terminal
supports them. Link URIs are validated and bounded before reaching OpenTUI;
Station never opens or shell-executes a child-provided URI. Complete Host replay
restores link metadata, while semantic recovery may preserve only the visible
text.

TUI and Host lifecycle diagnostics are content-free. They may retain typed
identity, lifecycle, attachment, and corruption classifications, but must not
record terminal output, prompts, key contents, environment variables, process
lists, arbitrary working directories, or repository paths.

## Interaction Contract

### Native workspace

These chords are reserved by Station even while a pane is focused:

| Input | Behavior |
| --- | --- |
| `Ctrl-Q` | Exit Station |
| `Ctrl-O` | Open or close the dashboard overlay |
| `Ctrl-\\` | Split the active pane right |
| `Ctrl-^` (`Ctrl-6`) | Split the active pane below |
| `Ctrl-]` | Focus the next pane |
| `Ctrl-/` (`Ctrl-_`) | Close the active split pane |

While the dashboard overlay or another modal surface is active, ordinary input
must not leak to the hidden terminal pane. On the welcome surface, `Enter` or
`Space` continues into the workspace or opens the project view. The Station
header/button remains a pointer route for opening or closing the overlay.

### Dashboard

The dashboard's stable top-level keyboard language is:

| Input | Behavior |
| --- | --- |
| Arrows / `Enter` | Move the semantic cursor and activate the focused control |
| `1-9`, `a-z` | Activate a visible session slot |
| `Tab` | Focus the next session needing attention |
| `/` | Edit the persistent dashboard filter |
| `N`, `A`, `G` | New Session, Add Project, Quick Group |
| `M`, `R`, `F`, `X` | Move to Group, Rename, Fork, Delete |
| `P`, `W`, `C`, `Z` | Project Settings, Widgets, Fold, Refresh |
| `H` or `?` | Help |
| `Q` | Quit or close the current dashboard surface |
| `Esc` | Back/cancel; on the dashboard, clear an applied filter before dismissal |

Shortcut letters are case-sensitive where shown. In particular, dashboard quit
is uppercase `Q`. Persistent tmux popup dismissal may keep its renderer warm;
`Ctrl-Q` remains the native workspace's unconditional process-exit chord.

Pointer targets and keyboard actions converge on the same stable semantic IDs.
A click on a dashboard cell is the same activation as focused `Enter`; stale,
hidden, filtered, disabled, or pending targets are inert. Wheel input belongs to
the active semantic scroll region, and modal surfaces intercept background
pointer input. Shortcut slots accelerate the first `1-9/a-z` choices but do not
limit list length; later items remain reachable through focus, scrolling,
`Enter`, and pointer activation.

Focus and selection must remain visible without relying only on color. Station
provides keyboard/pointer parity and non-color markers, but this is not a
screen-reader or accessibility-tree contract.

### Filters, Groups, and session mutations

`/` opens a single-line filter editor. The draft previews case-insensitive text
matches over visible Project, Group, session, agent, and activity labels without
changing canonical order or collapse state. `Tab` adds Status, Project, and
Agent conditions; `Enter` applies, `Esc` cancels editing, and `Ctrl-U` clears the
draft. With a filter applied, dashboard `Esc` clears it before performing the
normal dashboard dismissal. Filtering never changes Group membership or the
underlying snapshot.

Projects and Groups own semantic descendants; borders, padding, separators, and
gaps are not rows or action targets. Collapsing an ancestor moves hidden focus
to that ancestor. Snapshot replacement preserves a stable row/cell identity
when possible and otherwise uses deterministic neighboring fallback.

Mutation flows follow these durable rules:

- Revalidate the selected Project, Group, session, worktree, and branch identity
  against current canonical state before executing. Stale targets produce a
  notice or become inert; they must not retarget another row by position.
- New Session and Fork expose a user-editable Name separately from their hidden
  Git branch identity. Renaming display text never renames that branch.
- A retained Station session with no live agent and no recovery handle requires
  explicit **Start fresh / Cancel** confirmation. The safe initial choice is
  cancel.
- Delete and Group removal use explicit confirmations. Removing a Group leaves
  member sessions running and ungroups them; deleting a session proceeds only
  after Observer validation reserves the exact worktree against replacement
  launch.
- Once creation succeeds, later projection, focus, or dismissal uncertainty is
  reported without making the create operation retryable. Canonical surviving
  sessions and worktrees are not silently rolled back or duplicated.
- Post-create focus and dismissal use the renderer-resolved
  `[tui.session_create]` policy. Focus precedes dismissal when both are enabled;
  this UI policy is not part of the Observer command payload or durable result.

## Layout Ownership

Dashboard-core owns semantic tree structure, IDs, focus, collapse, filters,
screens, and actions. Station renderer adapters own physical terminal geometry:
measured boxes, clipping, scroll offsets, focus-follow, anchored placement, and
pointer hit resolution. Do not put terminal dimensions, coordinates, item
heights, or pre-sliced content into dashboard state.

Render complete semantic Project and Group branches. Their components own their
children and frames; renderer scroll regions map stable IDs to measured OpenTUI
boxes and report only visible IDs for slot and overflow projection. Sheets,
settings, Help, menus, and filter conditions follow the same rule: semantic
content stays mounted while one renderer-owned body scrolls inside a bounded
surface.

An expanded Group shares its top edge with the semantic header row and fills
otherwise-empty cells between the header labels and corner chrome. Its full
bottom edge remains a dedicated footer row. The frame uses the quiet hairline
color by default, bright working color for header focus, and dim working color
while a direct member has focus.

Use `@station/dashboard-core/text` for grapheme-safe terminal-cell measurement,
clipping, and truncation. JavaScript string length and indices are not terminal
geometry. Optional headers and indicators should be absent when empty rather
than reserving rows with blank renderables.

See [Dashboard Architecture](dashboard-architecture.md) for the ownership map
and package entry points. The import-boundary test inventories the few modules
allowed to translate semantic state into OpenTUI geometry.

## Verification Boundaries

Choose the narrowest lane described in [Testing](../tests/README.md). For TUI
work, distinguish what each layer proves:

- Dashboard-core tests prove pure selection, key/action, screen, and operation
  behavior without a renderer.
- OpenTUI mock-mouse and golden-frame tests prove component composition,
  semantic hit targets, keyboard/pointer equivalence, text, layout, and clipping.
  They do not prove terminal mouse-mode negotiation, SGR parsing, PTY delivery,
  or tmux forwarding.
- [`real-native-tui-mouse.test.ts`](../tests/e2e/real/real-native-tui-mouse.test.ts)
  sends raw SGR input through a real native renderer.
  [`popup-real.test.ts`](../integrations/terminal/tmux/test/integration/popup-real.test.ts)
  characterizes mouse and resize forwarding across the real tmux popup boundary.
  These opt-in lanes are environment-sensitive and are not substitutes for
  deterministic coverage.
- PTY, VT, Host attachment, and child-environment behavior require the Station
  terminal lanes; a dashboard store transition alone does not prove terminal
  behavior.

For documentation-only changes, run from the repository root:

```bash
bun run lint
bun run test:diagnostics:policy
```

When implementation changes, add the focused owner test first, then run the
broader deterministic gate required by [Development](development.md).

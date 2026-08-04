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

Launch is driven by `apps/cli/src/commands/tui.ts`. The launcher mints one
`uiRunId` per renderer child, records exact spawn/exit code/signal evidence in
`logs/cli.jsonl`, and passes that identity to the renderer.
A null child exit code is never interpreted as success. A source checkout uses
the Node CLI to launch the Bun renderer:

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
old source/dashboard runtime, stops the old Station client, and recreates those
renderer resources inside the same Bun process. The renderer disposer
deliberately does not disconnect the CLI-owned IPC channel. Source build identity is verified
once per OS process so a harmless reload reuses the accepted identity; a new
process still verifies the current checkout and outputs.

## Adaptive Embedded Appearance

Appearance `auto` has two renderer-owned meanings and no user setting in this
slice:

- The native workspace always resolves the complete built-in Station theme.
  Station does not request or consume the outer terminal palette for native
  appearance selection. OpenTUI may independently synchronize palette state
  during renderer setup when required by detected capabilities.
- The embedded standalone/tmux dashboard asks OpenTUI for the outer terminal's
  default foreground, default background, and ANSI indices 0-15. OpenTUI owns
  terminal and tmux OSC transport; Station never branches on terminal identity
  or tmux.

Station strictly parses the raw OpenTUI response. Both defaults and all 16 ANSI
entries must be non-null six-digit RGB values, every other known response field
must be RGB or null, and missing, extra, partial, or malformed data is rejected.
Station does not use OpenTUI's fallback-normalized palette because normalization
would make incomplete host evidence look complete. Missing evidence, a palette
failure, or a default foreground/background pair below ordinary-text contrast
selects the complete built-in theme atomically; host surfaces are never mixed
with unrelated Station foreground roles.

A valid embedded palette resolves one complete provider-neutral semantic theme.
Terminal-default and indexed intent retain their observed snapshots. Weak ANSI
roles are deterministically repaired in OKLab by shifting lightness toward the
observed foreground while holding hue and chroma, so they remain readable on
both the canvas and adaptive interaction fills without washing out; surface and
muted/border/interaction roles mix in OKLCH from foreground/background blends
and keep a minimum separation from the canvas so layered surfaces stay
distinguishable. The observed luminance and contrast determine dark/light
behavior; OpenTUI's theme mode label does not.

OpenTUI emits palette responses before `getPalette()` resolves and treats theme
mode changes as cache invalidation followed by a palette refresh. Station treats
`PALETTE` as color authority and `THEME_MODE` only as invalidation. Its controller
serializes and coalesces refreshes, rejects superseded generations, and clears
the OpenTUI cache again after an invalidated in-flight query settles because that
query can repopulate a cache already cleared by the event.

The standalone renderer owns the controller beside its OpenTUI renderer. The
controller starts from the complete built-in fallback, and palette I/O does not
delay root rendering; normal exit, errors, and Bun HMR unmount the React root and
dispose palette listeners before destroying OpenTUI.

Native composition applies the resolved theme's `StationTerminalTheme`
projection to the PTY registry before restored panes can create lazy screens.
The registry is only the lifecycle fan-out point: it remembers the latest
projection for future screens and updates existing screens without becoming an
appearance authority or changing a PTY's process, environment, geometry,
identity, or replay state. A compatible HMR composition retains its live PTYs
and reapplies the current projection.

`StationVtScreen` owns terminal-semantic color state. Updating its projection
rebuilds the ANSI palette used when rows are projected, so default and ANSI
indices 0-15 can repaint while the xterm buffer retains their original color
intent. The fixed ANSI-256 tail at indices 16-255 and explicit RGB/truecolor
cells remain stable. OSC 10/11 queries use the current default foreground and
background; changing the projection itself never feeds or replays bytes and
never sends an unsolicited reply to the child.

`TerminalPane` and the active theme provider own UI paint presentation: the
render-ready default foreground and `theme.pane.selection` flow directly to the
custom terminal renderable. The native canvas continues to supply blank/default
background cells through `theme.surfaces.canvas`, and the cursor remains inverse
cell composition over the resolved cell/default colors. Native `auto` remains
the exact opaque built-in Station appearance; user selection and native outer-
palette observation remain deferred to #421.

You can also run the renderer directly during development:

```bash
cd station
bun run station                       # native workspace, live observer
STATION_SOURCE=mock bun run station   # native workspace, deterministic fixtures
bun run dashboard                     # interactive dashboard renderer without native panes
```

## Native UI Lifecycle Evidence

The native renderer is an independent semantic witness in `logs/tui.jsonl`. It
records startup/ready, typed welcome, workspace, Station-overlay, and context-menu
transitions, shutdown intent (`ctrl_q` or cooperative TTY takeover), fatal
errors normalized to the fixed content-free `TUI_FATAL` shape, and normal
shutdown completion. Normal shutdown flushes this evidence before process exit;
abrupt loss and exact process signals remain covered by the launcher. Ctrl-O is
a surface transition inside one `uiRunId`, not a renderer restart. Direct
development mints a valid run ID and preserves it across Bun HMR.

This telemetry is local and content-free: it must not collect terminal output,
prompts, key contents, foreground application names, environment variables,
process lists, arbitrary cwd, or repository paths. Inspect it with bounded raw-event
queries or the JSONL files:

```bash
stn debug logs "renderer." --component cli
stn debug logs "ui." --component tui
```

## Native TTY Ownership

Before native Station starts its client, reads configuration, or creates an
OpenTUI renderer, it identifies interactive stdin from the character device's
typed `fstat(0)` metadata. The complete platform, device, terminal-device, and
inode identity selects a private per-user rendezvous under
`/tmp/station-tui-<uid>/`, independent of checkout and Station configuration.
Piped stdin does not enter this ownership path.

Ownership is an active `BEGIN IMMEDIATE` transaction in the identity's SQLite
database, not the presence of that database file. A second current Station asks
the transaction holder to shut down through the adjacent private Unix socket,
then waits up to two seconds to acquire the released transaction. The incumbent
disposes subscriptions and PTYs, unmounts React, destroys OpenTUI to release raw
stdin, closes its control endpoint, and releases the transaction last. The
successor cannot enter raw mode until that acquisition succeeds. Station never
signals another process during this flow and never escalates a failed takeover.

Bun HMR retains the transaction and control endpoint in process-global state
while replacing the takeover handler with the newest Station composition. An
already-running pre-protocol Station does not hold the transaction, so startup
conservatively refuses when same-TTY process evidence could indicate a legacy
owner; close that UI with `Ctrl-Q` before retrying.

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
- OpenTUI/React components should stay plain and readable. Runtime orchestration belongs in services or the dashboard runtime, not presentation components.
- Selectors, screen transitions, command builders, event reducers, and fixtures should stay pure TypeScript. The render-framework-free dashboard logic lives in `@station/dashboard-core` and is consumed by the OpenTUI render layer.
- Dashboard key/behavior is shared, not feature-gated: reducers and render/input leaves never select filter behavior or inspect feature flags; session and optimistic-row matching remains centralized in the pure persistent-filter projection.
- Each renderer composition owns one `DashboardRuntime`: `state` exposes only Zustand-compatible `getState`, `getInitialState`, and `subscribe`; `actions` is the sole external dashboard mutation authority; `start` is one-shot/idempotent and `dispose` is repeat-safe. The private Zustand store and reducers use mutable `DashboardState`; neither that model nor `setState` crosses the dashboard-core boundary.
- `DashboardStateSource` returns `DashboardStateView`, a recursively readonly type projection that includes snapshots, screens, local rows, widgets, arrays, maps, and sets. The projection preserves the store's exact object and notification identities: it performs no runtime copying, freezing, or proxying. Dashboard readers and Station consumers must accept the exported readonly view types rather than importing private mutable state models.
- Presentation receives the readonly `DashboardStateSource` unless a rendered effect requires specific `DashboardActions`. Input and effect adapters receive state plus actions, while native and standalone composition roots alone own full runtime lifecycle. Config persistence receives only the state subscription and `pushToast` capability it needs.
- Native and standalone input adapters dispatch the closed dashboard action contract rather than importing reducers or replacing runtime state. Hosted workspace creation temporarily crosses into dashboard state through the named `addPendingCreateSession`, `failPendingCreateSession`, and `removePendingCreateSession` actions; Station still owns failure-retention timers and expiry scheduling until that lifecycle moves behind the runtime facade.
- New Session and Fork Session expose **Name** as the editable product concept. New Session initially names itself after its generated branch; Fork Session uses `<source>-fork` while its hidden branch carries a collision-resistant token that changes on each fresh open, so an unobserved Git-ref collision is recoverable by retrying. Later name edits may contain spaces and punctuation and never mutate that hidden branch identity. Quick Session uses its generated branch as the default name.
- Station service code may use `@station/runtime` (and the shared `@station/client`) for observer IO, subscriptions, command dispatch, timeout, retry, cancellation, and cleanup boundaries. Prefer Effect in boundary code when a single path must coordinate async iterators, cancellation/interruption, cleanup, retry/reconnect, timeouts, and typed error conversion. Keep that Effect usage behind Promise/AsyncIterable facades for React callers.
- The UI may filter, group, sort, label, and decorate snapshot rows. It must not infer agent truth from provider-specific details.
- Treat `snapshot.sessions` as session-membership and session/activity-count truth. Dashboard rows,
  filtering, selection, and actions project those sessions and join `snapshot.rows` only for checkout
  metadata; bare worktrees remain inventory and do not appear in the primary session list.
- `terminal.focusable` describes external dashboard control, not native Station
  interaction. Native row activation resolves an advertised managed attachment
  and creates or reveals the local pane without dispatching `terminal.focus`;
  no attachment leaves the overlay open with an actionable notice.

## Surface Rules

- Treat the active UI as the full terminal canvas. Layout code should account for the terminal viewport, not a decorative parent container.
- Native Station owns its opaque Station canvas. The standalone dashboard uses opaque terminal-default background intent for its unaccented canvas, panels, prompts, Help surface, and toasts; this behavior is provider-neutral and does not use transparency.
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

## Persistent Dashboard Filter Preview

`/` opens a single-line editor in the complete table-header row. Its draft starts
from the dashboard-local applied free text and structured conditions. Editing performs a
deterministic, locale-neutral case-insensitive soft preview over the complete session and
optimistic-row universe plus project labels. Folded match offsets map back to source text before
highlighting. Every rendered row keeps its current order, slot, collapse visibility, and viewport
position; visible text matches receive bounded highlight spans, while nonmatching rows and project
headers are dimmed. Matches inside collapsed projects contribute to the global count and header
state without revealing the children during editing. The header includes the live row count and any
above-viewport context. A valid zero-result draft stays editable and uses an amber `0/N matches`
cue rather than an error state. Long drafts follow the caret horizontally and never wrap into the
body.

`Tab` opens the `FILTER CONDITIONS` builder beneath the filter row without reflowing dashboard
rows. Its disclosure rows use the standard shortcut accent for `S`, `P`, and `A`, show each field's
staged values (or `Any`), and use chevrons rather than checklist marks because activation opens a
value submenu. Multiple values read as the first value plus a count (for example, `Idle +1`) or just
the count when space is constrained. `S`, `P`, and `A` choose Status, Project, and Agent; arrows move
across those fields and the final Apply action. Visible `1-9/a-z` slots or `Space` toggle values and
immediately update the soft preview.

A value submenu places `[←]` and `[×]` in its header and `Done (Enter)` at the bottom. `Left`, `[←]`,
`Enter`, or Done retains the field's current selection and returns to the builder, so Status,
Project, and Agent can be assembled before one final apply. Reopening a field restores its staged
values; retaining no values removes that field. The builder places `[×]` in its header and
`Apply filter (F)` at the bottom. `F`, or `Enter` while Apply is focused, applies free text and all
staged fields together. `F` is intentionally inactive inside value lists because letters are stable
value slots there.

Value slots remain stable while a submenu is open, and long lists window around the cursor. `Esc`,
`[×]`, or a safe click-away closes the complete condition builder and returns to text editing. From
an active value submenu, closing discards only that field's unretained toggles; fields already
returned to the builder stay staged. A second `Esc` from text editing cancels the complete draft and
restores the prior applied filter. The panel blocks background activation and wheel input, dims only
the dashboard body, and keeps its distinct `CONDITION` control footer undimmed. Cursor and checkbox
markers ensure mode and selection do not rely on color.

`Enter` from text editing applies any draft containing free text or conditions to optional
dashboard-local state; applying a completely blank draft removes that state. `Ctrl-U` clears both
parts of the draft. An applied filter is a hard projection: nonmatching sessions, optimistic rows,
projects, and orphaned project gaps are omitted without changing canonical order. A project-label
text match or a Project condition retains all of that project's children unless another row
condition narrows them, while Status and Agent matches retain only matching rows and their project
context. Matching children of a collapsed project remain hidden until its disclosure is expanded.
Project collapse stays interactive while the filter is applied, so the marker and visible children
always agree; clearing the filter leaves the user's latest collapse choices intact.

Free text is intentionally limited to text visible in project headers and session rows: project
label, displayed title, agent, and activity. Hidden branch values, provider identifiers, raw status
values, and generated diagnostic reasons are not searched because they cannot provide a stable,
user-verifiable result. Structured matching is `free text AND Status AND Project AND Agent`, with
OR across selected values inside one field. Status uses normalized `AgentState`; Project and Agent
match stable IDs while rendering labels. Optimistic rows participate when they carry project,
agent, or starting-state evidence.

Editing `Esc` discards the draft and reconciles back to the prior applied projection. On the
dashboard, `Esc` clears an applied filter before the existing popup-dismiss path; `Q` closes or
dismisses while retaining dashboard-local state. The bounded summary/count replaces the column row,
and `/ edit` plus `Esc clear` are keyboard and pointer controls in the neutral dashboard footer.
Narrow applied-filter footers shed secondary shortcuts before edit, clear, and close. While editing,
the footer is a visually explicit bounded `FILTER` helper; the nested panel uses `CONDITION`.
Draft and applied summaries use one syntax-colored order—free text, Status, Project, Agent—and the
applied summary truncates as one line. Persistent filtering never uses the absolute
`CommandPromptView` overlay. Sheets, Help, snapshot replacement, and warm popup reopen preserve the
applied filter; covered footer targets remain inert outside dashboard mode.

| Verification | Behavior |
| --- | --- |
| `/` at wide and minimum width | Header editor; live highlights/dimming/global count; no wrapping |
| Editing `Esc` | Restores the prior hard applied projection |
| `Enter`, then dashboard `Esc` | Hard-projects matches, then restores the unfiltered/collapsed view without closing |
| Zero matches | Amber, recoverable soft preview; applying yields an empty dashboard projection |
| Hidden metadata only | Ignores metadata that is not rendered in the dashboard |
| Condition entry | `Tab`, `S/P/A`, slots/arrows/Space, header back/close, bottom Done, and final `F` Apply share core transitions |
| Applied footer pointer | `/ edit` and `Esc clear` share the keyboard transitions |
| `Q` from applied dashboard | Same close/dismiss behavior while retaining free text and conditions |

## Mouse Coverage Boundaries

OpenTUI `mockMouse` tests cover renderer composition, semantic hit targets, hover styling, modal
interception, and equivalence with keyboard transitions. They do not prove terminal mouse-mode
negotiation, SGR parsing, PTY delivery, or tmux forwarding.

The fullscreen and tmux-popup dashboard routes primary-button clicks through a thin adapter.
Workflow controls dispatch renderer-neutral actions through `DashboardActions.dispatch(...)`; direct hotkeys
and focused Enter decode to the same pure intents before transitions or effects run. Dashboard-core
owns action availability and resolution, while native Station and standalone/tmux
retain their terminal-specific effects after shared resolution. Session rows are resolved by their
exact current row ID before their visible slot key is dispatched, so
observer-backed focus, start, resume, and picker behavior stays on the existing command path.
Pending rows remain inert; stale targets show bounded, deduplicated feedback. Project-header
segments dispatch one `dashboard.projectHeader.activate` action, so a click first focuses the exact
segment and then follows the same activation path as focused Enter. Wheel events over child rows use
dashboard scrolling, and active modal surfaces intercept background clicks and scrolling.

Dashboard focus follows rendered order through each project header, its visible session rows, or the
stable Add Session action rendered when that project is empty. Entering a header vertically always
selects `primary`; Left/Right then moves, without wrapping, through `primary` → `shell` →
`quickSession` → `defaultAgent`. Up/Down leaves any header segment immediately, and Left/Right on a
session row or empty-project action is inert. Remove, rename, and fork row choosers retain a separate
session-only traversal, as do slot keys and next-needs-me. `N` continues to open the session flow
without changing dashboard focus. Gaps and optimistic create rows remain non-focusable.

Focused compact controls use the canonical theme's stronger bounded
`interaction.compactFocus` fill. A project header's primary segment covers the rendered
disclosure/name/summary text without painting flexible trailing whitespace, while each trailing
control owns exactly its label cells and separator spaces remain inert. An empty project's fill and
pointer target cover only `[ + add session ]`; its explanatory text and surrounding whitespace
remain inert and unpainted. Wide and compact labels preserve the same control identity. Hover stays
component-local, temporarily supersedes the focus background, and reveals persistent keyboard focus
again when the pointer leaves; no focus glyph is added.

Collapse moves focus from a hidden session or empty-project action to that project's header
`primary` and clamps scrolling; expanding and moving Down reaches the first visible child again.
Snapshot replacement and accepted filter changes preserve stable focus identity, otherwise choose
the next focusable item at the old position before the preceding item; resize preserves identity
and scrolls it into view. The Default Agent picker retains its header focus beneath the screen, so
Escape, click-away, unchanged selection, and a successful change return to `defaultAgent`; project
removal while open uses the same deterministic focus fallback. The dashboard footer describes Enter
as `activate` because it may activate a session row, project-header control, or empty-project action.

Bounded screens use one active-screen overlay layer. Dashboard-core exposes the narrow
`TuiScreenBehavior` contract, and the owning screen module supplies its safe `clickAway`
cancellation. Shared composition uses the presence of that capability for both the viewport
backdrop and background-hover suppression without knowing whether cancellation closes the screen,
backs up one step, or clears nested state. Active-screen controls retain hover, and individual
sheets continue swallowing inside input;
non-primary buttons, mouse-up, and wheel input remain consumed without dismissing or reaching the
dashboard. Remove, rename, and fork choose-row modes expose no click-away behavior so row clicks
and hover keep selecting; the filter and the dashboard likewise remain unchanged. In native Station,
the inner screen receives the click before the outer popup backdrop, so one click closes only the
topmost safe surface.

Native and standalone rendering expose the same project actions. Header Quick Session and the
empty-project button emit the same core quick-session intent, then resolve availability at their
terminal-specific acceptance boundary: native Station hosts the session in a Station pane, while the
standalone dashboard dispatches the configured terminal default. Pointer clicks use
`dashboard.emptyProject.activate`; focused Enter routes through the same core activation helper.
Blocked activation keeps Add Session focused while showing the existing error; stale targets are
inert. Successful activation transfers focus to that project's header `quickSession` segment before
an optimistic create row replaces the empty row. The agent-picker uses the shared
project-default screen transition. Link cells use the same
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
Review, id editing, success, and failure use a visible action focus cursor. Their actions
render through shared compact sheet buttons instead of stretching each control across the sheet.
Ordinary sheet commands must use `SheetButtonRow`: fitting controls keep their natural width and
leave trailing cells inert, while compact equal-width controls are reserved for constrained-width
overflow. The low-level fixed-width button remains private to shared sheet compositions such as
confirm controls; full-width interaction styling belongs to selectable list rows, not commands.
Rename Session exposes its primary command through the same semantic button path as keyboard Enter,
so pointer submit and keyboard submit produce one dashboard-core rename operation.
Horizontal review and failure groups move with Left/Right; the id editor keeps Save and Back
vertically stacked so Up/Down does not conflict with text-cursor movement. Missing Git-root review
keeps submit disabled and stale disabled targets inert; these interaction paths do not weaken
project admission policy.

Remove Session confirmation renders explicit Delete and Keep Session actions instead of generic
Yes/No controls. Keep is the safe initial focus; Left/Right moves without wrapping, focused Enter
activates the current choice, and Y/N retain their direct meanings. Both controls dispatch stable
semantic actions, use the shared bounded button treatment, and keep trailing sheet cells inert.

Fork Session renders Name and Copy through the same bounded field-control grammar as Create Session.
Clicking Name focuses its editor, clicking Copy focuses and toggles it once, and the Fork button
submits through a shared semantic action. Copy-focused Enter toggles rather than submitting; Enter
on Name or Fork submits. Native Station intercepts only submit to host the fork in a managed pane,
while standalone/tmux keeps the shared observer operation path.

Create Session review renders Project, Name, and Agent as compact field controls, followed by a
compact Create button. Labels, bold yellow accelerators (`P`, `N`, `A`, and `C`), values, and inline
health status use separate spans so their roles and associations remain visible. Arrow focus uses
a non-color marker and contextual Enter helper without painting the full row as selected. The name
editor gives Name, Save, and Back independent semantic controls and hides the text cursor while an
action owns focus. Down moves from the Name field into the button row, Left/Right moves between Save
and Back, and Up returns to Name; Left/Right remains text-cursor movement while Name owns focus.
Selecting Name sets focus directly and never generates arrow input. Native pointer Create, focused Enter, and
direct `C` pass through one semantic Create resolver and shared validation before producing the
managed-pane effect; when validation disables Create, all three activation paths remain inert.
Standalone creation applies the same action through its existing observer operation path.

All bottom-sheet text uses the shared non-selectable sheet text primitive. Dragging inside any sheet
therefore remains pointer interaction and never starts OpenTUI terminal text selection.

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
- `station/src/station/` holds the STATION overlay (the dashboard surface): `view/` is the OpenTUI render layer over `@station/dashboard-core`, `input/` is the overlay keymap and mouse routing, and `store/dashboardRuntime.ts` is the native dashboard-runtime composition.
- `station/src/terminal/` is the app-local PTY boundary (VT parser/screen model under `terminal/vt/`); `station/src/host/` is the PTY-host client for warm/cold reattach. `terminal/protocol/` owns the typed VT syntax categories, complete command identifiers and sequence constants, domain values, and pure protocol reducers consumed by both paths. Production composes explicit byte templates from that vocabulary rather than embedding ESC/BEL literals or mode numbers; raw sequences remain valid in protocol byte tables, tests, conformance cases, and parser-local regex syntax.
- For managed Codex launches, the Station terminal provider selects a generic output-compatibility policy that both UI-owned fallback PTYs and Host-owned PTYs apply before replay storage and live delivery. It rewrites only the exact row-1 region scroll followed by its correlated cursor-and-erase repaint; both PTY boundaries remain provider-neutral, and manually starting Codex in an auxiliary shell remains outside this compatibility scope.
- Host retains complete transformed output and ordered resize transitions within a 256 KiB replay budget, plus a bounded Unicode-11 headless xterm model from the first byte. Attach returns exact ordered raw replay while complete; after eviction it prefers xterm's serializer plus a small Station-specific mode supplement. Capture retries between xterm parser boundaries. If exact reconstruction is unavailable at a safe boundary, Host returns no history and supplies RIS-prefixed control VT restoring the captured application-key, paste, mouse, focus, wrapping, buffer, and Kitty modes; Station applies it before nudging geometry for a child repaint. Live output and resize remain ordered behind the same barrier.
- Attachment-unavailable state is not process exit: version and exhausted-reconnect failures stop pane input and resize forwarding and show `attachment unavailable`, while only proven Host absence, an exited acknowledgement, or an exit frame reaches the pane-exit lifecycle. Lost historical replay fidelity keeps the pane attached and logs a typed degraded-snapshot diagnostic instead.
- In `@station/dashboard-core`: `selectors/` for snapshot-to-view grouping/filtering, `state/commandBuilders.ts` for typed observer command construction, `state/screens/*` for pure screen-owned key transitions, `state/observerBridge.ts` and `state/operations/*` for command/operation flow, and `components/`/`widgets/` for shared layout/content logic.
- The dashboard surface under `station/src/station/` may import only its linked dashboard-facing `@station/*` packages (`client`, `config`, `contracts`, `dashboard-core`, `runtime`). Other Station subsystems use only the additional packages named by the link script at their owned composition boundaries. Production Station source must never import `apps/tui`, `ink`, providers, or integrations (enforced by `station/src/station/importBoundaries.test.ts`).

## Testing

Station uses `bun test` (colocated `*.test.ts` / `*.test.tsx`), not vitest. `@station/dashboard-core` pure logic is unit-tested in `packages/dashboard-core/test`. For Station changes, choose the narrowest tests that prove the behavior, then add broader coverage only when the change crosses layers.

- Pure selectors, screen transitions, command builders, reducers, safe-error mapping, and state helpers belong in unit tests in `@station/dashboard-core`. Its package typecheck also compiles `test/unit/state/readonlyStateSource.typecheck.test.ts` to enforce recursive readonly state views, while the runtime boundary test protects identity-preserving projection.
- Key and input behavior is tested at its behavioral owners: dashboard binding
  dispatch in `packages/dashboard-core/test/unit/state/keymap.test.ts`, screen
  transitions in dashboard-core, sequence translation in
  `input/sequenceToTuiKey.test.ts`, and mouse guard/click-key equivalence in
  `input/stationMouse.test.ts`.
- Router/runtime conformance (reserved chords, modal swallow, paste, overlay-close) lives in `station/src/input/stationIntegration.test.ts`.
- Live command dispatch through the shared client (focus, jump-to-session, convergence, recovery) lives in `station/src/station/store/stationCommandDispatch.test.ts`.
- Rendering correctness uses golden frames: `station/src/station/view/dashboard.golden.test.tsx` (scenario × size matrix) and `view/modals.golden.test.tsx`. Use golden frames when exact terminal text, spacing, layout, footer placement, or clipping matters.
- Production popup acceptance lives in `integrations/terminal/tmux/test/integration/popup-real.test.ts`. Popup input and resize assertions must enter through an attached outer PTY, then prove the visible captured frame and converged nested-client/pane/renderer geometry; an internal store transition or command receipt is not sufficient evidence.
- Isolation is enforced by `station/src/station/importBoundaries.test.ts`. It scans all production `station/src` modules for forbidden UI/provider imports, private mutable dashboard state models, raw Zustand dashboard stores, mutable `StoreApi` references, and direct dashboard mutation. The remaining runtime/operation-internal import inventory is shrink-only. Dashboard-surface checks additionally enforce its linked `@station` package set, no local ported fork, and no `focusable`.
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

# Dashboard Architecture

`@station/dashboard-core` (`packages/dashboard-core`) owns the shared,
render-framework-free dashboard behavior: search/filter state, screens, focus,
collapse, optimistic rows, toasts, widget editing, and the flow machines behind
the New Session and Add Project sheets. It contains no renderer, no terminal
provider code, and no Observer authority.

## Renderer compositions

The CLI selects two sibling renderer compositions, and both render the same
dashboard surface:

- **native workspace renderer** — `station/src/main.tsx`, which also owns the
  workspace runtime (panes, overlays, native focus, context menus);
- **standalone dashboard renderer** — `station/src/dashboardRenderer/main.tsx`,
  used by the popup and fullscreen dashboard launches.

Each composition creates exactly one `DashboardRuntime` over an externally
supplied canonical client source. The runtime never constructs its own client
and never infers native versus standalone execution from UI state:

```text
StationClientRuntime (canonical observer state and commands)
        |                              |
        |                              +--> workspace runtime (native only)
        v                                   panes / overlays / native focus
DashboardRuntime
  read-only state source
  named dashboard actions
  owned lifecycle/effects
        |
        +--> semantic capabilities selected at composition
```

The runtime shape is:

```ts
type DashboardRuntime = {
  state: DashboardStateSource; // getState / getInitialState / subscribe
  actions: DashboardActions;   // sole external mutation authority
  start(): void;               // one-shot subscription and polling activation
  dispose(): Promise<void>;    // repeat-safe; settles in-flight work first
};
```

`DashboardStateSource` is structurally compatible with the read-only Zustand
`useStore` contract, but the Zustand store itself is private to the runtime
implementation and its focused tests. Public state views are identity-preserving
deep-readonly projections; mutable `DashboardState` never crosses the package
surface.

## State ownership

| Owner | Authority |
| --- | --- |
| `@station/client` | Canonical observer snapshot, connection posture, refresh/reconcile, and command-completion convergence |
| Dashboard runtime | Search/filter state, collapse, semantic cursor/selection, screens, dashboard-local optimistic rows, toasts, and live widget editing state |
| Workspace runtime/store | Panes, active overlay, native focus, context menu, workspace toast, and pane-return coordination (native composition only) |
| Config adapter | Durable `[tui]` preferences and widget persistence |
| PTY registry / Station Host | Processes, terminal buffers, replay, attachment, and terminal lifecycle |

The dashboard holds a source-driven reference to the canonical snapshot because
its pure selectors combine observer truth with local projection state. That
reference is a projection, never a second authority: only the injected client
source advances it. Native consumers needing only observer truth read a
client-owned source; dashboard queries are reserved for reads where local
filter, focus, screen, or optimistic state participates.

Semantic execution enters through capabilities selected at composition
(activation, managed sessions, worktree removal, dismissal, shell), never through state
replacement or synthetic key replay. Observer-backed worktree removal first
obtains authoritative validation and an opaque worktree reservation, then invokes
optional renderer PTY settlement, dispatches the reservation-qualified command,
and finalizes renderer layout only after command success; preparation or renderer
failure performs no command mutation and cancels the unused reservation. The
runtime owns subscriptions, timers, operation bookkeeping, and cancellation;
disposal is idempotent and testable.

New Session owns one bounded review flow shared by native and standalone
renderers. Its Group field selects Ungrouped, a current same-project root Group
by stable ID, or a trimmed inline-create draft. Snapshot replacement preserves
the stable selection through rename and resets missing, cross-project, or newly
nested Groups to Ungrouped. Submission retains and disables the sheet until the
single operation settles; success follows the composition's existing open/focus
path, while failure restores Group or Create focus and reports one bounded toast.
Native deliberate creation waits for the first canonical snapshot carrying the
requested Group relationship and performs one explicit load after timeout. If
launch succeeded but visibility remains uncertain—or safe cleanup retained the
fresh worktree—the operation closes with a warning instead of permitting a
duplicate branch submission.

Group Settings is one stable-ID screen per canonical Group, with General,
Sessions, and Remove Group sections. Activating the Group `[▾]` control opens a
stable-ID Group menu anchored to that cell. Quick Session and preselected New
Session reuse their existing workflows; Group Settings… opens General and
Remove Group… opens Remove without the menu owning settings state. General
captures the Group version for one `sessionGroup.rename`. Sessions captures that version plus each Project
session's expected current Group, stages desired membership locally, and emits
one atomic `sessionGroup.updateMembership` add/remove delta; selecting a member
of another Group is an expected move, and an empty desired set is valid. Remove
requires `delete <Group name>` and emits only `sessionGroup.delete`, so member
sessions and runtime resources remain open and become ungrouped.

Completed rename and membership commands reseed their editor from canonical
client state while retaining the settings screen and Group identity. Ordinary
failure retains the draft or staged intent and returns focus to the initiating
Save control; assignment/version conflicts are never retried. Snapshot
replacement preserves the active draft, prunes sessions that cease to be
canonical, and uses ordinary screen/focus reconciliation when the Group or
Project disappears. Successful deletion closes settings and focuses the owning
Project header. Pending settings mutations intercept keys and pointer input and
add no generic pending, disconnected, failure, or disappearance screen.

## Dashboard hierarchy, focus, and rendered layout

Dashboard structure has one projection path:

```text
canonical snapshot + dashboard-local state
        |
        v
selectDashboardTree
  branded row IDs, typed payloads, ordered cells, nested branches
        |
        +--> pure tree-grid focus/collapse/filter projection
        |
        v
Station Project/Group/leaf components
  containers own children, frames, padding, gaps, and indentation
        |
        v
OpenTUI flex/intrinsic layout
        |
        v
SemanticScrollViewport
  identity <-> measured box coordinates, clipping, focus-follow
        |
        +--> visible semantic IDs -> slot and overflow projection only
```

`selectors/dashboardTree.ts` is the sole dashboard hierarchy adapter. It joins
canonical sessions to worktree metadata, merges optimistic creates, applies
filter and collapse state, and projects Project roots whose semantic children are
direct Group branches and project-root session/action leaves. A Group branch owns
its direct members. Borders, indentation, padding, and inter-Project gaps are not
tree rows and never acquire focus, slots, or actions. `snapshot.sessionGroups` is
the exclusive membership authority; optional parent links are deliberately
flattened. Ordinary optimistic create rows remain at the Project root. A Quick
Group launch may temporarily target one pending row at its new Group and suppress
the exact matching ungrouped canonical row while the expected membership command
converges. That placement is renderer-local intent, never inferred or durable
membership, and is pruned as soon as canonical truth places the session or removes
its target.
Quick Session and explicitly Ungrouped Fork place optimistic create rows at the project root until
canonical replacement. A Group-inheriting Fork targets its optimistic row at the source Group ID;
a source move, deletion, or canonical replacement prunes that hint without synthesizing membership
or exposing a duplicate root row. Deliberate New Session retains its sheet and never creates such a
row.
The renderer-local `GroupOrderingMode` is `"groups-first" | "alphabetical-interleaved"`.
Groups-first is the default and places alphabetized Group blocks before project-root sessions.
Alphabetical interleaving compares Group names with root-session display titles while keeping each
Group branch intact. Neither mode changes canonical
arrays, collapse state, filtering, or the continuous slots assigned only to rendered sessions; no
public config currently selects the mode.
The internal `treeGrid.ts` controller knows only immutable nodes, ordered cells,
visibility, and a supplied eligibility policy; it has no dashboard or terminal
knowledge and is not a package entrypoint.

Project and Group collapse sets remain renderer-local and survive snapshot
replacement, Observer restart, and warm popup dismissal/reopen even when an ID is temporarily
absent. Filtering and ordering never mutate either collapse set; resize and scroll changes retain
stable focus identity while the renderer follows its measured box. Persistent filtering admits
session rows through one candidate projection while retaining durable Project
and Group containers; Group-name matches provide member text context, member
matches retain their Group header, and container match ranges remain semantic
renderer inputs. Group payload counts distinguish canonical direct membership
from filter-admitted renderable members before collapse and renderer clipping.

Dashboard state owns one stable `{ rowId, cellId }` cursor. Named policies bind
the generic controller to ordinary dashboard traversal, canonical-session-only
chooser traversal, and needs-attention traversal. Reconciliation preserves the
exact row and cell when possible, moves a collapse-hidden child to its visible
collapsed ancestor, and otherwise uses deterministic next/previous fallback.
Project rows use `identity`, `shell`, `quickSession`, and `menu`; the Project
menu owns Quick Group, New Group, default-agent, and settings transitions.
Group rows always use `identity` and show `quickSession` and `menu` by default.
Runtime composition may independently omit either optional action; omitted cells
are not rendered, focusable, or activatable. This visibility seam has no public
config key yet. Identity toggles collapse, the responsive `[qs]`/`[quick session]` action launches
an ordinary Quick Session followed by one expected membership update, and `[▾]` opens the
Q/N/S/R Group menu. Group Quick Session expands
a collapsed Group for its optimistic row.
The row remains Group-framed only as a convergence bridge; canonical placement
still comes exclusively from `snapshot.sessionGroups`. A focused direct visible member decorates its Group with
`containsFocusedRow`, leaving color and ring presentation to the renderer.

The selectors entrypoint exposes branded dashboard row IDs, dashboard cell IDs,
decorated tree rows, their exact `rowById` lookup, and nested `roots`. Renderers do
not construct or parse row IDs and do not reconstruct ancestry from a flat list.
`ProjectBranchView` owns its header and descendant branches. `GroupBranchView`
owns one `GroupFrameView` containing the Group header and every direct child, so
the border is part of that structure rather than painted line records or per-child
rails. Root and framed compact session leaves resolve against their actual
container widths. Quiet frames use the hairline role, a focused Group header uses
the working role, and member focus dims that working frame while the member keeps
ordinary keyboard-focus or hover treatment.

Station mounts the complete semantic component tree in one OpenTUI scroll box.
`station/view/layout/scrollViewport.ts` is the sole dashboard translation between
stable identities and measured `y`/`height` cell geometry. It follows focus by
identity, scrolls and clips by box coordinates, treats partially intersecting and
oversized boxes correctly, and reports only intersecting semantic IDs back to
dashboard-core. Core uses those IDs for visible slot assignment and session
overflow counts; it receives no coordinates, terminal height, item-height
assumption, or scroll offset, and it never pre-slices the component tree. The renderer indexes
semantic IDs to their OpenTUI boxes with one bounded tree traversal when those boxes mount or are
replaced. Steady-state ordered visibility lookup is logarithmic in total items plus the
intersecting boxes, so ordinary scroll synchronization does not recursively rescan the dashboard
for every geometry probe.

Pointer targets identify one `dashboardCell`. In dashboard mode both pointer
activation and focused Enter resolve that cell through the current visible tree
and dispatch the same `dashboard.cell.activate` transition. The anchored Group
menu and native Group-header context menu resolve Q/N/S/R through one validated
stable-ID action path; native presentation does not own workflow behavior.
Invalid, hidden, filtered, or stale cell targets are inert. Chooser modes accept
only canonical session identity cells and retain their existing slot semantics.
Semantic picker lists likewise retain every item in cursor order. `1-9/a-z`
keys are optional accelerators on the first 35 choices, not a membership cap;
later choices remain renderable, focusable, scroll-followed, Enter-activatable,
and pointer-activatable by stable item ID through the same registered-list commit.

## Adjacent layout surfaces

Sheets, settings panels, Help, filter conditions, dashboard menus, and context
menus use the same `SemanticScrollRegion` contract: callers provide stable item
IDs and complete intrinsic content; the scroll container owns clipping and follows
the selected identity through measured coordinates. A bottom sheet owns semantic
title/context/body/actions/footer slots and one stable preferred box for the lifetime
of a workflow; it shrinks only at the terminal edge and scrolls only its body.
Settings containers own their navigation/detail nesting and use one centered
preferred box across sections and pickers, with focused content driving the shared
scroll region. Help uses the same split of responsibility: dashboard-core stores
only the focused Help entry ID and resolves ordered keyboard movement, while
Station follows that ID through measured boxes in a bounded panel and derives its
continuation cue from the identities intersecting the viewport. These preferred dimensions are Station renderer-boundary policy;
dashboard-core neither observes them nor changes semantic state in response.
Anchored surfaces
measure their owner, anchor, intrinsic content, border, and viewport after OpenTUI
layout; feature state owns neither offsets nor visible-index windows.
An anchored popover may change intrinsic height when its semantic option set changes,
but its anchor and width stay stable, and the owner boundary clamps both stages to the
same available height at a short terminal edge. Stable workflow sizing remains the
responsibility of sheets and settings panels rather than unrelated popovers.
Context-menu focus, pointer hits, and activation cross renderer/input boundaries
as `ContextMenuItemId`; ordered keyboard movement resolves a new ID without
persisting an array position.

`DashboardRoot` composes a flexible notice region above intrinsic dashboard controls.
The prompt, divider, and footer are ordinary children of `DashboardControlsView`;
the toast owns an intrinsic action header and a semantic scroll body inside that
region, growing upward without reserving prompt/footer rows or stretching to fill
unused space. Its vertical frame keeps copy and dismiss reachable when there is no
room for top/bottom border cells, and copying still exposes the complete notice when
the body is clipped. Optional table headers and overflow indicators are absent when
they have no semantic content; blank renderables never reserve their space.
Active screens share one overlay layer and do not force the dashboard to reflow.
Native and standalone renderers use this same composition.

## Intentional terminal-cell boundaries

Physical geometry is permitted only after semantic state and has these owners:

- `station/view/layout/*` and the context-menu placement adapter translate
  OpenTUI renderables into measured coordinates, bounded heights, pointer hits,
  and scroll deltas. The Station import-boundary test inventories these modules.
- Group/sheet frame helpers subtract their two vertical border cells only to
  resolve the renderer-owned child content box. Containers, not core state,
  still own the border and descendants.
- `packages/dashboard-core/src/components/WorktreeRow/*` owns terminal-cell
  negotiation for the session row-grid, while Station's
  `station/src/station/view/dashboardRowGridProjection.ts` invokes and caches
  that compact leaf projection. Renderer-visible shortcut labels are
  applied after width negotiation, so scrolling does not remeasure the complete
  semantic tree; semantic-tree or width changes invalidate the bounded cache.
  The row-grid, dividers, footer controls, and similar compact leaves may
  deliberately paint one cell high. They are leaf presentations and do not set
  parent composition, focus visibility, or scroll state.
- `StationOverlay` converts terminal/config percentages to the outer popup box
  and its border interior. `stationButton/layout.ts` owns fixed target cells for
  its isolated top-right morph so the hover target stays stationary; both are
  tested renderer boundaries and export no dashboard feature state.
- PTY sizing, VT buffers, terminal emulation, and pane cell grids are inherently
  physical and remain outside this dashboard migration.

## Package surface

The `exports` map publishes five role entrypoints; there is no root
barrel and no wildcard subpath access:

| Entrypoint | Role |
| --- | --- |
| `@station/dashboard-core/runtime` | Runtime construction and lifecycle: `createDashboardRuntime`, capability factories, `dashboardExecution`, and the injected service contracts |
| `@station/dashboard-core/state` | Read-only state views, key/action handling, screen transitions, toasts, and the new-session/add-project flow machines |
| `@station/dashboard-core/selectors` | Pure semantic tree, visible-slot/overflow, header/footer/filter models, and compact leaf-layout projections |
| `@station/dashboard-core/text` | Narrow grapheme segmentation and terminal-cell measurement/clipping shared by compact renderer-neutral leaves |
| `@station/dashboard-core/widgets` | Widget config shapes (owned by `@station/contracts`), widget resolution, and the widget hook runtime |

Directory layout keeps ownership visible: `selectors/` for snapshot-to-view
projection, `state/screens/*` for pure screen transitions,
`state/commandBuilders.ts` for typed observer command construction,
`state/sourceBridge.ts` for mirroring canonical client state into the
projection, `state/runtimeEffectScope.ts` for private effect admission and
settlement, `state/capabilities/*` for semantic renderer authority,
`state/operations/*` for scope-bound command flow (including durable Group
creation before optional Quick Session launch and expected membership), and
`components/`/`widgets/` for shared layout and content logic, and `text/` for the
narrow grapheme/cell contract. Dashboard-core owns renderer-neutral settings
content; Station owns responsive OpenTUI settings shells and scrolling, while each settings screen
retains its navigation policy, detail controls, drafts, and mutation lifecycle. The `[tui]` config shapes
live in `@station/contracts`; `@station/config` retains load/persist authority.

## Dependency direction and enforcement

- Station compositions depend on dashboard-core through the role entrypoints;
  dashboard-core never imports Station, workspace, or terminal-provider code.
- `station/src/sources` carries no dashboard-core dependency; operation
  convergence lives behind `@station/client`.
- `station/src/station/importBoundaries.test.ts` freezes the coupling surface:
  it rejects private mutable dashboard model imports and direct mutation, pins
  `DashboardRuntime` imports to the two composition files, and requires every
  production dashboard-core import to use a role entrypoint.
- `packages/dashboard-core/test/unit/declaredDependencies.test.ts` guards the
  emitted declarations: production sources may import only declared
  dependencies, since type imports become declaration references.
- `packages/dashboard-core/test/unit/state/readonlyStateSource.typecheck.test.ts`
  and the runtime boundary test protect identity-preserving recursive readonly
  views.

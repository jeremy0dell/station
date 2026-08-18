# Dashboard Architecture

`@station/dashboard-core` (`packages/dashboard-core`) owns the shared,
render-framework-free dashboard behavior: search/filter state, screens, focus,
scroll, optimistic rows, toasts, widget editing, and the flow machines behind
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
| Dashboard runtime | Search/filter state, collapse, cursor and scroll, screens, dashboard-local optimistic rows, toasts, and live widget editing state |
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
(activation, managed sessions, dismissal, shell), never through state
replacement or synthetic key replay. The runtime owns subscriptions, timers,
operation bookkeeping, and cancellation; disposal is idempotent and testable.

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

## Dashboard hierarchy, cursor, and viewport

Dashboard structure has one projection path:

```text
canonical snapshot + dashboard-local state
        |
        v
selectDashboardTree
  branded row IDs, typed payloads, ordered cells
        |
        +--> pure tree-grid projection and cursor reconciliation
        |
        v
selectDashboardViewport
  terminal clipping, scroll counts, and visible session slots
        |
        v
Station renderers
```

`selectors/dashboardTree.ts` is the sole dashboard hierarchy adapter. It joins
canonical sessions to worktree metadata, merges optimistic creates, applies
filter and collapse state, and projects Project roots, direct Group blocks,
project-root sessions, inert Group closing-frame rows, and inert gaps. Every
expanded Group ends with one cell-less frame row, including an empty Group, so
the visible ring has truthful viewport height without gaining focus, a slot, or
an action. `snapshot.sessionGroups` is the exclusive membership authority;
optional parent links are deliberately flattened. Ordinary optimistic create
rows remain at the project root. A Quick Group launch may temporarily target
one pending row at its new Group and suppress the exact matching ungrouped
canonical row while the expected membership command converges. That placement
is renderer-local intent, never inferred or durable membership, and is pruned
as soon as canonical truth places the session or removes its target.
Quick Session and Fork otherwise place optimistic create rows at the project
root until canonical replacement; deliberate New Session retains its sheet and
never creates such a row.
The renderer-local `GroupOrderingMode` chooses Groups-first or whole-block
alphabetical interleaving without changing canonical arrays.
The internal `treeGrid.ts` controller knows only immutable nodes, ordered cells,
visibility, and a supplied eligibility policy; it has no dashboard or terminal
knowledge and is not a package entrypoint.

Project and Group collapse sets remain renderer-local and survive snapshot
replacement even when an ID is temporarily absent. Persistent filtering admits
session rows through one candidate projection while retaining durable Project
and Group containers; Group-name matches provide member text context, member
matches retain their Group header, and container match ranges remain semantic
renderer inputs. Group payload counts distinguish canonical direct membership
from filter-admitted renderable members before collapse and viewport clipping.

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
decorated tree rows, and the viewport contract. `DashboardViewport.rows` is the
terminal-clipped sequence; `DashboardViewport.rowById` is the exact full tree
lookup used by input and context-menu boundaries. Renderers do not construct or
parse row IDs and do not maintain a second flattened hierarchy. Station renders
the clipped sequence directly, resolves Group ownership through `parentId` and
`rowById`, and computes one shared session grid two columns narrower whenever
Groups exist. Root sessions start at column zero; Group members add inert side
rails around that same grid. Quiet rings use the hairline role, a focused Group
header uses the working role, and member focus dims that working ring while the
member keeps ordinary keyboard-focus or hover treatment. Frame edges clip and
scroll as ordinary projected rows.

Pointer targets identify one `dashboardCell`. In dashboard mode both pointer
activation and focused Enter resolve that cell through the current visible tree
and dispatch the same `dashboard.cell.activate` transition. The anchored Group
menu and native Group-header context menu resolve Q/N/S/R through one validated
stable-ID action path; native presentation does not own workflow behavior.
Invalid, hidden, filtered, or stale cell targets are inert. Chooser modes accept
only canonical session identity cells and retain their existing slot semantics.

## Package surface

The `exports` map publishes exactly four role entrypoints; there is no root
barrel and no wildcard subpath access:

| Entrypoint | Role |
| --- | --- |
| `@station/dashboard-core/runtime` | Runtime construction and lifecycle: `createDashboardRuntime`, capability factories, `dashboardExecution`, and the injected service contracts |
| `@station/dashboard-core/state` | Read-only state views, key/action handling, screen transitions, toasts, and the new-session/add-project flow machines |
| `@station/dashboard-core/selectors` | Pure projections into rows, viewport, header/footer/filter models, and layout primitives |
| `@station/dashboard-core/widgets` | Widget config shapes (owned by `@station/contracts`), widget resolution, and the widget hook runtime |

Directory layout keeps ownership visible: `selectors/` for snapshot-to-view
projection, `state/screens/*` for pure screen transitions,
`state/commandBuilders.ts` for typed observer command construction,
`state/sourceBridge.ts` for mirroring canonical client state into the
projection, `state/runtimeEffectScope.ts` for private effect admission and
settlement, `state/capabilities/*` for semantic renderer authority,
`state/operations/*` for scope-bound command flow (including durable Group
creation before optional Quick Session launch and expected membership), and
`components/`/`widgets/` for shared layout and content logic. Dashboard-core owns responsive
settings geometry; Station owns one OpenTUI settings shell, while each settings screen retains its
navigation policy, detail controls, drafts, and mutation lifecycle. The `[tui]` config shapes
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

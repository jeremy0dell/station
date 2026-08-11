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
optional parent links are deliberately flattened, while optimistic create rows
remain at the project root until canonical replacement.
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
Group rows use `identity`, `quickSession`, and `menu`; only identity toggles
collapse in this slice, while the exact `[qs]` and `[▾]` targets remain
focusable no-ops. A focused direct visible member decorates its Group with
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
and dispatch the same `dashboard.cell.activate` transition. Invalid, hidden,
filtered, or stale cell targets are inert. Chooser modes accept only canonical
session identity cells and retain their existing slot semantics.

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
`state/operations/*` for scope-bound command flow, and `components/`/`widgets/`
for shared layout and content logic. The `[tui]` config shapes live in
`@station/contracts`; `@station/config` retains load/persist authority.

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

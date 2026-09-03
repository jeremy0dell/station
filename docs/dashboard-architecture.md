# Dashboard Architecture

Status: current living architecture for `@station/dashboard-core`.

`packages/dashboard-core` owns renderer-independent dashboard semantics. It
projects canonical Station client state into a semantic UI model and coordinates
typed user intent without owning an Observer, renderer, terminal, filesystem, or
configuration store.

This document owns dashboard-core boundaries, authority, lifecycle, identity,
and dependency direction. [TUI Development](tui.md) owns visible interaction and
OpenTUI behavior, [Configuration](configuration.md) owns `[tui]` fields and
persistence, and [Testing](../tests/README.md) owns verification lanes.

## Runtime Boundary

The native workspace and standalone dashboard are sibling Station renderer
compositions. Each constructs one `DashboardRuntime` over an externally supplied
Station client source and supplies the capabilities needed by that renderer:

```text
Observer snapshot and commands
            |
            v
@station/client
  canonical in-process state and command completion
            |
            v
DashboardRuntime
  readonly projection state
  closed semantic actions
  owned effects and lifecycle
            |
            v
Station renderer capabilities
  OpenTUI, panes, focus, shell, dismissal, and terminal settlement
```

Dashboard-core must not infer native versus standalone execution from UI state.
Composition supplies the client source, Observer-facing service, folder service,
semantic visibility sources, and renderer capabilities. Core supplies no
filesystem, terminal, or capability fallback.

The runtime exposes only a deeply readonly state source, a closed action surface,
and `start`/`dispose` lifecycle methods. Mutable Zustand state remains private.
`start` activates subscriptions and polling at most once. `dispose` is
repeat-safe: it closes new effect admission synchronously, removes owned
subscriptions and timers, waits for admitted work to settle, and prevents late
state writes.

## Authority And State Ownership

Authority is scoped rather than global:

| Owner | Authority |
| --- | --- |
| Observer | Durable sessions, Groups, commands, provider observations, and the normalized snapshot contract |
| `@station/client` | Canonical in-process snapshot, connection state, refresh/reconcile, and command completion |
| Dashboard runtime | Local projection state and effects |
| Station renderer composition | Physical layout, native UI state, and renderer-owned capabilities |
| `@station/config` adapter | Durable `[tui]` preferences and widget persistence |
| Station Host and PTY owners | Process lifetime, terminal buffers, replay, attachment, and terminal lifecycle |

The dashboard keeps the canonical snapshot reference supplied by
`@station/client`; it does not copy or advance canonical state independently.
Snapshot replacement may reconcile local focus, screens, drafts, and optimistic
rows, but local projections never become Observer evidence.

`snapshot.sessionGroups` is the exclusive Group-membership authority. Optimistic
placement may display pending intent, but it must not synthesize durable
membership, rewrite canonical arrays, or survive contradictory canonical state.
Group mutations carry stable Group identity plus the expected version or current
assignment required by the command contract. Drift is a conflict to surface, not
permission to retry against a different Group or session.

## Capability And Mutation Boundary

Renderers read dashboard state and submit named actions. They do not receive the
mutable store, call `setState`, replay synthetic keys, or implement dashboard
workflow state machines. Dashboard-core turns accepted actions into semantic
requests for these renderer-selected capability groups:

- canonical session activation;
- managed session creation and fork;
- post-create focus and dismissal;
- reservation-qualified worktree removal;
- shell opening; and
- dashboard dismissal or renderer exit.

Capabilities receive stable product identities and values, never dashboard
state. Pure state transitions commit before capability invocation. Async results
may settle optimistic UI or produce bounded feedback only while the runtime
remains open.

Observer-backed capabilities must revalidate the selected Project, Group,
session, worktree, branch, and terminal identity against current client state
immediately before mutation. A missing, ambiguous, changed, hidden, or stale
target must fail closed or become inert; it must never be retargeted by list
position. An advertised capability failure must not silently fall through to a
second implementation that could duplicate work.

Destructive worktree removal additionally requires verified registration
identity and an Observer-issued reservation for the exact worktree. Required
renderer terminal settlement occurs before command dispatch, renderer cleanup
occurs only after command success, and an unused reservation is cancelled when
preparation fails. A retained Station session without a live agent or recovery
handle requires explicit fresh-start confirmation before launch.

Post-create focus and dismissal are a data-only dashboard effect tied to the
exact canonical create result. They are neither an Observer command nor durable
state. Failure after creation must not make the successful create retryable or
roll back a surviving canonical session.

## Semantic Identity And Layout

Dashboard-core projects one nested semantic tree from canonical state and local
projection state:

```text
canonical snapshot + dashboard-local state
                  |
                  v
semantic Project / Group / session tree
  stable row IDs, cell IDs, hierarchy, focus, and actions
                  |
                  v
Station renderer
  measured boxes, clipping, scrolling, hit testing, and painting
```

Project and Group nodes own their semantic descendants. Frames, indentation,
padding, separators, and gaps are presentation and never become rows, identity,
or mutation targets. Renderers consume the nested tree and branded row/cell IDs;
they must not construct or parse those IDs, reconstruct ancestry from a flat
list, or use array position as identity.

Focus is a stable row-and-cell identity. Snapshot replacement and collapse may
reconcile that identity to a deterministic semantic neighbor or ancestor, but
resize and scroll never change semantic state merely because coordinates moved.
Keyboard and pointer activation converge on the same currently visible semantic
cell. Stale, filtered, collapsed, disabled, pending, or otherwise invalid targets
are inert.

Dashboard-core owns complete semantic content, focus, collapse, filtering,
selection, and actions. Station owns terminal dimensions, measured coordinates,
scroll offsets, clipping, focus-follow, anchored placement, and pointer hit
testing. Core may receive only the stable semantic IDs visible through that
renderer boundary; it must not receive coordinates, viewport dimensions,
assumed item heights, or pre-sliced component trees.

The narrow terminal-cell exception is renderer-neutral text and compact-leaf
negotiation exposed through the `text` and selector roles. It may measure and
clip grapheme-safe cell content, but it must not choose parent geometry, scrolling,
focus visibility, or OpenTUI composition.

## Public Package Surface

The package publishes five role entrypoints and no root barrel or wildcard
subpaths:

| Entrypoint | Owns |
| --- | --- |
| `@station/dashboard-core/runtime` | Runtime, readonly state/actions, lifecycle, capabilities, and injected services |
| `@station/dashboard-core/state` | State views, semantic input/actions, screens, transitions, drafts, and flows |
| `@station/dashboard-core/selectors` | Pure semantic trees, view models, visibility slots, and compact leaves |
| `@station/dashboard-core/text` | Grapheme-safe terminal-cell measurement, clipping, and truncation |
| `@station/dashboard-core/widgets` | Widget configuration views, resolution, and renderer-independent widget runtime |

Consumers import through the role matching their responsibility. Private mutable
models, generic tree-grid mechanics, operation runners, and internal module paths
must not cross the package boundary.

## Dependency Direction

- Station compositions depend on dashboard-core through its role entrypoints;
  dashboard-core never imports Station, OpenTUI, workspace, terminal-provider,
  integration, or provider implementation code.
- `@station/client` remains independent of dashboard-core. Core consumes its
  readonly source and command-completion contracts rather than creating another
  client or graph.
- Dashboard-core may depend on provider-neutral contracts and shared runtime
  mechanics. It must not read Observer persistence, parse provider-private data,
  or invoke provider and repository tools directly.
- Node filesystem policy stays in Station composition behind the injected folder
  service. Production dashboard-core does not import Node filesystem, OS, or path
  modules.
- `[tui]` schema ownership stays in `@station/contracts`; loading and persistence
  stay in `@station/config`. Dashboard-core may edit renderer-neutral drafts but
  does not become configuration authority.

Package exports, declaration checks, and Station import-boundary tests enforce
these directions. Follow [Development](development.md) and
[Testing](../tests/README.md) for current commands rather than copying test-file
inventories into this architecture.

## Conflict Rule

This document is authoritative for dashboard-core ownership and durable
boundaries. Current code, schemas, and tests establish implementation behavior;
[TUI Development](tui.md) owns user-visible interaction contracts, and
[Configuration](configuration.md) owns configuration behavior.

When they disagree, identify the stale owner and correct it in the same change.
Plans, milestones, migration status, TODOs, acceptance evidence, and historical
implementation narratives are not dashboard architecture.

# Station STATION View

The full read-only dashboard surface behind Ctrl-O / header-click.
Architecture: render-framework-free dashboard behavior comes
from `@station/dashboard-core`; the OpenTUI render layer under `view/` and the
Station input/mouse plumbing stay local. Input registers into Station's router:
the overlay keymap slot delegates to the shared transition machine
(`input/stationOverlayLayer.ts`), and mouse targets resolve through one pure
`routeStationMouse` (`input/stationMouse.ts`).

## Running it

```bash
cd station

# live observer (default)
bun run station

# deterministic fixtures, no observer needed
STATION_SOURCE=mock bun run station
STATION_SOURCE=mock STATION_SCENARIO=many-projects bun run station
STATION_SOURCE=mock STATION_SCENARIO=attention-and-failures bun run station
STATION_SOURCE=mock STATION_SCENARIO=disconnected bun run station
```

Ctrl-O or header click toggles STATION mode; the shell pane survives underneath.
Ctrl-Q always exits Station. Pane split, focus, and close chords are ignored while
the dashboard is open so the hidden native layout cannot change.

## Input

Runtime keyboard dispatch goes through the shared dashboard-core transition
machine. Workflow mouse targets call `DashboardActions.dispatch(...)` with
renderer-neutral Dashboard actions; direct commands and focused Enter decode to the
same core intents, and the runtime applies every resulting transition and semantic
capability execution through one executor.
`DashboardRuntime.state` is read-only (`getState`, `getInitialState`, and
`subscribe`), while `DashboardRuntime.actions` is the only external mutation
authority. Presentation receives the state source; input receives state plus actions;
`createStation` alone owns `start` and repeat-safe `dispose`.

Every renderer injects session-activation, managed-session, shell-opening, and
dismissal capabilities. Native Station composes those capabilities with managed panes
and overlay authority; standalone rendering composes Observer commands and popup IPC.
Dashboard state contains no renderer control intents, and dashboard-core owns optimistic
rows, notices, failures, and expiry. Native pointer Create, direct `C`, and focused
Create Enter therefore converge after semantic resolution and shared validation before
the same managed-session capability invocation.

## Acceptance suite

- `bun run test` — everything below; `bun run typecheck`.
- Dashboard binding behavior:
  `../../../packages/dashboard-core/test/unit/state/keymap.test.ts`.
- Sequence translation: `input/sequenceToTuiKey.test.ts`.
- Mouse guard matrix + click/key equivalence: `input/stationMouse.test.ts`.
- Router/runtime conformance (reserved chords, modal swallow, paste,
  overlay-close): `../input/stationIntegration.test.ts`.
- Live command dispatch through the shared client (focus, jump-to-session,
  Z-through-runtime, convergence, recovery): `store/stationCommandDispatch.test.ts`.
- Source-adjacent action rendering:
  `view/sheets/AddProjectSheetView.test.tsx` and
  `view/sheets/NewSessionSheetView.test.tsx`.
- Golden frames: `view/dashboard.golden.test.tsx` (scenario × size matrix +
  span color probes), `view/modals.golden.test.tsx` (all modal and focused-action views).
- Isolation: `importBoundaries.test.ts` (no apps/tui imports, only linked
  @station packages, no local ported fork, no `focusable`).

## Command dispatch (client plan PR 4)

Live mode dispatches through the single shared `@station/client` service: one
client runtime owns canonical snapshot/connection state and the `ObserverService`
used by commands (`sources/observerStationClient.ts`). Reconcile and operation
snapshot loads commit through that runtime before resolving, so the next event
reduces from the same snapshot object dashboard projection receives through its
read-only client-state subscription. Dispatch and command-completion waits pass
through unchanged; row-activate focus,
jump-to-session on click, and `Z` refresh are live
(`store/stationCommandDispatch.test.ts`).

Mock mode keeps the rejecting service by design
(`store/stubObserverService.ts`): mutating commands run the shared operations
paths (pending rows, TTL revert, toasts) and resolve as rejected receipts
naming mock mode.

Known gap: canonical client state carries snapshot and connection truth, not a
notice queue, so `command.failed` event notices do not independently surface as
toasts; failures still toast once through command-completion waits on focus and
operation paths.

## Known not-yet

- Footer hint chips and help rows are not click targets; the footer renders as
  one truncated string.
- The attention marker is static red `!` per the visual notes
  recommendation (pulse deferred).

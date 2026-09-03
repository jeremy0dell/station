# Station Dashboard Renderer

`station/src/station` is the OpenTUI presentation layer shared by the native
workspace and standalone dashboard compositions. It turns renderer-neutral
dashboard state into views, measured terminal layout, scrolling, and pointer
targets.

`@station/dashboard-core` owns semantic state, focus, transitions, operations,
and capability contracts. Renderer compositions supply canonical client state
and capabilities. Code here remains provider-neutral and must not become a
second source of Observer, session, or Group truth.

## Local invariants

- Views receive read-only dashboard state; semantic input goes through
  `DashboardActions`.
- Terminal coordinates, clipping, scroll position, and pointer hit testing stay
  in the renderer layer and do not enter dashboard-core state.
- While the dashboard or another modal covers native panes, ordinary keyboard,
  paste, and pointer input must not reach hidden PTYs or mutate the hidden pane
  layout. Those panes remain alive for return after dismissal.

## Develop

From the repository root, start the isolated devbox with UI hot reload:

```sh
bun run station:devbox dev
```

Use the owning guides for details:

- [Dashboard architecture](../../../docs/dashboard-architecture.md)
- [TUI development](../../../docs/tui.md)
- [Local development](../../../docs/local-development.md)
- [Testing](../../../tests/README.md)

# state/

Vanilla coordination store for Station's pane / overlay / dialog / toast UI.
Pure where it can be: live PTYs, terminal buffers, and renderer refs stay in the
registries (`terminal/`), never here.

## Core (flat at the root — always deep-imported, no barrel)

- **`types.ts`** — domain vocabulary, pane-id codecs, constants. Import-free
  leaf; everything depends on it.
- **`store.ts`** — `createStationStore` factory (the only closure-coupled code)
  plus the public store contract types. Composes the helpers below.
- **`initialState.ts`** — boot-state builders + `StationStoreOptions`
  (re-exported by `store.ts`). Turns options into the first `StationState`.
- **`reducers/`** — pure `State -> State` / `State -> FocusTarget` transitions
  the factory composes. No closure dependency, so each is directly unit-testable.
  - `paneFocus.ts` — `hasPane`, `fallbackFocus`, `withActivePane`: the shared
    active-pane/focus primitives the other reducers build on.
  - `overlay.ts` — open/close overlay transitions.
  - `contextMenu.ts` — open/close context menu + `focusAfterContextMenu`.
- **`selectors.ts`** — memo-safe scalar `select*` reads for
  `useSyncExternalStore` consumers.
- **`paneTree.ts`** — pure render-tree derivation (`buildPaneForest`,
  `selectActivePaneTree`, `sessionPaneIds`). Read-surface for both the view and
  the store; stays at the root because `terminal/PaneGrid.tsx` imports it.

## reconcilers/ — source → store/registry bridges

Subscribed by `createStation.ts`; each watches a source and drives effects.

- **`reconcilePanes.ts`** — store workspace → `PtyRegistry`: ensure a live PTY
  for every pane record, dispose entries whose pane is gone.
- **`sessionReaper.ts`** — observer snapshot → store: when a session leaves the
  snapshot, kill and close its on-screen panes.

## layout/ — persist + restore plumbing

Consumed only by `createStation.ts` and `main.tsx`.

- **`layoutSnapshot.ts`** — Zod snapshot schema, build / parse / validate.
- **`layoutPersistence.ts`** — atomic disk read/write + debounced writer.
- **`restoreLayout.ts`** — cold/warm restore plans + seed application.
- **`bootRestore.ts`** — async fork choosing cold vs warm restore.
- **`savedCwdExists.ts`** — fs probe; the production `cwdExists` adapter.

## Rules

- **No `index.ts` barrel** — direct imports keep go-to-definition honest.
- **Dependency direction is one-way, no cycles.** `reducers/` and
  `initialState.ts` are pure leaves that `store.ts` composes (store → reducers).
  `reconcilers/` and `layout/` sit *above* core: they import core, and only the
  composition (`createStation.ts` / `main.tsx`) imports them — core never imports
  them back.
- **Tests colocate beside their source.** The filename suffix encodes cost, not
  topic: `.test.ts` = unit (fakes only, no real I/O); `.integration.test.ts` =
  real fs/shell/host; `.warm.integration.test.ts` = real host reattach.

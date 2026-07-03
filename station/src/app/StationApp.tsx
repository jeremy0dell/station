import { useCallback, useSyncExternalStore } from "react";
import { useStore } from "zustand/react";
import { ContextMenuRoot } from "../contextMenu/index.js";
import {
  selectPaneCount,
  selectWelcomeCanContinue,
  selectWelcomeVisible,
  selectStationOverlayVisible,
} from "../state/selectors.js";
import type { StationStore } from "../state/store.js";
import type { StationState } from "../state/types.js";
import { StationButton } from "../stationButton/index.js";
import { StationToast } from "../StationToast.js";
import { PaneGrid, PaneRegistryProvider } from "../terminal/index.js";
import { WelcomeScreen } from "../welcome/WelcomeScreen.js";
import { StationOverlay } from "../station/StationOverlay.js";
import { STATION_COLORS } from "../station/view/theme.js";
import { useTopRowWidgets } from "../station/widgets/useTopRowWidgets.js";
import type { StationAppProps } from "./types.js";

// Select scalars only — useSyncExternalStore Object.is-compares snapshots, so an
// object-building selector would loop. Selectors are module-level (stable), so
// the memoized getter backs both the client and (unused, no-SSR) server slots.
function useStoreValue<T>(store: StationStore, selector: (state: StationState) => T): T {
  const get = useCallback(() => selector(store.getState()), [store, selector]);
  return useSyncExternalStore(store.subscribe, get, get);
}

export function StationApp({
  store,
  registry,
  stationViewStore,
  dispatchMouse,
  onCopySelection,
  automations,
  island,
  topRowWidgetDeps,
  overlayWidthPercent,
  overlayHeightPercent,
}: StationAppProps) {
  const overlayVisible = useStoreValue(store, selectStationOverlayVisible);
  const hasPanes = useStoreValue(store, selectPaneCount) > 0;
  const welcomeVisible = useStoreValue(store, selectWelcomeVisible);
  const welcomeCanContinue = useStoreValue(store, selectWelcomeCanContinue);
  // The live session widget set: seeded from config, edited by the panel.
  const widgets = useStore(stationViewStore, (state) => state.widgets);
  const topRowWidgets = useTopRowWidgets(widgets, topRowWidgetDeps);

  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={STATION_COLORS.background}>
      <box width="100%" flexGrow={1} flexDirection="column">
        {/* Welcome replaces the grid during the boot intro / empty workspace; the
            panes' PTYs live in the registry, so they re-attach when it dismisses. */}
        {welcomeVisible ? (
          <WelcomeScreen dispatchMouse={dispatchMouse} canContinue={welcomeCanContinue} />
        ) : hasPanes ? (
          <PaneRegistryProvider registry={registry}>
            <PaneGrid
              store={store}
              stationViewStore={stationViewStore}
              dispatchMouse={dispatchMouse}
              onCopySelection={onCopySelection}
            />
          </PaneRegistryProvider>
        ) : null}
      </box>
      {/* The panes keep running behind the STATION overlay, which floats above as a
          centered popup; pane clicks are guarded while any overlay is active. */}
      {overlayVisible ? (
        <StationOverlay
          store={stationViewStore}
          topRowWidgets={topRowWidgets}
          dispatchMouse={dispatchMouse}
          widthPercent={overlayWidthPercent}
          heightPercent={overlayHeightPercent}
        />
      ) : null}
      <ContextMenuRoot
        store={store}
        stationViewStore={stationViewStore}
        dispatchMouse={dispatchMouse}
        automations={automations}
      />
      <StationToast store={store} />
      {/* Floats at the top-right above everything; only its own hitbox captures
          mouse events, so clicks elsewhere reach the panes underneath. */}
      <StationButton
        store={store}
        stationViewStore={stationViewStore}
        dispatchMouse={dispatchMouse}
        island={island}
      />
    </box>
  );
}

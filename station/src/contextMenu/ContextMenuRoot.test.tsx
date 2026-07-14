import { describe, expect, it } from "bun:test";
import { MouseButtons } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import type { StoreApi } from "zustand/vanilla";
import { createInitialTuiState, type TuiStore } from "@station/dashboard-core";
import type { StationMouseEvent } from "../input/mouse.js";
import type { MouseTargetRef } from "../input/router.js";
import { createStationStore } from "../state/store.js";
import { MAIN_PANE_ID } from "../state/types.js";
import { ContextMenuRoot } from "./ContextMenuRoot.js";

describe("ContextMenuRoot", () => {
  it("renders nothing while closed and renders menu items when open", async () => {
    const store = createStationStore();
    const setup = await renderRoot(store);
    try {
      expect(setup.captureCharFrame()).not.toContain("Close Pane");

      store.actions.openContextMenu({ kind: "pane", paneId: MAIN_PANE_ID }, { x: 2, y: 1 });
      await setup.flush();

      const frame = setup.captureCharFrame();
      expect(frame).toContain("Split Right");
      expect(frame).toContain("Close Pane");
    } finally {
      setup.renderer.destroy();
    }
  });

  it("clamps edge placement into the terminal and routes outside clicks to the backdrop", async () => {
    const store = createStationStore();
    store.actions.openContextMenu({ kind: "pane", paneId: MAIN_PANE_ID }, { x: 38, y: 9 });
    const calls: Array<{ target: MouseTargetRef; event: StationMouseEvent }> = [];
    const setup = await renderRoot(store, (target, event) => {
      calls.push({ target, event });
      return true;
    });
    try {
      const frame = setup.captureCharFrame();
      expect(frame).toContain("Split Right");

      await setup.mockMouse.click(0, 0, MouseButtons.LEFT);
      expect(calls[0]).toEqual({
        target: { kind: "contextMenuBackdrop" },
        event: {
          type: "down",
          button: "left",
          rawButton: 0,
          x: 0,
          y: 0,
          modifiers: { shift: false, alt: false, ctrl: false },
        },
      });
    } finally {
      setup.renderer.destroy();
    }
  });
});

async function renderRoot(
  store: ReturnType<typeof createStationStore>,
  dispatchMouse: (target: MouseTargetRef, event: StationMouseEvent) => boolean = () => true,
) {
  const setup = await testRender(
    <ContextMenuRoot
      store={store}
      stationViewStore={emptyStationStore()}
      dispatchMouse={dispatchMouse}
      automations={[]}
    />,
    { width: 40, height: 10 },
  );
  await setup.flush();
  return setup;
}

function emptyStationStore(): StoreApi<TuiStore> {
  const state = {
    ...createInitialTuiState(),
    start: () => () => {},
    handleKey: () => ({ dismissPopup: false }),
    setTerminalRows: () => {},
    focusDashboardSession: () => {},
    clearDashboardFocus: () => {},
    pushToast: () => {},
    dismissToasts: () => {},
    expireToasts: () => {},
    refreshActiveToastExpiry: () => {},
  } satisfies TuiStore;
  return {
    getState: () => state,
    getInitialState: () => state,
    subscribe: () => () => {},
    setState: () => {},
    destroy: () => {},
  } as StoreApi<TuiStore>;
}

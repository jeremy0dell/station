import { describe, expect, it } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { createStationStore } from "./state/store.js";
import { StationToast } from "./StationToast.js";

describe("StationToast", () => {
  it("renders the active toast message", async () => {
    const store = createStationStore();
    store.actions.showToast("Copied 5 chars");
    const setup = await testRender(<StationToast store={store} />, { width: 40, height: 10 });
    try {
      await setup.flush();
      expect(setup.captureCharFrame()).toContain("Copied 5 chars");
    } finally {
      setup.renderer.destroy();
    }
  });

  it("renders nothing when there is no toast", async () => {
    const store = createStationStore();
    const setup = await testRender(<StationToast store={store} />, { width: 40, height: 10 });
    try {
      await setup.flush();
      expect(setup.captureCharFrame()).not.toContain("Copied");
    } finally {
      setup.renderer.destroy();
    }
  });
});

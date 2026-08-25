import { describe, expect, it } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { nativeStationTheme, StationThemeProvider } from "./theme/index.js";
import { createStationStore } from "./state/store.js";
import { StationToast } from "./StationToast.js";

describe("StationToast", () => {
  it("renders the active toast message", async () => {
    const store = createStationStore();
    store.actions.showToast("Copied 5 chars");
    const setup = await testRender(
      <StationThemeProvider theme={nativeStationTheme}>
        <StationToast store={store} />
      </StationThemeProvider>,
      { width: 40, height: 10 },
    );
    try {
      await setup.flush();
      expect(setup.captureCharFrame()).toContain("Copied 5 chars");
    } finally {
      setup.renderer.destroy();
    }
  });

  it("renders nothing when there is no toast", async () => {
    const store = createStationStore();
    const setup = await testRender(
      <StationThemeProvider theme={nativeStationTheme}>
        <StationToast store={store} />
      </StationThemeProvider>,
      { width: 40, height: 10 },
    );
    try {
      await setup.flush();
      expect(setup.captureCharFrame()).not.toContain("Copied");
    } finally {
      setup.renderer.destroy();
    }
  });

  it("wraps a long notice inside a narrow app canvas", async () => {
    const store = createStationStore();
    store.actions.showToast(
      "Copied a long semantic selection while the native shell remained visible underneath",
    );
    const setup = await testRender(
      <StationThemeProvider theme={nativeStationTheme}>
        <StationToast store={store} />
      </StationThemeProvider>,
      { width: 20, height: 6 },
    );
    try {
      await setup.flush();
      const surface = setup.renderer.root.findDescendantById("station-app-toast");
      expect(surface).toBeDefined();
      expect(surface?.x).toBeGreaterThanOrEqual(0);
      expect(surface?.width).toBeLessThanOrEqual(18);
      expect(surface?.height).toBeGreaterThan(1);
      expect((surface?.y ?? 6) + (surface?.height ?? 0)).toBeLessThanOrEqual(5);
    } finally {
      setup.renderer.destroy();
    }
  });
});

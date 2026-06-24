import { describe, expect, it } from "bun:test";
import { createStationStore } from "../state/store.js";
import { focusedPaneAcceptsModifiedEnter } from "./modifiedEnterPolicy.js";
import type { PtyRegistryView } from "../terminal/registry/ptyRegistry.js";

const negotiatedRegistry = {
  get: () => ({
    screen: { isKittyKeyboardEnabled: () => true },
  }),
} as unknown as PtyRegistryView;

describe("focusedPaneAcceptsModifiedEnter", () => {
  it("accepts panes that negotiated kitty keyboard protocol", () => {
    const store = createStationStore();

    expect(focusedPaneAcceptsModifiedEnter(store.getState(), negotiatedRegistry)).toBe(true);
  });

  it("limits warm-attach fallback to capable primary-agent panes", () => {
    const store = createStationStore();
    store.actions.createPane("agent");
    store.actions.setPrimaryAgent("agent", {
      sessionId: "ses-1",
      terminalTargetId: "native:wt-1",
      harnessProvider: "codex",
    });

    expect(focusedPaneAcceptsModifiedEnter(store.getState(), undefined, (provider) => provider === "codex")).toBe(
      true,
    );

    store.actions.setPrimaryAgent("agent", {
      sessionId: "ses-1",
      terminalTargetId: "native:wt-1",
      harnessProvider: "opencode",
    });

    expect(focusedPaneAcceptsModifiedEnter(store.getState(), undefined, (provider) => provider === "codex")).toBe(
      false,
    );
  });
});

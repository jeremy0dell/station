import type { TuiKey, TuiStore } from "@station/dashboard-core";
import { describe, expect, it } from "bun:test";
import type { StoreApi } from "zustand/vanilla";
import { createDashboardSequenceHandler } from "./inputBridge.js";

function harness(): { handle: (sequence: string) => boolean; keys: TuiKey[] } {
  const keys: TuiKey[] = [];
  const store = {
    getState: () => ({
      handleKey: (key: TuiKey) => {
        keys.push(key);
        return { dismissPopup: false };
      },
    }),
  } as unknown as StoreApi<TuiStore>;
  return { handle: createDashboardSequenceHandler(store), keys };
}

describe("createDashboardSequenceHandler", () => {
  it("dispatches printable keys, Enter, and arrows", () => {
    const { handle, keys } = harness();
    expect(handle("5")).toBe(true);
    expect(handle("\r")).toBe(true);
    expect(handle("\x1b[A")).toBe(true);
    expect(keys).toEqual([
      { input: "5" },
      { input: "\r", return: true },
      { input: "", upArrow: true },
    ]);
  });

  it("swallows terminal query replies without dispatching", () => {
    const { handle, keys } = harness();
    expect(handle("\x1b[1;1R")).toBe(true); // cursor position report
    expect(keys).toEqual([]);
  });

  it("swallows sequences the dashboard has no vocabulary for", () => {
    const { handle, keys } = harness();
    expect(handle("\x1b[Z")).toBe(true); // Shift-Tab: no dashboard binding
    expect(keys).toEqual([]);
  });
});

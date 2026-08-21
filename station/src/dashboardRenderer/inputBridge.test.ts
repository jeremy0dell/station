import type { TuiKey } from "@station/dashboard-core/state";
import { describe, expect, it } from "bun:test";
import { createDashboardSequenceHandler } from "./inputBridge.js";

function harness(): { handle: (sequence: string) => boolean; keys: TuiKey[] } {
  const keys: TuiKey[] = [];
  const store = {
    actions: {
      handleKey: (key: TuiKey): void => {
        keys.push(key);
      },
    },
  };
  return { handle: createDashboardSequenceHandler(store), keys };
}

describe("createDashboardSequenceHandler", () => {
  it("dispatches printable keys, Enter, and arrows", () => {
    const { handle, keys } = harness();
    expect(handle("5")).toBe(true);
    expect(handle("X")).toBe(true);
    expect(handle("\r")).toBe(true);
    expect(handle("\x1b[A")).toBe(true);
    expect(handle("\x1b[C")).toBe(true);
    expect(keys).toEqual([
      { input: "5" },
      { input: "X" },
      { input: "\r", return: true },
      { input: "", upArrow: true },
      { input: "", rightArrow: true },
    ]);
  });

  it("swallows terminal query replies without dispatching", () => {
    const { handle, keys } = harness();
    expect(handle("\x1b[1;1R")).toBe(true);
    expect(keys).toEqual([]);
  });

  it("swallows sequences the dashboard has no vocabulary for", () => {
    const { handle, keys } = harness();
    expect(handle("\x1b[Z")).toBe(true);
    expect(keys).toEqual([]);
  });
});

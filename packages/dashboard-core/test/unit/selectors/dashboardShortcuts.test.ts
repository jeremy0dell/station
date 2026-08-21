import { describe, expect, it } from "vitest";
import {
  DASHBOARD_SHORTCUT_LIMIT,
  dashboardShortcutChoices,
  dashboardShortcutCode,
  dashboardShortcutInputChunk,
  dashboardShortcutValue,
} from "../../../src/selectors/dashboardShortcuts.js";

describe("dashboard logical shortcuts", () => {
  it("assigns lowercase one-based base-36 codes through zz", () => {
    expect([
      dashboardShortcutCode(0),
      dashboardShortcutCode(8),
      dashboardShortcutCode(9),
      dashboardShortcutCode(34),
      dashboardShortcutCode(35),
      dashboardShortcutCode(36),
      dashboardShortcutCode(1_294),
    ]).toEqual(["1", "9", "a", "z", "10", "11", "zz"]);
  });

  it("caps the registry at 1,295 without the one-key picker cap", () => {
    const choices = dashboardShortcutChoices(
      Array.from({ length: DASHBOARD_SHORTCUT_LIMIT + 1 }, (_, index) => index),
    );

    expect(choices).toHaveLength(DASHBOARD_SHORTCUT_LIMIT);
    expect(choices[35]).toEqual({ key: "10", value: 35 });
    expect(choices.at(-1)).toEqual({ key: "zz", value: 1_294 });
    expect(dashboardShortcutValue(choices, "11")).toBe(36);
    expect(dashboardShortcutValue(choices, "a")).toBe(9);
  });

  it("normalizes only alphanumeric typed or pasted chunks", () => {
    expect(dashboardShortcutInputChunk("1Z")).toBe("1z");
    expect(dashboardShortcutInputChunk("-")).toBeUndefined();
    expect(dashboardShortcutInputChunk("")).toBeUndefined();
  });

  it("rejects invalid shortcut positions", () => {
    expect(() => dashboardShortcutCode(-1)).toThrow("integer from 0 through 1294");
    expect(() => dashboardShortcutCode(1_295)).toThrow("integer from 0 through 1294");
    expect(() => dashboardShortcutCode(Number.MAX_SAFE_INTEGER + 1)).toThrow("integer from 0");
  });
});

import { describe, expect, it } from "vitest";
import {
  DASHBOARD_SHORTCUT_LIMIT,
  dashboardShortcutChoices,
  dashboardShortcutCode,
  dashboardShortcutInputChunk,
  dashboardShortcutValue,
  isDashboardShortcutCode,
} from "../../../src/selectors/dashboardShortcuts.js";

describe("dashboard logical shortcuts", () => {
  it("assigns lowercase bijective base-35 codes through zzz without zero", () => {
    expect([
      dashboardShortcutCode(0),
      dashboardShortcutCode(8),
      dashboardShortcutCode(9),
      dashboardShortcutCode(34),
      dashboardShortcutCode(35),
      dashboardShortcutCode(36),
      dashboardShortcutCode(69),
      dashboardShortcutCode(70),
      dashboardShortcutCode(349),
      dashboardShortcutCode(350),
      dashboardShortcutCode(1_259),
      dashboardShortcutCode(1_260),
      dashboardShortcutCode(44_134),
    ]).toEqual(["1", "9", "a", "z", "11", "12", "1z", "21", "9z", "a1", "zz", "111", "zzz"]);
  });

  it("caps the registry at 44,135 without the one-key picker cap", () => {
    const choices = dashboardShortcutChoices(
      Array.from({ length: DASHBOARD_SHORTCUT_LIMIT + 1 }, (_, index) => index),
    );

    expect(choices).toHaveLength(DASHBOARD_SHORTCUT_LIMIT);
    expect(choices[35]).toEqual({ key: "11", value: 35 });
    expect(choices.at(-1)).toEqual({ key: "zzz", value: 44_134 });
    expect(dashboardShortcutValue(choices, "11")).toBe(35);
    expect(dashboardShortcutValue(choices, "a")).toBe(9);
    expect(dashboardShortcutValue(choices, "A")).toBeUndefined();
  });

  it("preserves command case while rejecting zero and punctuation", () => {
    expect(dashboardShortcutInputChunk("1Z")).toBe("1Z");
    expect(dashboardShortcutInputChunk("0")).toBeUndefined();
    expect(dashboardShortcutInputChunk("-")).toBeUndefined();
    expect(dashboardShortcutInputChunk("")).toBeUndefined();
    expect(isDashboardShortcutCode("zzz")).toBe(true);
    expect(isDashboardShortcutCode("Z")).toBe(false);
    expect(isDashboardShortcutCode("10")).toBe(false);
  });

  it("rejects invalid shortcut positions", () => {
    expect(() => dashboardShortcutCode(-1)).toThrow("integer from 0 through 44134");
    expect(() => dashboardShortcutCode(44_135)).toThrow("integer from 0 through 44134");
    expect(() => dashboardShortcutCode(Number.MAX_SAFE_INTEGER + 1)).toThrow("integer from 0");
  });
});

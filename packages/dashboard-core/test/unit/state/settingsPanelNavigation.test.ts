import { describe, expect, it } from "vitest";
import { resolveSettingsPanelListIntent } from "../../../src/state/settingsPanelNavigation.js";

const ITEMS = [
  { id: "general", shortcut: "G" },
  { id: "sessions", shortcut: "S" },
  { id: "remove", shortcut: "R" },
] as const;

describe("settings panel list navigation", () => {
  it("moves through items and remains inert at either bound", () => {
    expect(
      resolveSettingsPanelListIntent(
        ITEMS,
        "general",
        { input: "", downArrow: true },
        {
          closeOnLeft: true,
        },
      ),
    ).toEqual({ type: "select", itemId: "sessions" });
    expect(
      resolveSettingsPanelListIntent(
        ITEMS,
        "general",
        { input: "", upArrow: true },
        {
          closeOnLeft: true,
        },
      ),
    ).toEqual({ type: "none" });
    expect(
      resolveSettingsPanelListIntent(
        ITEMS,
        "remove",
        { input: "", downArrow: true },
        {
          closeOnLeft: true,
        },
      ),
    ).toEqual({ type: "none" });
  });

  it("selects a different item by shortcut without reselecting the active item", () => {
    expect(
      resolveSettingsPanelListIntent(ITEMS, "general", { input: "S" }, { closeOnLeft: true }),
    ).toEqual({ type: "select", itemId: "sessions" });
    expect(
      resolveSettingsPanelListIntent(ITEMS, "general", { input: "G" }, { closeOnLeft: true }),
    ).toEqual({ type: "none" });
  });

  it("opens detail on Right or Enter", () => {
    expect(
      resolveSettingsPanelListIntent(
        ITEMS,
        "general",
        { input: "", rightArrow: true },
        {
          closeOnLeft: true,
        },
      ),
    ).toEqual({ type: "openDetail" });
    expect(
      resolveSettingsPanelListIntent(
        ITEMS,
        "general",
        { input: "\r", return: true },
        { closeOnLeft: true },
      ),
    ).toEqual({ type: "openDetail" });
  });

  it("always closes on Escape and applies the feature-owned Left policy", () => {
    expect(
      resolveSettingsPanelListIntent(
        ITEMS,
        "general",
        { input: "", escape: true },
        {
          closeOnLeft: false,
        },
      ),
    ).toEqual({ type: "close" });
    expect(
      resolveSettingsPanelListIntent(
        ITEMS,
        "general",
        { input: "", leftArrow: true },
        {
          closeOnLeft: true,
        },
      ),
    ).toEqual({ type: "close" });
    expect(
      resolveSettingsPanelListIntent(
        ITEMS,
        "general",
        { input: "", leftArrow: true },
        {
          closeOnLeft: false,
        },
      ),
    ).toEqual({ type: "none" });
  });
});

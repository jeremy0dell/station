import { describe, expect, it } from "vitest";
import { createInitialTuiState } from "../../../src/state/screen.js";
import {
  handleWidgetSettingsKey,
  openWidgetSettings,
  widgetSettingsRemoveAt,
  widgetSettingsRowLabel,
} from "../../../src/state/screens/widgetSettings.js";
import type { TuiState } from "../../../src/state/types.js";

function panelState(): TuiState {
  return openWidgetSettings(
    createInitialTuiState({
      widgets: [{ type: "time" }, { type: "fleet", enabled: false }, { type: "moon" }],
    }),
  );
}

function screenOf(state: TuiState) {
  if (state.screen.name !== "widgetSettings") {
    throw new Error("expected the widgetSettings screen");
  }
  return state.screen;
}

describe("widgetSettings screen", () => {
  it("toggles enabled by removing the key when re-enabling", () => {
    const off = handleWidgetSettingsKey(panelState(), { input: "\r", return: true }).state;
    expect(off.widgets[0]).toEqual({ type: "time", enabled: false });

    const backOn = handleWidgetSettingsKey(off, { input: " " }).state;
    // On round-trips to the exact config shape (no enabled key), not enabled: true.
    expect(backOn.widgets[0]).toEqual({ type: "time" });
    expect("enabled" in (backOn.widgets[0] ?? {})).toBe(false);
  });

  it("reorders with [ and ], cursor following the moved widget", () => {
    const down = handleWidgetSettingsKey(panelState(), { input: "]" }).state;
    expect(down.widgets.map((widget) => widget.type)).toEqual(["fleet", "time", "moon"]);
    expect(screenOf(down).cursor).toBe(1);

    const up = handleWidgetSettingsKey(down, { input: "[" }).state;
    expect(up.widgets.map((widget) => widget.type)).toEqual(["time", "fleet", "moon"]);
    expect(screenOf(up).cursor).toBe(0);

    // At the top, [ is a no-op.
    expect(handleWidgetSettingsKey(up, { input: "[" }).state).toBe(up);
  });

  it("removes at the cursor and clamps it to the shorter list", () => {
    let state = panelState();
    state = handleWidgetSettingsKey(state, { input: "", downArrow: true }).state;
    state = handleWidgetSettingsKey(state, { input: "", downArrow: true }).state;
    state = handleWidgetSettingsKey(state, { input: "x" }).state;
    expect(state.widgets.map((widget) => widget.type)).toEqual(["time", "fleet"]);
    expect(screenOf(state).cursor).toBe(1);
  });

  it("mouse-removing a row above the cursor keeps the cursor on its widget", () => {
    let state = panelState();
    state = handleWidgetSettingsKey(state, { input: "", downArrow: true }).state;
    state = handleWidgetSettingsKey(state, { input: "", downArrow: true }).state;
    state = widgetSettingsRemoveAt(state, 0);
    expect(state.widgets.map((widget) => widget.type)).toEqual(["fleet", "moon"]);
    expect(screenOf(state).cursor).toBe(1);
  });

  it("adds a parameterless widget from the picker and lands the cursor on it", () => {
    let state = handleWidgetSettingsKey(panelState(), { input: "a" }).state;
    expect(screenOf(state).focus).toBe("picker");
    state = handleWidgetSettingsKey(state, { input: "", downArrow: true }).state;
    state = handleWidgetSettingsKey(state, { input: "\r", return: true }).state;
    expect(screenOf(state).focus).toBe("list");
    expect(state.widgets.at(-1)).toEqual({ type: "fleet" });
    expect(screenOf(state).cursor).toBe(3);
  });

  it("escape closes the picker first, then the panel", () => {
    let state = handleWidgetSettingsKey(panelState(), { input: "a" }).state;
    state = handleWidgetSettingsKey(state, { input: "", escape: true }).state;
    expect(screenOf(state).focus).toBe("list");
    state = handleWidgetSettingsKey(state, { input: "", escape: true }).state;
    expect(state.screen.name).toBe("dashboard");
  });

  it("labels rows from their config", () => {
    expect(widgetSettingsRowLabel({ type: "weather", city: "New York, NY" })).toBe(
      "weather New York, NY",
    );
    expect(
      widgetSettingsRowLabel({
        type: "tz",
        zones: [
          { label: "NYC", timeZone: "America/New_York" },
          { label: "TYO", timeZone: "Asia/Tokyo" },
        ],
      }),
    ).toBe("tz NYC/TYO");
    expect(widgetSettingsRowLabel({ type: "prs" })).toBe("open PRs");
  });
});

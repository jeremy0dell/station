import type { TuiWidgetConfig } from "@station/config";
import type { TuiKey } from "../keys.js";
import { isReturnKey } from "../keys.js";
import type { TuiTransition } from "../transition.js";
import type { TuiState } from "../types.js";

/**
 * Widget types addable from the picker: the parameterless ones only. AQI,
 * weather, and tz need config fields (city, zones), so they are added in config.toml
 * and managed (toggle/reorder/remove) here like any other entry.
 */
export const ADDABLE_WIDGET_TYPES = ["time", "fleet", "prs", "moon"] as const;

export type AddableWidgetType = (typeof ADDABLE_WIDGET_TYPES)[number];

/** One human label per widget entry, shown in the settings list. */
export function widgetSettingsRowLabel(config: TuiWidgetConfig): string {
  switch (config.type) {
    case "time":
      return "time";
    case "weather":
      return `weather ${config.label ?? config.city}`;
    case "aqi":
      return `AQI ${config.label ?? config.city}`;
    case "fleet":
      return "fleet";
    case "prs":
      return "open PRs";
    case "tz":
      return `tz ${config.zones.map((zone) => zone.label).join("/")}`;
    case "moon":
      return "moon";
  }
}

export function openWidgetSettings(state: TuiState): TuiState {
  return {
    ...state,
    screen: { name: "widgetSettings", focus: "list", cursor: 0, pickerCursor: 0 },
  };
}

/** Mouse path: toggle the clicked row and move the cursor onto it. */
export function widgetSettingsToggleAt(state: TuiState, index: number): TuiState {
  const screen = state.screen;
  if (screen.name !== "widgetSettings" || index < 0 || index >= state.widgets.length) {
    return state;
  }
  return withScreen(
    { ...state, widgets: toggleWidgetEnabled(state.widgets, index) },
    { ...screen, focus: "list", cursor: index },
  );
}

/** Mouse path: remove the clicked row; the cursor follows the widget it was on
 * (rows above it shift up by one), clamping only when the cursor row itself went away. */
export function widgetSettingsRemoveAt(state: TuiState, index: number): TuiState {
  const screen = state.screen;
  if (screen.name !== "widgetSettings" || index < 0 || index >= state.widgets.length) {
    return state;
  }
  const widgets = state.widgets.filter((_, i) => i !== index);
  return withScreen(
    { ...state, widgets },
    {
      ...screen,
      focus: "list",
      cursor: clampCursor(
        index < screen.cursor ? screen.cursor - 1 : screen.cursor,
        widgets.length,
      ),
    },
  );
}

/** Mouse path: open the add-widget picker. */
export function widgetSettingsOpenPicker(state: TuiState): TuiState {
  const screen = state.screen;
  if (screen.name !== "widgetSettings") {
    return state;
  }
  return withScreen(state, { ...screen, focus: "picker", pickerCursor: 0 });
}

/** Mouse path: add the clicked picker choice and land the cursor on it. */
export function widgetSettingsAddFromPicker(state: TuiState, pickerIndex: number): TuiState {
  const screen = state.screen;
  if (screen.name !== "widgetSettings") {
    return state;
  }
  const type = ADDABLE_WIDGET_TYPES[pickerIndex];
  if (type === undefined) {
    return state;
  }
  const widgets = [...state.widgets, { type }];
  return withScreen(
    { ...state, widgets },
    { ...screen, focus: "list", cursor: widgets.length - 1 },
  );
}

export function handleWidgetSettingsKey(state: TuiState, key: TuiKey): TuiTransition {
  const screen = state.screen;
  if (screen.name !== "widgetSettings") {
    return { state };
  }
  // No ctrl chords on this screen; a modified char must not act as its plain form.
  if (key.ctrl === true) {
    return { state };
  }
  if (screen.focus === "picker") {
    return handlePickerKey(state, screen, key);
  }
  return handleListKey(state, screen, key);
}

type WidgetSettingsScreen = Extract<TuiState["screen"], { name: "widgetSettings" }>;

function handleListKey(state: TuiState, screen: WidgetSettingsScreen, key: TuiKey): TuiTransition {
  const widgets = state.widgets;
  const cursor = clampCursor(screen.cursor, widgets.length);
  if (key.escape === true) {
    return { state: { ...state, screen: { name: "dashboard" } } };
  }
  if (key.upArrow === true) {
    return { state: withScreen(state, { ...screen, cursor: Math.max(0, cursor - 1) }) };
  }
  if (key.downArrow === true) {
    return {
      state: withScreen(state, {
        ...screen,
        cursor: clampCursor(cursor + 1, widgets.length),
      }),
    };
  }
  if (key.input === "a") {
    return { state: withScreen(state, { ...screen, focus: "picker", pickerCursor: 0 }) };
  }
  if (widgets.length === 0) {
    return { state };
  }
  if (isReturnKey(key) || key.input === " ") {
    return {
      state: withScreen(
        { ...state, widgets: toggleWidgetEnabled(widgets, cursor) },
        { ...screen, cursor },
      ),
    };
  }
  if (key.input === "[" || key.input === "]") {
    const delta = key.input === "[" ? -1 : 1;
    const target = cursor + delta;
    if (target < 0 || target >= widgets.length) {
      return { state };
    }
    return {
      state: withScreen(
        { ...state, widgets: swapWidgets(widgets, cursor, target) },
        { ...screen, cursor: target },
      ),
    };
  }
  if (key.input === "x") {
    const next = widgets.filter((_, index) => index !== cursor);
    return {
      state: withScreen(
        { ...state, widgets: next },
        { ...screen, cursor: clampCursor(cursor, next.length) },
      ),
    };
  }
  return { state };
}

function handlePickerKey(
  state: TuiState,
  screen: WidgetSettingsScreen,
  key: TuiKey,
): TuiTransition {
  if (key.escape === true) {
    return { state: withScreen(state, { ...screen, focus: "list" }) };
  }
  if (key.upArrow === true) {
    return {
      state: withScreen(state, { ...screen, pickerCursor: Math.max(0, screen.pickerCursor - 1) }),
    };
  }
  if (key.downArrow === true) {
    return {
      state: withScreen(state, {
        ...screen,
        pickerCursor: Math.min(ADDABLE_WIDGET_TYPES.length - 1, screen.pickerCursor + 1),
      }),
    };
  }
  if (isReturnKey(key)) {
    const type = ADDABLE_WIDGET_TYPES[screen.pickerCursor];
    if (type === undefined) {
      return { state: withScreen(state, { ...screen, focus: "list" }) };
    }
    const widgets = [...state.widgets, { type }];
    return {
      state: withScreen(
        { ...state, widgets },
        { ...screen, focus: "list", cursor: widgets.length - 1 },
      ),
    };
  }
  return { state };
}

function withScreen(state: TuiState, screen: WidgetSettingsScreen): TuiState {
  return { ...state, screen };
}

function clampCursor(cursor: number, length: number): number {
  return Math.max(0, Math.min(cursor, length - 1));
}

// On = the key is absent (default), so a session toggle round-trips to the
// exact shape config.toml would have produced.
function toggleWidgetEnabled(
  widgets: readonly TuiWidgetConfig[],
  index: number,
): readonly TuiWidgetConfig[] {
  return widgets.map((widget, i) => {
    if (i !== index) {
      return widget;
    }
    if (widget.enabled === false) {
      const { enabled, ...rest } = widget;
      return rest as TuiWidgetConfig;
    }
    return { ...widget, enabled: false };
  });
}

function swapWidgets(
  widgets: readonly TuiWidgetConfig[],
  a: number,
  b: number,
): readonly TuiWidgetConfig[] {
  const next = [...widgets];
  const left = next[a];
  const right = next[b];
  if (left === undefined || right === undefined) {
    return widgets;
  }
  next[a] = right;
  next[b] = left;
  return next;
}

import type { TuiWidgetConfig } from "@station/contracts";
import type { TuiKey } from "../keys.js";
import { isReturnKey } from "../keys.js";
import type { ReadonlyDeep } from "../readonly.js";
import type { TuiTransition } from "../transition.js";
import type { AddableWidgetType, DashboardState, WidgetSettingsItemId } from "../types.js";

export const widgetSettingsScreenBehavior = {
  dashboardHoverEnabled: false,
  clickAway: backFromWidgetSettings,
};

/**
 * Widget types addable from the picker: the parameterless ones only. weather
 * and tz need config fields (city, zones), so they are added in config.toml
 * and managed (toggle/reorder/remove) here like any other entry.
 */
export const ADDABLE_WIDGET_TYPES = [
  "time",
  "fleet",
  "prs",
  "moon",
] as const satisfies readonly AddableWidgetType[];

/** One human label per widget entry, shown in the settings list. */
export function widgetSettingsRowLabel(config: ReadonlyDeep<TuiWidgetConfig>): string {
  switch (config.type) {
    case "time":
      return "time";
    case "weather":
      return `weather ${config.label ?? config.city}`;
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

export function openWidgetSettings(state: DashboardState): DashboardState {
  const widgetItemIds = state.widgets.map((_, index) => widgetItemId(index));
  const activeWidgetItemId = widgetItemIds[0];
  return {
    ...state,
    screen: {
      name: "widgetSettings",
      focus: "list",
      widgetItemIds,
      ...(activeWidgetItemId === undefined ? {} : { activeWidgetItemId }),
      activePickerType: ADDABLE_WIDGET_TYPES[0],
      nextWidgetIdentity: widgetItemIds.length,
    },
  };
}

/** Pointer path: toggle the clicked semantic item and focus that same identity. */
export function widgetSettingsToggleItem(
  state: DashboardState,
  itemId: WidgetSettingsItemId,
): DashboardState {
  const screen = state.screen;
  if (screen.name !== "widgetSettings") {
    return state;
  }
  const index = screen.widgetItemIds.indexOf(itemId);
  if (index < 0 || index >= state.widgets.length) return state;
  return withScreen(
    { ...state, widgets: toggleWidgetEnabled(state.widgets, index) },
    { ...screen, focus: "list", activeWidgetItemId: itemId },
  );
}

/** Pointer path: remove one semantic item while retaining any surviving focus identity. */
export function widgetSettingsRemoveItem(
  state: DashboardState,
  itemId: WidgetSettingsItemId,
): DashboardState {
  const screen = state.screen;
  if (screen.name !== "widgetSettings") {
    return state;
  }
  const index = screen.widgetItemIds.indexOf(itemId);
  if (index < 0 || index >= state.widgets.length) return state;
  const widgets = state.widgets.filter((_, i) => i !== index);
  const widgetItemIds = screen.widgetItemIds.filter((candidate) => candidate !== itemId);
  const activeWidgetItemId =
    screen.activeWidgetItemId === itemId
      ? (widgetItemIds[index] ?? widgetItemIds.at(-1))
      : screen.activeWidgetItemId;
  return withScreen(
    { ...state, widgets },
    widgetSettingsScreen(screen, {
      focus: "list",
      widgetItemIds,
      activeWidgetItemId,
    }),
  );
}

/** Pointer path: open the add-widget picker. */
export function widgetSettingsOpenPicker(state: DashboardState): DashboardState {
  const screen = state.screen;
  if (screen.name !== "widgetSettings") {
    return state;
  }
  return withScreen(state, {
    ...screen,
    focus: "picker",
    activePickerType: ADDABLE_WIDGET_TYPES[0],
  });
}

/** Pointer path: add the clicked picker choice and focus its new identity. */
export function widgetSettingsAddType(
  state: DashboardState,
  widgetType: AddableWidgetType,
): DashboardState {
  const screen = state.screen;
  if (screen.name !== "widgetSettings") {
    return state;
  }
  if (!ADDABLE_WIDGET_TYPES.includes(widgetType)) return state;
  const widgets = [...state.widgets, { type: widgetType }];
  const itemId = widgetItemId(screen.nextWidgetIdentity);
  return withScreen(
    { ...state, widgets },
    {
      ...screen,
      focus: "list",
      widgetItemIds: [...screen.widgetItemIds, itemId],
      activeWidgetItemId: itemId,
      activePickerType: widgetType,
      nextWidgetIdentity: screen.nextWidgetIdentity + 1,
    },
  );
}

export function handleWidgetSettingsKey(state: DashboardState, key: TuiKey): TuiTransition {
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

type WidgetSettingsScreen = Extract<DashboardState["screen"], { name: "widgetSettings" }>;

function handleListKey(
  state: DashboardState,
  screen: WidgetSettingsScreen,
  key: TuiKey,
): TuiTransition {
  const widgets = state.widgets;
  const activeIndex = activeWidgetIndex(screen);
  if (key.escape === true) {
    return { state: closeWidgetSettings(state) };
  }
  if (key.upArrow === true) {
    return { state: focusWidgetAt(state, Math.max(0, activeIndex - 1)) };
  }
  if (key.downArrow === true) {
    return { state: focusWidgetAt(state, Math.min(widgets.length - 1, activeIndex + 1)) };
  }
  if (key.input === "a") {
    return { state: widgetSettingsOpenPicker(state) };
  }
  if (widgets.length === 0) {
    return { state };
  }
  if (isReturnKey(key) || key.input === " ") {
    const itemId = screen.widgetItemIds[activeIndex];
    return { state: itemId === undefined ? state : widgetSettingsToggleItem(state, itemId) };
  }
  if (key.input === "[" || key.input === "]") {
    const delta = key.input === "[" ? -1 : 1;
    const target = activeIndex + delta;
    if (target < 0 || target >= widgets.length) {
      return { state };
    }
    return {
      state: withScreen(
        { ...state, widgets: swapItems(widgets, activeIndex, target) },
        { ...screen, widgetItemIds: swapItems(screen.widgetItemIds, activeIndex, target) },
      ),
    };
  }
  if (key.input === "x") {
    const itemId = screen.widgetItemIds[activeIndex];
    return { state: itemId === undefined ? state : widgetSettingsRemoveItem(state, itemId) };
  }
  return { state };
}

function handlePickerKey(
  state: DashboardState,
  screen: WidgetSettingsScreen,
  key: TuiKey,
): TuiTransition {
  if (key.escape === true) {
    return { state: backFromWidgetSettings(state) };
  }
  if (key.upArrow === true) {
    const pickerIndex = ADDABLE_WIDGET_TYPES.indexOf(screen.activePickerType);
    return {
      state: withScreen(state, {
        ...screen,
        activePickerType:
          ADDABLE_WIDGET_TYPES[Math.max(0, pickerIndex - 1)] ?? ADDABLE_WIDGET_TYPES[0],
      }),
    };
  }
  if (key.downArrow === true) {
    const pickerIndex = ADDABLE_WIDGET_TYPES.indexOf(screen.activePickerType);
    return {
      state: withScreen(state, {
        ...screen,
        activePickerType:
          ADDABLE_WIDGET_TYPES[Math.min(ADDABLE_WIDGET_TYPES.length - 1, pickerIndex + 1)] ??
          ADDABLE_WIDGET_TYPES[0],
      }),
    };
  }
  if (isReturnKey(key)) {
    return { state: widgetSettingsAddType(state, screen.activePickerType) };
  }
  return { state };
}

function withScreen(state: DashboardState, screen: WidgetSettingsScreen): DashboardState {
  return { ...state, screen };
}

function backFromWidgetSettings(state: DashboardState): DashboardState {
  if (state.screen.name !== "widgetSettings") {
    return state;
  }
  return state.screen.focus === "picker"
    ? withScreen(state, { ...state.screen, focus: "list" })
    : closeWidgetSettings(state);
}

function closeWidgetSettings(state: DashboardState): DashboardState {
  return { ...state, screen: { name: "dashboard" } };
}

function widgetItemId(identity: number): WidgetSettingsItemId {
  return `widget:${identity}`;
}

function activeWidgetIndex(screen: WidgetSettingsScreen): number {
  const index =
    screen.activeWidgetItemId === undefined
      ? -1
      : screen.widgetItemIds.indexOf(screen.activeWidgetItemId);
  return Math.max(0, index);
}

function focusWidgetAt(state: DashboardState, index: number): DashboardState {
  if (state.screen.name !== "widgetSettings") return state;
  const activeWidgetItemId = state.screen.widgetItemIds[index];
  if (activeWidgetItemId === undefined || activeWidgetItemId === state.screen.activeWidgetItemId) {
    return state;
  }
  return withScreen(state, { ...state.screen, activeWidgetItemId });
}

function widgetSettingsScreen(
  screen: WidgetSettingsScreen,
  input: {
    focus: "list";
    widgetItemIds: readonly WidgetSettingsItemId[];
    activeWidgetItemId: WidgetSettingsItemId | undefined;
  },
): WidgetSettingsScreen {
  const { activeWidgetItemId: _removed, ...withoutActive } = screen;
  return {
    ...withoutActive,
    focus: input.focus,
    widgetItemIds: input.widgetItemIds,
    ...(input.activeWidgetItemId === undefined
      ? {}
      : { activeWidgetItemId: input.activeWidgetItemId }),
  };
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

function swapItems<T>(items: readonly T[], a: number, b: number): readonly T[] {
  const next = [...items];
  const left = next[a];
  const right = next[b];
  if (left === undefined || right === undefined) {
    return items;
  }
  next[a] = right;
  next[b] = left;
  return next;
}

/**
 * Role entrypoint: top-row widgets.
 *
 * Widget config shapes (owned by @station/contracts), widget resolution,
 * and the widget hook runtime. Individual widget renderers stay package
 * internal.
 */

export { resolveTopRowWidgets } from "../widgets/snapshotWidgets.js";
export type {
  SnapshotWidgetKind,
  TimeWidgetRuntime,
  TopRowWidgetRuntimeDeps,
  TopRowWidgetView,
  TuiConfig,
  TuiIslandConfig,
  TuiWidgetConfig,
  WeatherClient,
  WeatherCurrentConditions,
  WeatherTemperatureUnit,
} from "../widgets/types.js";
export type { TopRowWidgetHookRuntime } from "../widgets/useTopRowWidgets.js";
export { createUseTopRowWidgets, refreshWeatherWidget } from "../widgets/useTopRowWidgets.js";

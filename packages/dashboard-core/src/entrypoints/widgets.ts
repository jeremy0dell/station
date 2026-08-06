/**
 * Role entrypoint: top-row widgets.
 *
 * Widget config shapes (owned by @station/contracts), widget resolution,
 * and the widget hook runtime. Individual widget renderers stay package
 * internal.
 */

export { resolveTopRowWidgets } from "../widgets/snapshotWidgets.js";
export type {
  TopRowWidgetRuntimeDeps,
  TopRowWidgetView,
  TuiConfig,
  TuiIslandConfig,
  TuiWidgetConfig,
} from "../widgets/types.js";
export { createUseTopRowWidgets } from "../widgets/useTopRowWidgets.js";

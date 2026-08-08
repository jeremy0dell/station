import { describe, expect, it } from "vitest";
import * as runtimeEntry from "../../src/entrypoints/runtime.js";
import * as selectorsEntry from "../../src/entrypoints/selectors.js";
import * as stateEntry from "../../src/entrypoints/state.js";
import * as widgetsEntry from "../../src/entrypoints/widgets.js";

// #168 rule 3: private mutable state models never cross the package surface.
const PRIVATE_MODELS = [
  "AddProjectFlowState",
  "DashboardState",
  "NewSessionFlowState",
  "TuiLocalRows",
  "TuiScreen",
  "DashboardState",
  "TuiViewState",
];

const RUNTIME_VALUES = [
  "createDashboardRuntime",
  "createObserverActivationCapabilities",
  "createObserverManagedSessionCapabilities",
  "dashboardExecution",
];

const STATE_VALUES = [
  "createInitialTuiState",
  "createNewSessionFlow",
  "createAddProjectFlow",
  "handleTuiKey",
  "tuiScreenBehavior",
];

const SELECTORS_VALUES = [
  "selectDashboardViewport",
  "selectDashboardSessionRows",
  "selectFleetSummary",
  "dashboardTableHeaderModel",
  "layoutWorktreeRowGrid",
];

const WIDGET_VALUES = ["createUseTopRowWidgets", "resolveTopRowWidgets"];

describe("dashboard-core role entrypoints", () => {
  const entries = [
    ["runtime", runtimeEntry, RUNTIME_VALUES],
    ["state", stateEntry, STATE_VALUES],
    ["selectors", selectorsEntry, SELECTORS_VALUES],
    ["widgets", widgetsEntry, WIDGET_VALUES],
  ] as const;

  for (const [role, entry, expected] of entries) {
    it(`${role} exposes its role contracts`, () => {
      const names = new Set(Object.keys(entry));
      for (const name of expected) {
        expect(names.has(name), `${role} missing ${name}`).toBe(true);
      }
    });

    it(`${role} never exports private mutable state models`, () => {
      const names = Object.keys(entry);
      expect(names.filter((name) => PRIVATE_MODELS.includes(name))).toEqual([]);
    });
  }
});

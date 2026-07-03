import { describe, expect, it } from "bun:test";
import {
  getOrCreateStationHotRuntime,
  STATION_HOT_RUNTIME_VERSION,
  type StationHotRuntime,
  type StationHotSlots,
} from "./stationHotRuntime.js";
import type { WorkspaceConfig } from "../config/stationConfig.js";
import { selectWelcomeCanContinue } from "../state/selectors.js";
import { createStationStore } from "../state/store.js";
import { agentWorktreePaneId } from "../state/types.js";
import { createPtyRegistry } from "../terminal/registry/ptyRegistry.js";
import { createScriptedTerminal } from "../terminal/testing/scriptedTerminal.js";

const FREEZE_CONFIG: WorkspaceConfig = {
  scroll_on_output: "freeze",
  overlay_width_percent: 60,
  overlay_height_percent: 60,
  welcome_on_boot: false,
  automations: [],
};
const FOLLOW_CONFIG: WorkspaceConfig = {
  scroll_on_output: "follow",
  overlay_width_percent: 60,
  overlay_height_percent: 60,
  welcome_on_boot: false,
  automations: [],
};
const INTRO_CONFIG: WorkspaceConfig = {
  scroll_on_output: "freeze",
  overlay_width_percent: 60,
  overlay_height_percent: 60,
  welcome_on_boot: true,
  automations: [],
};

function createSlots(): StationHotSlots {
  return {} as StationHotSlots;
}

describe("station hot runtime", () => {
  it("reuses a compatible runtime so the store and registry survive a reload", () => {
    const slots = createSlots();
    const first = getOrCreateStationHotRuntime(slots, FREEZE_CONFIG);
    first.store.actions.createPane("pane-second");

    // A later boot (even with a changed config) returns the same instances, so
    // the active pane/session and live PTYs persist across the code edit.
    const second = getOrCreateStationHotRuntime(slots, FOLLOW_CONFIG);

    expect(second).toBe(first);
    expect(second.store).toBe(first.store);
    expect(second.registry).toBe(first.registry);
    expect(second.store.getState().workspace.activePaneId).toEqual("pane-second");
  });

  it("reboots an incompatible runtime clean and disposes its old PTYs", () => {
    const slots = createSlots();
    const oldStore = createStationStore();
    const paneId = agentWorktreePaneId("wt_station_idle");
    oldStore.actions.createPane(paneId, { role: "primary-agent" });
    const scripted = createScriptedTerminal();
    const oldRegistry = createPtyRegistry({ createTerminal: () => scripted.terminal });
    oldRegistry.resize(paneId, { cols: 80, rows: 24 });
    const oldRuntime: StationHotRuntime = {
      version: STATION_HOT_RUNTIME_VERSION - 1,
      store: oldStore,
      registry: oldRegistry,
    };
    slots.__stationHotRuntime = oldRuntime;

    const next = getOrCreateStationHotRuntime(slots, FOLLOW_CONFIG);

    expect(next).not.toBe(oldRuntime);
    expect(next.registry).not.toBe(oldRegistry);
    expect(scripted.helpers.isDisposed()).toBe(true);
    // Clean reboot: fresh runtime starts at the welcome screen, not the old pane.
    expect(next.store.getState().workspace.panes).toEqual([]);
    expect(next.store.getState().workspace.activePaneId).toBeNull();
    expect(next.store.getState().input.focus).toEqual({ kind: "welcome" });
  });

  it("treats an empty restore plan as a fresh empty boot", () => {
    const slots = createSlots();

    const next = getOrCreateStationHotRuntime(slots, INTRO_CONFIG, {
      panes: [],
      activePaneId: null,
    });

    expect(next.store.getState().workspace.panes).toEqual([]);
    expect(next.store.getState().workspace.activePaneId).toBeNull();
    expect(next.store.getState().input.focus).toEqual({ kind: "welcome" });
    expect(selectWelcomeCanContinue(next.store.getState())).toBe(false);
  });
});

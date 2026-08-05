import { describe, expect, it } from "bun:test";
import {
  beginStationHotDisposal,
  getOrCreateStationHotRuntime,
  type StationHotRuntime,
  type StationHotSlots,
  waitForStationHotDisposal,
} from "./stationHotRuntime.js";
import type { WorkspaceConfig } from "../config/stationConfig.js";
import { selectWelcomeCanContinue } from "../state/selectors.js";
import { createStationStore } from "../state/store.js";
import { agentWorktreePaneId } from "../state/types.js";
import { createPtyRegistry } from "../terminal/registry/ptyRegistry.js";
import { createScriptedTerminal } from "../terminal/testing/scriptedTerminal.js";

const FREEZE_CONFIG: WorkspaceConfig = {
  scroll_on_output: "freeze",
  scrollback_lines: 10_000,
  overlay_width_percent: 60,
  overlay_height_percent: 60,
  welcome_on_boot: false,
  automations: [],
};
const FOLLOW_CONFIG: WorkspaceConfig = {
  scroll_on_output: "follow",
  scrollback_lines: 10_000,
  overlay_width_percent: 60,
  overlay_height_percent: 60,
  welcome_on_boot: false,
  automations: [],
};
const INTRO_CONFIG: WorkspaceConfig = {
  scroll_on_output: "freeze",
  scrollback_lines: 10_000,
  overlay_width_percent: 60,
  overlay_height_percent: 60,
  welcome_on_boot: true,
  automations: [],
};

function createSlots(): StationHotSlots {
  return {} as StationHotSlots;
}

describe("station hot runtime", () => {
  it("releases renderer ownership before waiting and protects a newer disposal slot", async () => {
    const slots = createSlots();
    const order: string[] = [];
    const oldGate = deferred();
    const newGate = deferred();
    const oldDisposal = beginStationHotDisposal(
      slots,
      () => order.push("release-old"),
      () => oldGate.promise,
    );

    let priorSettled = false;
    void observeSettlement(waitForStationHotDisposal(slots), () => {
      priorSettled = true;
    });
    await Promise.resolve();
    expect(order).toEqual(["release-old"]);
    expect(priorSettled).toBe(false);

    const newDisposal = beginStationHotDisposal(
      slots,
      () => order.push("release-new"),
      () => newGate.promise,
    );
    oldGate.resolve();
    await oldDisposal;
    expect(slots.__stationHotDisposal).toBe(newDisposal);

    newGate.resolve();
    await newDisposal;
    await Promise.resolve();
    expect(slots.__stationHotDisposal).toBeUndefined();
  });

  it("reuses a compatible v6 runtime so its live PTYs survive a reload", () => {
    const slots = createSlots();
    const first = getOrCreateStationHotRuntime(slots, FREEZE_CONFIG);
    first.store.actions.createPane("pane-second");
    const scripted = createScriptedTerminal();
    first.registry.setRuntimeOptions({
      createTerminal: () => scripted.terminal,
      scrollOnOutput: FREEZE_CONFIG.scroll_on_output,
      scrollbackLines: FREEZE_CONFIG.scrollback_lines,
    });
    first.registry.resize("pane-second", { cols: 80, rows: 24 });
    const screen = first.registry.get("pane-second")?.screen;
    const terminal = first.registry.get("pane-second")?.terminal;

    // A later boot (even with a changed config) returns the same instances, so
    // the active pane/session and live PTYs persist across the code edit.
    const second = getOrCreateStationHotRuntime(slots, FOLLOW_CONFIG);

    expect(second).toBe(first);
    expect(second.store).toBe(first.store);
    expect(second.store.transient.managedLaunchesInFlight).toBe(
      first.store.transient.managedLaunchesInFlight,
    );
    expect(second.registry).toBe(first.registry);
    expect(second.registry.get("pane-second")?.screen).toBe(screen);
    expect(second.registry.get("pane-second")?.terminal).toBe(terminal);
    expect(scripted.helpers.isDisposed()).toBe(false);
    expect(second.store.getState().workspace.activePaneId).toEqual("pane-second");
  });

  it("reboots a pre-launch-coordination v5 runtime and disposes its old PTYs", () => {
    const slots = createSlots();
    const oldStore = createStationStore();
    const paneId = agentWorktreePaneId("wt_station_idle");
    oldStore.actions.createPane(paneId, { role: "primary-agent" });
    const scripted = createScriptedTerminal();
    const oldRegistry = createPtyRegistry({ createTerminal: () => scripted.terminal });
    oldRegistry.resize(paneId, { cols: 80, rows: 24 });
    const oldRuntime: StationHotRuntime = {
      version: 5,
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

async function observeSettlement(
  settlement: Promise<void>,
  observe: () => void,
): Promise<void> {
  await settlement;
  observe();
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

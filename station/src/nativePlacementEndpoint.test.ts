import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestNativePlacement } from "@station/terminal";
import { describe, expect, it } from "bun:test";
import { createStationNativePlacementEndpoint } from "./nativePlacementEndpoint.js";
import { createStationStore } from "./state/store.js";
import { MAIN_PANE_ID } from "./state/types.js";
import { createPtyRegistry } from "./terminal/registry/ptyRegistry.js";
import { createScriptedTerminal } from "./terminal/testing/scriptedTerminal.js";

describe("native placement endpoint", () => {
  it("reserves, starts, and exactly releases an inactive sibling pane", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-native-placement-"));
    const source = createScriptedTerminal({ cols: 91, rows: 27 });
    const destination = createScriptedTerminal();
    destination.terminal.kill = () => destination.helpers.emitExit({ exitCode: 0 });
    const terminals = [source.terminal, destination.terminal];
    const spawnSizes: Array<{ cols: number; rows: number }> = [];
    const store = createStationStore();
    const registry = createPtyRegistry({
      createTerminal: (options) => {
        spawnSizes.push({ cols: options.size?.cols ?? 0, rows: options.size?.rows ?? 0 });
        const terminal = terminals.shift();
        if (terminal === undefined) throw new Error("terminal pool exhausted");
        return terminal;
      },
    });
    registry.resize(MAIN_PANE_ID, { cols: 91, rows: 27 });
    const endpoint = await createStationNativePlacementEndpoint({
      stateDir: root,
      uiRunId: "ui-test",
    });
    try {
      const handlerGeneration = endpoint.attach({
        store,
        registry,
        createHostTerminal: () => {
          throw new Error("host terminal was not expected");
        },
      });
      const sourceEntry = registry.get(MAIN_PANE_ID);
      if (sourceEntry === undefined) throw new Error("missing source entry");
      await expect(
        requestNativePlacement(endpoint.socketPath, {
          type: "reserve",
          source: {
            handlerGeneration,
            paneId: MAIN_PANE_ID,
            entryGeneration: sourceEntry.generation,
            terminalPid: source.terminal.pid,
          },
          bindingToken: "binding-1",
          target: {
            terminalTargetId: "native:wt-1",
            sessionId: "session-1",
            worktreeId: "wt-1",
            harnessProvider: "codex",
          },
        }),
      ).resolves.toEqual({ type: "reserved", paneId: "pane-agent-wt-wt-1" });
      expect(store.getState().workspace.activePaneId).toBe(MAIN_PANE_ID);

      await expect(
        requestNativePlacement(endpoint.socketPath, {
          type: "commit",
          bindingToken: "binding-1",
          launch: {
            provider: "codex",
            command: "codex",
            args: [],
            cwd: "/repo/wt-1",
          },
        }),
      ).resolves.toMatchObject({
        type: "committed",
        paneId: "pane-agent-wt-wt-1",
        terminalPid: destination.terminal.pid,
      });
      expect(spawnSizes).toEqual([
        { cols: 91, rows: 27 },
        { cols: 91, rows: 27 },
      ]);
      expect(store.getState().workspace.activePaneId).toBe(MAIN_PANE_ID);

      await expect(
        requestNativePlacement(endpoint.socketPath, {
          type: "release",
          bindingToken: "binding-1",
        }),
      ).resolves.toEqual({ type: "released", status: "released" });
      expect(store.getState().workspace.panes.map((pane) => pane.id)).toEqual([MAIN_PANE_ID]);
      expect(destination.helpers.isDisposed()).toBe(true);
    } finally {
      await endpoint.close();
      registry.disposeAll();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses old reservation cleanup after a handler-generation change", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-native-placement-hmr-"));
    const source = createScriptedTerminal();
    const store = createStationStore();
    const registry = createPtyRegistry({ createTerminal: () => source.terminal });
    registry.resize(MAIN_PANE_ID, { cols: 80, rows: 24 });
    const endpoint = await createStationNativePlacementEndpoint({
      stateDir: root,
      uiRunId: "ui-hmr",
    });
    const handler = {
      store,
      registry,
      createHostTerminal: () => source.terminal,
    };
    try {
      const first = endpoint.attach(handler);
      const sourceEntry = registry.get(MAIN_PANE_ID);
      if (sourceEntry === undefined) throw new Error("missing source entry");
      await requestNativePlacement(endpoint.socketPath, {
        type: "reserve",
        source: {
          handlerGeneration: first,
          paneId: MAIN_PANE_ID,
          entryGeneration: sourceEntry.generation,
          terminalPid: source.terminal.pid,
        },
        bindingToken: "binding-stale",
        target: {
          terminalTargetId: "native:wt-stale",
          sessionId: "session-stale",
          worktreeId: "wt-stale",
          harnessProvider: "codex",
        },
      });
      endpoint.attach(handler);

      await expect(
        requestNativePlacement(endpoint.socketPath, {
          type: "release",
          bindingToken: "binding-stale",
        }),
      ).rejects.toMatchObject({ code: "TERMINAL_CLEANUP_UNCERTAIN" });
      expect(store.getState().workspace.panes.some((pane) => pane.id === "pane-agent-wt-wt-stale"))
        .toBe(true);
    } finally {
      await endpoint.close();
      registry.disposeAll();
      await rm(root, { recursive: true, force: true });
    }
  });
});

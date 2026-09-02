import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestNativePlacement } from "@station/terminal";
import { describe, expect, it } from "bun:test";
import { createStationNativePlacementEndpoint } from "./nativePlacementEndpoint.js";
import { createPaneReconciler } from "./state/reconcilers/reconcilePanes.js";
import { createStationStore } from "./state/store.js";
import { MAIN_PANE_ID } from "./state/types.js";
import { createPtyRegistry } from "./terminal/registry/ptyRegistry.js";
import { createScriptedTerminal } from "./terminal/testing/scriptedTerminal.js";
import type { StationTerminalSpawnOptions } from "./terminal/types.js";

describe("native placement endpoint", () => {
  it("uses the requested launch behind the live reconciler and retires finalized authority", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-native-placement-"));
    const source = createScriptedTerminal({ cols: 91, rows: 27 });
    const destination = createScriptedTerminal();
    const finalizedDestination = createScriptedTerminal();
    destination.terminal.kill = () => destination.helpers.emitExit({ exitCode: 0 });
    const terminals = [source.terminal, destination.terminal, finalizedDestination.terminal];
    const spawnOptions: StationTerminalSpawnOptions[] = [];
    const store = createStationStore();
    const registry = createPtyRegistry({
      createTerminal: (options) => {
        spawnOptions.push(options);
        const terminal = terminals.shift();
        if (terminal === undefined) throw new Error("terminal pool exhausted");
        return terminal;
      },
    });
    registry.resize(MAIN_PANE_ID, { cols: 91, rows: 27 });
    const reconcile = createPaneReconciler(store, registry);
    reconcile();
    const unsubscribe = store.subscribe(reconcile);
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
      expect(spawnOptions[1]).toMatchObject({
        command: "codex",
        args: [],
        cwd: "/repo/wt-1",
        size: { cols: 91, rows: 27 },
      });
      expect(store.getState().workspace.activePaneId).toBe(MAIN_PANE_ID);

      await expect(
        requestNativePlacement(endpoint.socketPath, {
          type: "release",
          bindingToken: "binding-1",
        }),
      ).resolves.toEqual({ type: "released", status: "released" });
      expect(store.getState().workspace.panes.map((pane) => pane.id)).toEqual([MAIN_PANE_ID]);
      expect(destination.helpers.isDisposed()).toBe(true);

      await requestNativePlacement(endpoint.socketPath, {
        type: "reserve",
        source: {
          handlerGeneration,
          paneId: MAIN_PANE_ID,
          entryGeneration: sourceEntry.generation,
          terminalPid: source.terminal.pid,
        },
        bindingToken: "binding-finalized",
        target: {
          terminalTargetId: "native:wt-finalized",
          sessionId: "session-finalized",
          worktreeId: "wt-finalized",
          harnessProvider: "codex",
        },
      });
      await requestNativePlacement(endpoint.socketPath, {
        type: "commit",
        bindingToken: "binding-finalized",
        launch: { provider: "codex", command: "codex", args: [] },
      });
      const finalized = await requestNativePlacement(endpoint.socketPath, {
        type: "finalize",
        bindingToken: "binding-finalized",
      });
      expect(finalized).toEqual({ type: "finalized", status: "finalized" });
      const finalizedAgain = await requestNativePlacement(endpoint.socketPath, {
        type: "finalize",
        bindingToken: "binding-finalized",
      });
      expect(finalizedAgain).toEqual({ type: "finalized", status: "already-finalized" });
      await expect(
        requestNativePlacement(endpoint.socketPath, {
          type: "release",
          bindingToken: "binding-finalized",
        }),
      ).resolves.toEqual({ type: "released", status: "already-absent" });
      expect(store.getState().workspace.panes.map((pane) => pane.id)).toEqual([
        MAIN_PANE_ID,
        "pane-agent-wt-wt-finalized",
      ]);
      expect(finalizedDestination.helpers.isDisposed()).toBe(false);
    } finally {
      unsubscribe();
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

  it("releases the reserved pane when PTY creation fails during commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-native-placement-commit-failure-"));
    const source = createScriptedTerminal();
    const store = createStationStore();
    let createCount = 0;
    const registry = createPtyRegistry({
      createTerminal: () => {
        createCount += 1;
        if (createCount === 1) return source.terminal;
        throw new Error("destination PTY failed");
      },
    });
    registry.resize(MAIN_PANE_ID, { cols: 80, rows: 24 });
    const endpoint = await createStationNativePlacementEndpoint({
      stateDir: root,
      uiRunId: "ui-commit-failure",
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
      await requestNativePlacement(endpoint.socketPath, {
        type: "reserve",
        source: {
          handlerGeneration,
          paneId: MAIN_PANE_ID,
          entryGeneration: sourceEntry.generation,
          terminalPid: source.terminal.pid,
        },
        bindingToken: "binding-failed-commit",
        target: {
          terminalTargetId: "native:wt-failed-commit",
          sessionId: "session-failed-commit",
          worktreeId: "wt-failed-commit",
          harnessProvider: "codex",
        },
      });

      await expect(
        requestNativePlacement(endpoint.socketPath, {
          type: "commit",
          bindingToken: "binding-failed-commit",
          launch: { provider: "codex", command: "codex", args: [] },
        }),
      ).rejects.toMatchObject({ code: "TERMINAL_CLEANUP_UNCERTAIN" });
      expect(registry.has("pane-agent-wt-wt-failed-commit")).toBe(true);

      await expect(
        requestNativePlacement(endpoint.socketPath, {
          type: "release",
          bindingToken: "binding-failed-commit",
        }),
      ).resolves.toEqual({ type: "released", status: "released" });
      expect(registry.has("pane-agent-wt-wt-failed-commit")).toBe(false);
      expect(store.getState().workspace.panes.map((pane) => pane.id)).toEqual([MAIN_PANE_ID]);
    } finally {
      await endpoint.close();
      registry.disposeAll();
      await rm(root, { recursive: true, force: true });
    }
  });
});

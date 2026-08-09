import { describe, expect, it } from "bun:test";
import { NO_OP_CLIPBOARD_EFFECTS } from "../copy/testing.js";
import { createStationStore } from "../state/store.js";
import { manyProjectsSnapshot } from "../station/fixtures/scenarios.js";
import { FakeStationSource } from "../station/test/support/fakeStationSource.js";
import { FakeTuiObserverService } from "../station/test/support/fakeObserverService.js";
import { createScriptedTerminal } from "../terminal/testing/scriptedTerminal.js";
import { waitFor } from "../terminal/testing/waitFor.js";
import { createStation } from "./createStation.js";

describe("native Station lifecycle", () => {
  it("reports the exact managed binding generation when a primary agent exits", async () => {
    const snapshot = manyProjectsSnapshot();
    const source = new FakeStationSource(snapshot);
    const observerService = new FakeTuiObserverService(snapshot);
    const scripted = createScriptedTerminal();
    const store = createStationStore();
    const composition = createStation({
      store,
      clipboardEffects: NO_OP_CLIPBOARD_EFFECTS,
      stationClient: {
        state: source,
        service: observerService,
        start: () => source.start(),
        stop: () => source.stop(),
      },
      shutdown: () => {},
      createTerminal: () => scripted.terminal,
    });
    const paneId = "pane-managed-exit";
    store.actions.createPane(paneId, { role: "primary-agent" });
    store.actions.setPrimaryAgent(paneId, {
      sessionId: "ses_managed",
      terminalTargetId: "native:wt_managed",
      terminalBindingToken: "binding_1",
      harnessProvider: "codex",
    });
    composition.registry.ensure(paneId, { cwd: "/tmp" });
    composition.registry.resize(paneId, { cols: 80, rows: 24 });

    scripted.helpers.emitExit({ exitCode: 0 });
    await waitFor(() => observerService.reportedExits.length === 1);

    expect(observerService.reportedExits).toEqual([
      {
        terminalTargetId: "native:wt_managed",
        expectedSessionId: "ses_managed",
        expectedBindingToken: "binding_1",
      },
    ]);
  });

  it("attempts later cleanup after failure and handles Ctrl-Q fire-and-forget rejection", async () => {
    const snapshot = manyProjectsSnapshot();
    const source = new FakeStationSource(snapshot);
    const scripted = createScriptedTerminal();
    const store = createStationStore();
    let stopAttempts = 0;
    let shutdowns = 0;
    const composition = createStation({
      store,
      clipboardEffects: NO_OP_CLIPBOARD_EFFECTS,
      stationClient: {
        state: source,
        service: new FakeTuiObserverService(snapshot),
        start: () => source.start(),
        stop: async () => {
          stopAttempts += 1;
          throw new Error("client stop failed");
        },
      },
      shutdown: () => {
        shutdowns += 1;
      },
      createTerminal: () => scripted.terminal,
    });
    const paneId = "pane-cleanup-failure";
    store.actions.createPane(paneId, { role: "shell" });
    composition.registry.ensure(paneId, { cwd: "/tmp" });
    composition.registry.resize(paneId, { cols: 80, rows: 24 });
    composition.start();

    const first = composition.disposeForShutdown();
    const second = composition.disposeForShutdown();
    expect(second).toBe(first);

    let failure: unknown;
    try {
      await first;
    } catch (error: unknown) {
      failure = error;
    }
    expect(failure instanceof AggregateError).toBe(true);
    expect(stopAttempts).toBe(1);
    expect(scripted.helpers.isDisposed()).toBe(true);

    const unhandled: unknown[] = [];
    const observeUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", observeUnhandled);
    try {
      expect(composition.stationInput.handleSequence("\x11")).toBe(true);
      await waitFor(() => shutdowns === 1);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    } finally {
      process.off("unhandledRejection", observeUnhandled);
    }
    expect(unhandled).toEqual([]);
  });
});

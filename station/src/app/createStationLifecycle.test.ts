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

  it("admits Ctrl-Q synchronously once while its owner drives failing cleanup", async () => {
    const snapshot = manyProjectsSnapshot();
    const source = new FakeStationSource(snapshot);
    const scripted = createScriptedTerminal();
    const store = createStationStore();
    let stopAttempts = 0;
    const stopped = Promise.withResolvers<void>();
    const ownerDisposals: Promise<void>[] = [];
    let composition!: ReturnType<typeof createStation>;
    composition = createStation({
      store,
      clipboardEffects: NO_OP_CLIPBOARD_EFFECTS,
      stationClient: {
        state: source,
        service: new FakeTuiObserverService(snapshot),
        start: () => source.start(),
        stop: () => {
          stopAttempts += 1;
          return stopped.promise;
        },
      },
      shutdown: () => {
        ownerDisposals.push(composition.disposeForShutdown());
      },
      createTerminal: () => scripted.terminal,
    });
    store.actions.createPane("pane-cleanup-failure", { role: "shell" });
    composition.registry.ensure("pane-cleanup-failure", { cwd: "/tmp" });
    composition.registry.resize("pane-cleanup-failure", { cols: 80, rows: 24 });
    composition.start();

    expect(composition.stationInput.handleSequence("\x11")).toBe(true);
    expect(ownerDisposals).toHaveLength(1);
    expect(composition.stationInput.handleSequence("\x11")).toBe(true);
    expect(ownerDisposals).toHaveLength(1);
    expect(composition.disposeForShutdown()).toBe(ownerDisposals[0]);
    stopped.reject(new Error("client stop failed"));
    const failure = await ownerDisposals[0]!.catch((error: unknown) => error);
    expect(failure instanceof AggregateError).toBe(true);
    expect(stopAttempts).toBe(1);
    expect(scripted.helpers.isDisposed()).toBe(true);
  });
});

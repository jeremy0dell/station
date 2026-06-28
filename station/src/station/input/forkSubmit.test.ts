import { describe, expect, it } from "bun:test";
import { createTuiStore } from "@station/dashboard-core";
import { manyProjectsSnapshot } from "../fixtures/scenarios.js";
import { FakeTuiObserverService } from "../test/support/fakeObserverService.js";
import { FakeStationSource } from "../test/support/fakeStationSource.js";
import { resolveForkSessionSubmit, resolveKeyForkSessionSubmit } from "./stationActions.js";

// Station hosts a fork in a pane (worktree.fork + managed launch) rather than
// the shared machine's tmux session.fork. These resolvers are the interception
// point: Enter on the details screen becomes a hosted-launch submit; everything
// else (including an invalid branch) falls through to the machine.
function newStore() {
  const snapshot = manyProjectsSnapshot();
  return createTuiStore({
    source: new FakeStationSource(snapshot),
    service: new FakeTuiObserverService(snapshot),
    initialSnapshot: snapshot,
    persistentPopup: true,
    onDismiss: async () => {},
  });
}

function storeOnForkDetails() {
  const store = newStore();
  // "F" opens the fork chooseSlot step; the first slot opens details for that row.
  store.getState().handleKey({ input: "F" });
  store.getState().handleKey({ input: "1" });
  return store;
}

describe("resolveForkSessionSubmit", () => {
  it("resolves the details screen to a hosted-launch submit carrying the source + copyDirty", () => {
    const store = storeOnForkDetails();
    const screen = store.getState().screen;
    if (screen.name !== "fork" || screen.step !== "details") {
      throw new Error(`expected fork details, got ${screen.name}`);
    }

    const submit = resolveForkSessionSubmit(store);
    expect(submit.kind).toBe("submit");
    if (submit.kind === "submit") {
      expect(submit.projectId).toBe(screen.projectId);
      expect(submit.sourceWorktreeId).toBe(screen.sourceWorktreeId);
      expect(submit.branch).toBe(screen.draftBranch.value.trim());
      expect(submit.copyDirty).toBe(true);
    }
  });

  it("does not submit from the dashboard (no fork sheet open)", () => {
    expect(resolveForkSessionSubmit(newStore()).kind).toBe("none");
  });

  it("does not submit from the chooseSlot step", () => {
    const store = newStore();
    store.getState().handleKey({ input: "F" });
    expect(store.getState().screen).toMatchObject({ name: "fork", step: "chooseSlot" });
    expect(resolveForkSessionSubmit(store).kind).toBe("none");
  });
});

describe("resolveKeyForkSessionSubmit", () => {
  it("submits only on Enter", () => {
    const store = storeOnForkDetails();
    expect(resolveKeyForkSessionSubmit(store, "\r").kind).toBe("submit");
    // A navigation/edit key on the details screen stays with the shared machine.
    expect(resolveKeyForkSessionSubmit(store, "x").kind).toBe("none");
  });
});

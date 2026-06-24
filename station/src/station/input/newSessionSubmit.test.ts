import { describe, expect, it } from "bun:test";
import { createTuiStore } from "@station/dashboard-core";
import { manyProjectsSnapshot } from "../fixtures/scenarios.js";
import { FakeTuiObserverService } from "../test/support/fakeObserverService.js";
import { FakeStationSource } from "../test/support/fakeStationSource.js";
import { resolveKeyNewSessionSubmit, resolveNewSessionSubmit } from "./stationActions.js";

// Station hosts new agents in a pane (worktree.create + managed launch) rather
// than the shared machine's tmux session.create, which it can't render. These
// resolvers are the interception point: Enter on the review screen becomes a
// hosted-launch submit; everything else falls through to the machine.
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

function storeOnNewSessionReview() {
  const store = newStore();
  // "N" opens the New Session wizard, which lands on the review step.
  store.getState().handleKey({ input: "N" });
  return store;
}

describe("resolveNewSessionSubmit", () => {
  it("resolves the review screen to a hosted-launch submit with the picked project/harness", () => {
    const store = storeOnNewSessionReview();
    expect(store.getState().screen.name).toBe("newSession");

    const submit = resolveNewSessionSubmit(store);
    expect(submit.kind).toBe("submit");
    if (submit.kind === "submit") {
      expect(submit.projectId).toBe("station");
      // Generated branch carries a random token, so match the prefix, not the whole name.
      expect(submit.branch).toMatch(/^station-/);
      expect(submit.harness).toBe("codex");
    }
  });

  it("does not submit from the dashboard (no wizard open)", () => {
    expect(resolveNewSessionSubmit(newStore()).kind).toBe("none");
  });
});

describe("resolveKeyNewSessionSubmit", () => {
  it("submits only on Enter", () => {
    const store = storeOnNewSessionReview();
    expect(resolveKeyNewSessionSubmit(store, "\r").kind).toBe("submit");
    // A navigation/edit key on the review screen stays with the shared machine.
    expect(resolveKeyNewSessionSubmit(store, "x").kind).toBe("none");
  });
});

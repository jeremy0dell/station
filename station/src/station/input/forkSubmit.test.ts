import { describe, expect, it } from "bun:test";
import { createTuiStore } from "@station/dashboard-core";
import { manyProjectsSnapshot } from "../fixtures/scenarios.js";
import { FakeTuiObserverService } from "../test/support/fakeObserverService.js";
import { FakeStationSource } from "../test/support/fakeStationSource.js";
import { resolveForkSessionSubmit, resolveKeyForkSessionSubmit } from "./stationActions.js";

// Station hosts a fork in a pane (worktree.fork + managed launch) rather than
// the shared machine's tmux session.fork. These resolvers are the interception
// point: Enter on Name or Submit becomes a hosted launch, while Copy-focused
// Enter and invalid input fall through to the shared screen transition.
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
      expect(submit.title).toBe(screen.draftTitle.value.trim());
      expect(submit.branch).toBe(screen.branch);
      expect(submit.copyDirty).toBe(true);
    }
  });

  it("carries a custom name independently from the generated branch", () => {
    const store = storeOnForkDetails();
    const initial = store.getState().screen;
    if (initial.name !== "fork" || initial.step !== "details") throw new Error("expected details");
    store.getState().handleKey({ input: "u", ctrl: true });
    store.getState().handleKey({ input: "Hexagonal PT 12" });

    const submit = resolveForkSessionSubmit(store);
    expect(submit).toMatchObject({
      kind: "submit",
      title: "Hexagonal PT 12",
      branch: initial.branch,
    });
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
  it("submits Enter from Name or Submit focus", () => {
    const store = storeOnForkDetails();
    expect(resolveKeyForkSessionSubmit(store, "\r").kind).toBe("submit");

    store.getState().handleKey({ input: "", downArrow: true });
    store.getState().handleKey({ input: "", downArrow: true });
    expect(store.getState().screen).toMatchObject({ focus: "submit" });
    expect(resolveKeyForkSessionSubmit(store, "\r").kind).toBe("submit");
    expect(resolveKeyForkSessionSubmit(store, "x").kind).toBe("none");
  });

  it("leaves Copy-focused Enter to the shared toggle transition", () => {
    const store = storeOnForkDetails();
    store.getState().handleKey({ input: "", downArrow: true });

    expect(store.getState().screen).toMatchObject({ focus: "copyDirty", copyDirty: true });
    expect(resolveKeyForkSessionSubmit(store, "\r")).toEqual({ kind: "none" });

    store.getState().handleKey({ input: "\r", return: true });
    expect(store.getState().screen).toMatchObject({ focus: "copyDirty", copyDirty: false });
  });
});

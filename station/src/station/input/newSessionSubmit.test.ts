import { describe, expect, it } from "bun:test";
import type { StationSnapshot } from "@station/contracts";
import { createTuiStore } from "@station/dashboard-core";
import { resolveInitialState } from "../../state/initialState.js";
import { manyProjectsSnapshot } from "../fixtures/scenarios.js";
import { FakeTuiObserverService } from "../test/support/fakeObserverService.js";
import { FakeStationSource } from "../test/support/fakeStationSource.js";
import { resolveKeyNewSessionSubmit, resolveNewSessionSubmit } from "./stationActions.js";
import { createStationOverlayLayer } from "./stationOverlayLayer.js";

// Station hosts new agents in a pane (worktree.create + managed launch) rather
// than the shared machine's tmux session.create, which it can't render. These
// resolvers are the interception point: focused Enter or direct C on review
// becomes a hosted launch; field/editor keys fall through to the machine.
function newStore(snapshot = manyProjectsSnapshot()) {
  return createTuiStore({
    source: new FakeStationSource(snapshot),
    service: new FakeTuiObserverService(snapshot),
    initialSnapshot: snapshot,
    persistentPopup: true,
    onDismiss: async () => {},
  });
}

function storeOnNewSessionReview(snapshot?: StationSnapshot) {
  const store = newStore(snapshot);
  // "N" opens the New Session wizard, which lands on the review step.
  store.getState().handleKey({ input: "N" });
  return store;
}

function snapshotWithUnavailableCodex(): StationSnapshot {
  const snapshot = manyProjectsSnapshot();
  return {
    ...snapshot,
    providerHealth: {
      ...snapshot.providerHealth,
      codex: {
        providerId: "codex",
        providerType: "harness",
        status: "unavailable",
        lastCheckedAt: snapshot.generatedAt,
      },
    },
  };
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
      expect(submit.title).toBe(submit.branch);
      expect(submit.harness).toBe("codex");
    }
  });

  it("carries a custom name independently from the generated branch", () => {
    const store = storeOnNewSessionReview();
    const opened = store.getState().screen;
    if (opened.name !== "newSession") throw new Error("expected new-session wizard");
    const branch = opened.flow.branch;
    store.getState().handleKey({ input: "N" });
    store.getState().handleKey({ input: "Hexagonal PT 12" });
    store.getState().handleKey({ input: "\r", return: true });

    expect(resolveNewSessionSubmit(store)).toMatchObject({
      kind: "submit",
      title: "Hexagonal PT 12",
      branch,
    });
  });

  it("does not submit from the dashboard (no wizard open)", () => {
    expect(resolveNewSessionSubmit(newStore()).kind).toBe("none");
  });

  it("does not intercept a resolved non-Create semantic action", () => {
    const store = storeOnNewSessionReview();
    expect(
      resolveNewSessionSubmit(store, {
        type: "newSession.activate",
        actionId: "review.project",
      }).kind,
    ).toBe("none");
  });

  it("keeps unavailable Create inert when native input falls through", () => {
    for (const sequence of ["C", "\r"]) {
      const store = storeOnNewSessionReview(snapshotWithUnavailableCodex());
      expect(resolveKeyNewSessionSubmit(store, sequence).kind).toBe("none");
      expect(
        createStationOverlayLayer(store).catchAll?.(sequence, resolveInitialState()),
      ).toEqual({ kind: "swallowed" });
      expect(store.getState().screen.name).toBe("newSession");
      expect(store.getState().toasts).toEqual([]);
    }
  });
});

describe("resolveKeyNewSessionSubmit", () => {
  it("submits on focused Enter and direct C", () => {
    const store = storeOnNewSessionReview();
    expect(resolveKeyNewSessionSubmit(store, "\r").kind).toBe("submit");

    store.getState().handleKey({ input: "", downArrow: true });
    expect(resolveKeyNewSessionSubmit(store, "\r").kind).toBe("none");
    expect(resolveKeyNewSessionSubmit(store, "C").kind).toBe("submit");

    // A field/edit key stays with the shared machine.
    expect(resolveKeyNewSessionSubmit(store, "x").kind).toBe("none");
  });
});

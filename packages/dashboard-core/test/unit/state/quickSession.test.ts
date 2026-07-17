import { createTuiStore } from "@station/dashboard-core";
import { describe, expect, it, vi } from "vitest";
import { createCommandSnapshot } from "../../fixtures/snapshots.js";
import { FakeTuiObserverService } from "../../support/fakeObserverService.js";

describe("quick session", () => {
  it("creates immediately with the project's configured harness and terminal", async () => {
    const snapshot = createCommandSnapshot("idle");
    const service = new FakeTuiObserverService(snapshot);
    const store = createTuiStore({ service, initialSnapshot: snapshot });
    const project = snapshot.projects[0];
    if (project === undefined) throw new Error("project fixture missing");

    store.getState().createQuickSession(project.id);

    await vi.waitFor(() => expect(service.dispatched).toHaveLength(1));
    expect(service.dispatched[0]).toMatchObject({
      type: "session.create",
      payload: {
        projectId: project.id,
        harness: { provider: project.defaults.harness },
        terminal: {
          provider: project.defaults.terminal,
          focus: false,
        },
      },
    });
    expect(service.waitedForCommandIds).toEqual(["cmd_tui_1"]);
  });

  it("leaves unavailable or stale projects inert", () => {
    const snapshot = createCommandSnapshot("idle");
    const service = new FakeTuiObserverService(snapshot);
    const store = createTuiStore({ service, initialSnapshot: snapshot });

    store.getState().createQuickSession("missing-project");

    expect(service.dispatched).toEqual([]);
    expect(store.getState().localRows.pendingCreate).toEqual([]);
  });
});

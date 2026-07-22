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

  it("shows the unavailable project's exact error without dispatching", () => {
    const snapshot = createCommandSnapshot("idle");
    const project = snapshot.projects[0];
    if (project === undefined) throw new Error("project fixture missing");
    const error = {
      tag: "WorktreeProviderError",
      code: "WORKTRUNK_PROJECT_ROOT_BARE",
      message: "Project checkout is configured as a bare repository.",
      hint: `Inspect with git -C '${project.root}' config --show-origin --get core.bare. If this is the intended checkout, run git -C '${project.root}' config --local core.bare false; otherwise correct projects.root.`,
      provider: "worktrunk",
      projectId: project.id,
    } as const;
    const unavailable = {
      ...snapshot,
      projects: snapshot.projects.map((candidate) =>
        candidate.id === project.id
          ? {
              ...candidate,
              health: { ...candidate.health, status: "unavailable" as const, lastError: error },
            }
          : candidate,
      ),
    };
    const service = new FakeTuiObserverService(unavailable);
    const store = createTuiStore({ service, initialSnapshot: unavailable });

    store.getState().createQuickSession(project.id);

    expect(service.dispatched).toEqual([]);
    expect(store.getState().localRows.pendingCreate).toEqual([]);
    expect(store.getState().toasts.at(-1)?.toast).toMatchObject({
      kind: "error",
      message: error.message,
      hint: error.hint,
    });
  });

  it("leaves a missing project inert", () => {
    const snapshot = createCommandSnapshot("idle");
    const service = new FakeTuiObserverService(snapshot);
    const store = createTuiStore({ service, initialSnapshot: snapshot });

    store.getState().createQuickSession("missing-project");

    expect(service.dispatched).toEqual([]);
    expect(store.getState().localRows.pendingCreate).toEqual([]);
    expect(store.getState().toasts).toEqual([]);
  });
});

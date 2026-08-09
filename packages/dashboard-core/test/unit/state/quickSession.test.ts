import { describe, expect, it } from "vitest";
import { createCommandSnapshot, createZeroWorktreeSnapshot } from "../../fixtures/snapshots.js";
import { createTestDashboardRuntime } from "../../support/fakeClientStateSource.js";
import { createFakeDashboardCapabilities } from "../../support/fakeDashboardCapabilities.js";
import { FakeTuiObserverService } from "../../support/fakeObserverService.js";

describe("quick session", () => {
  it("dispatches the project's product values through Quick Session capability", () => {
    const snapshot = createCommandSnapshot("idle");
    const service = new FakeTuiObserverService(snapshot);
    const capabilities = createFakeDashboardCapabilities();
    const store = createTestDashboardRuntime({ service, initialSnapshot: snapshot, capabilities });
    const project = snapshot.projects[0];
    if (project === undefined) throw new Error("project fixture missing");

    store.actions.dispatch({
      type: "dashboard.projectHeader.activate",
      projectId: project.id,
      actionId: "quickSession",
    });

    expect(capabilities.quickCreateRequests).toHaveLength(1);
    expect(capabilities.quickCreateRequests[0]).toMatchObject({
      project: { id: project.id },
      harness: project.defaults.harness,
    });
    expect(capabilities.quickCreateRequests[0]?.title).toBe(
      capabilities.quickCreateRequests[0]?.hiddenBranch,
    );
  });

  it("retains accepted empty-project focus through capability invocation", () => {
    const snapshot = createZeroWorktreeSnapshot();
    const service = new FakeTuiObserverService(snapshot);
    const capabilities = createFakeDashboardCapabilities();
    const store = createTestDashboardRuntime({
      service,
      capabilities,
      initialSnapshot: snapshot,
      initialState: { dashboardFocus: { kind: "emptyProjectAction", projectId: "web" } },
    });

    store.actions.dispatch({ type: "dashboard.emptyProject.activate", projectId: "web" });

    expect(store.state.getState().dashboardFocus).toEqual({
      kind: "emptyProjectAction",
      projectId: "web",
    });
    expect(capabilities.quickCreateRequests).toHaveLength(1);
  });

  it("shows the unavailable project's exact error without invoking capability", () => {
    const snapshot = createZeroWorktreeSnapshot();
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
    const capabilities = createFakeDashboardCapabilities();
    const store = createTestDashboardRuntime({
      service,
      capabilities,
      initialSnapshot: unavailable,
      initialState: { dashboardFocus: { kind: "emptyProjectAction", projectId: project.id } },
    });

    store.actions.dispatch({ type: "dashboard.emptyProject.activate", projectId: project.id });

    expect(capabilities.quickCreateRequests).toEqual([]);
    expect(store.state.getState().dashboardFocus).toEqual({
      kind: "emptyProjectAction",
      projectId: project.id,
    });
    expect(store.state.getState().localRows.pendingCreate).toEqual([]);
    expect(store.state.getState().toasts.at(-1)?.toast).toMatchObject({
      kind: "error",
      message: error.message,
      hint: error.hint,
    });
  });

  it("leaves a missing project inert", () => {
    const snapshot = createCommandSnapshot("idle");
    const service = new FakeTuiObserverService(snapshot);
    const capabilities = createFakeDashboardCapabilities();
    const store = createTestDashboardRuntime({ service, initialSnapshot: snapshot, capabilities });

    store.actions.dispatch({
      type: "dashboard.projectHeader.activate",
      projectId: "missing-project",
      actionId: "quickSession",
    });

    expect(capabilities.quickCreateRequests).toEqual([]);
    expect(store.state.getState().localRows.pendingCreate).toEqual([]);
    expect(store.state.getState().toasts).toEqual([]);
  });
});

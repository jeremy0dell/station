import { describe, expect, it } from "bun:test";
import type { ManagedLaunch, ManagedLaunchResult } from "../input/runtime/managedLaunch.js";
import type { PaneEffects } from "../input/runtime/paneEffects.js";
import { createStationStore } from "../state/store.js";
import { STATION_OVERLAY_ID } from "../state/types.js";
import { manyProjectsSnapshot } from "../station/fixtures/scenarios.js";
import { FakeStationSource } from "../station/test/support/fakeStationSource.js";
import { FakeTuiObserverService } from "../station/test/support/fakeObserverService.js";
import { createDashboardCapabilities } from "./dashboardCapabilities.js";

function harness() {
  const snapshot = manyProjectsSnapshot();
  const source = new FakeStationSource(snapshot);
  const service = new FakeTuiObserverService(snapshot);
  const store = createStationStore();
  const opened: Array<{ paneId: string; cwd: string | undefined }> = [];
  const paneEffects: PaneEffects = {
    writeToTerminal: () => false,
    pasteToTerminal: () => false,
    scrollTerminal: () => false,
    openPane: (paneId, spawn) => opened.push({ paneId, cwd: spawn.cwd }),
    splitPane: () => {},
    runAutomation: () => {},
    closePane: () => {},
  };
  let activationResult: ManagedLaunchResult = { kind: "success", landed: true };
  let createResult: ManagedLaunchResult = { kind: "success", landed: false };
  const createRequests: Parameters<ManagedLaunch["create"]>[0][] = [];
  const managedLaunch: ManagedLaunch = {
    activate: async () => activationResult,
    create: async (request) => {
      createRequests.push(request);
      return createResult;
    },
    fork: async () => createResult,
  };
  const capabilities = createDashboardCapabilities({
    clientState: source,
    observerService: service,
    store,
    paneEffects,
    managedLaunch,
  });
  return {
    capabilities,
    source,
    store,
    opened,
    createRequests,
    setActivationResult: (result: ManagedLaunchResult) => (activationResult = result),
    setCreateResult: (result: ManagedLaunchResult) => (createResult = result),
  };
}

const ACTIVATION = {
  sessionId: "ses_wt_station_idle",
  projectId: "station",
  worktreeId: "wt_station_idle",
  branch: "pty-buffer",
  preferredObserverAction: "focus" as const,
};

const FAILURE = {
  tag: "ClientObserverError" as const,
  code: "OPERATION_FAILED",
  message: "Operation failed.",
};

describe("native dashboard capabilities", () => {
  it("dismisses the overlay only after a managed activation lands", async () => {
    const fixture = harness();
    fixture.store.actions.openOverlay(STATION_OVERLAY_ID);

    expect(await fixture.capabilities.activation.activate(ACTIVATION).completion).toEqual({
      kind: "success",
    });
    expect(fixture.store.getState().input.activeOverlay).toBeNull();

    fixture.store.actions.openOverlay(STATION_OVERLAY_ID);
    fixture.setActivationResult({
      kind: "notice",
      notice: { kind: "info", message: "The target changed." },
    });
    expect(await fixture.capabilities.activation.activate(ACTIVATION).completion).toMatchObject({
      kind: "notice",
    });
    expect(fixture.store.getState().input.activeOverlay).toBe(STATION_OVERLAY_ID);
  });

  it("exposes pending-start lifecycle for native start and resume activation", async () => {
    const fixture = harness();
    const handle = fixture.capabilities.activation.activate({
      ...ACTIVATION,
      preferredObserverAction: "start",
    });

    expect(handle.optimistic).toBe("pending-start");
    expect(handle.successDisposition).toBe("wait-for-canonical");
    expect(await handle.completion).toEqual({ kind: "success" });
  });

  it("uses native overlay authority for dashboard dismissal and renderer exit", async () => {
    const fixture = harness();
    fixture.store.actions.openOverlay(STATION_OVERLAY_ID);

    expect(await fixture.capabilities.dismissal.dismissDashboard().completion).toEqual({
      kind: "success",
    });
    expect(fixture.store.getState().input.activeOverlay).toBeNull();

    fixture.store.actions.openOverlay(STATION_OVERLAY_ID);
    expect(
      await fixture.capabilities.dismissal.exitRenderer({ exitCode: 0 }).completion,
    ).toEqual({ kind: "success" });
    expect(fixture.store.getState().input.activeOverlay).toBeNull();
  });

  it("resolves project and row shells from canonical client state", async () => {
    const fixture = harness();

    await fixture.capabilities.shell.open({ kind: "project", projectId: "station" }).completion;
    await fixture.capabilities.shell.open({
      kind: "session",
      sessionId: "ses_wt_station_idle",
    }).completion;

    expect(fixture.opened).toEqual([
      { paneId: "pane-proj-station", cwd: "/Users/example/Developer/station" },
      { paneId: "pane-wt-wt_station_idle", cwd: "/Users/example/.worktrees/station/pty-buffer" },
    ]);
  });

  it("distinguishes worktree failures from launch-preparation failures", async () => {
    const fixture = harness();
    const project = manyProjectsSnapshot().projects.find((candidate) => candidate.id === "station");
    if (project === undefined) throw new Error("project fixture missing");
    const request = {
      project,
      title: "New session",
      hiddenBranch: "station-new-123",
      harness: "codex",
      group: { kind: "existing" as const, groupId: "grp_release" },
    };

    fixture.setCreateResult({ kind: "failure", stage: "worktree", error: FAILURE });
    expect(await fixture.capabilities.managedSessions.create(request).completion).toMatchObject({
      kind: "failure",
      disposition: "remove-immediately",
    });

    fixture.setCreateResult({ kind: "failure", stage: "launch", error: FAILURE });
    expect(await fixture.capabilities.managedSessions.create(request).completion).toMatchObject({
      kind: "failure",
      disposition: "retain-failed",
    });
    expect(fixture.createRequests).toEqual([
      {
        projectId: "station",
        title: "New session",
        branch: "station-new-123",
        harness: "codex",
        group: { kind: "existing", groupId: "grp_release" },
      },
      {
        projectId: "station",
        title: "New session",
        branch: "station-new-123",
        harness: "codex",
        group: { kind: "existing", groupId: "grp_release" },
      },
    ]);
  });

  it("waits for a native Quick Session to reach the client snapshot", async () => {
    const fixture = harness();
    const snapshot = manyProjectsSnapshot();
    const project = snapshot.projects.find((candidate) => candidate.id === "station");
    const session = snapshot.sessions.find((candidate) => candidate.projectId === "station");
    if (project === undefined || session === undefined) throw new Error("station fixture missing");
    const branch = "station-quick-group-123456";
    const completion = fixture.capabilities.managedSessions.quickCreate({
      project,
      title: branch,
      hiddenBranch: branch,
      harness: "codex",
    }).completion;
    let settled = false;
    void completion.then(() => {
      settled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    fixture.source.setSnapshot({
      ...snapshot,
      rows: snapshot.rows.map((row) =>
        row.id === session.worktreeId ? { ...row, branch } : row,
      ),
    });
    expect(await completion).toEqual({ kind: "success" });
  });
});

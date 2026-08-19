import { describe, expect, it } from "bun:test";
import type { ManagedLaunch, ManagedLaunchResult } from "../input/runtime/managedLaunch.js";
import type { PaneEffects } from "../input/runtime/paneEffects.js";
import { createStationStore } from "../state/store.js";
import type { PtyRegistry } from "../terminal/registry/ptyRegistry.js";
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
  const forkRequests: Parameters<ManagedLaunch["fork"]>[0][] = [];
  const managedLaunch: ManagedLaunch = {
    activate: async () => activationResult,
    create: async (request) => {
      createRequests.push(request);
      return createResult;
    },
    fork: async (request) => {
      forkRequests.push(request);
      return createResult;
    },
  };
  const capabilities = createDashboardCapabilities({
    clientState: source,
    observerService: service,
    store,
    paneEffects,
    registry: {} as PtyRegistry,
    managedLaunch,
  });
  return {
    capabilities,
    source,
    service,
    store,
    opened,
    createRequests,
    forkRequests,
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

  it("carries source Group inheritance into native Fork execution", async () => {
    const fixture = harness();
    const project = manyProjectsSnapshot().projects.find((candidate) => candidate.id === "station");
    if (project === undefined) throw new Error("project fixture missing");

    const handle = fixture.capabilities.managedSessions.fork({
      project,
      sourceWorktreeId: "wt_station_working",
      title: "Forked session",
      hiddenBranch: "forked-session-123",
      copyDirty: true,
      inheritedHarness: "codex",
      group: {
        kind: "source",
        sourceSessionId: "ses_wt_station_working",
        groupId: "group_active",
      },
    });

    expect(handle.optimistic).toBe("pending-create");
    await expect(handle.completion).resolves.toEqual({ kind: "success" });
    expect(fixture.forkRequests).toEqual([
      {
        projectId: "station",
        sourceWorktreeId: "wt_station_working",
        title: "Forked session",
        branch: "forked-session-123",
        copyDirty: true,
        harness: "codex",
        group: {
          kind: "source",
          sourceSessionId: "ses_wt_station_working",
          groupId: "group_active",
        },
      },
    ]);
  });

  it("keeps deliberate New Session pending until exact existing-Group membership is canonical", async () => {
    const fixture = harness();
    const snapshot = manyProjectsSnapshot();
    const project = snapshot.projects.find((candidate) => candidate.id === "station");
    const session = snapshot.sessions.find((candidate) => candidate.projectId === "station");
    if (project === undefined || session === undefined) throw new Error("station fixture missing");
    const branch = "station-deliberate-group-123456";
    const request = {
      project,
      title: branch,
      hiddenBranch: branch,
      harness: "codex" as const,
      group: { kind: "existing" as const, groupId: "grp_release" },
    };
    const completion = fixture.capabilities.managedSessions.create(request).completion;
    let settled = false;
    void completion.then(() => {
      settled = true;
    });

    const sessionOnly = {
      ...snapshot,
      rows: snapshot.rows.map((row) =>
        row.id === session.worktreeId ? { ...row, branch } : row,
      ),
    };
    fixture.source.setSnapshot(sessionOnly);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    fixture.source.setSnapshot({
      ...sessionOnly,
      sessionGroups: [
        {
          id: "grp_release",
          projectId: "station",
          name: "Release",
          sessionIds: [session.id],
          version: 1,
          createdAt: session.createdAt,
          updatedAt: session.createdAt,
        },
      ],
    });
    expect(await completion).toEqual({ kind: "success" });
  });

  it("matches deliberate inline-Group placement by canonical membership and name", async () => {
    const fixture = harness();
    const snapshot = manyProjectsSnapshot();
    const project = snapshot.projects.find((candidate) => candidate.id === "station");
    const session = snapshot.sessions.find((candidate) => candidate.projectId === "station");
    if (project === undefined || session === undefined) throw new Error("station fixture missing");
    const branch = "station-deliberate-inline-123456";
    const completion = fixture.capabilities.managedSessions.create({
      project,
      title: branch,
      hiddenBranch: branch,
      harness: "codex",
      group: { kind: "create", name: "Release" },
    }).completion;

    fixture.source.setSnapshot({
      ...snapshot,
      rows: snapshot.rows.map((row) =>
        row.id === session.worktreeId ? { ...row, branch } : row,
      ),
      sessionGroups: [
        {
          id: "grp_minted",
          projectId: "station",
          name: "Release",
          sessionIds: [session.id],
          version: 1,
          createdAt: session.createdAt,
          updatedAt: session.createdAt,
        },
      ],
    });
    expect(await completion).toEqual({ kind: "success" });
  });

  it("refreshes once after placement timeout and warns without enabling duplicate retry", async () => {
    const realSetTimeout = globalThis.setTimeout;
    const longTimers: Array<() => void> = [];
    globalThis.setTimeout = ((
      callback: (...callbackArgs: unknown[]) => void,
      ms?: number,
      ...rest: unknown[]
    ) => {
      if (typeof ms === "number" && ms >= 5_000) {
        longTimers.push(() => callback(...rest));
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }
      return realSetTimeout(callback, ms, ...rest);
    }) as typeof globalThis.setTimeout;
    try {
      const snapshot = manyProjectsSnapshot();
      const project = snapshot.projects.find((candidate) => candidate.id === "station");
      const session = snapshot.sessions.find((candidate) => candidate.projectId === "station");
      if (project === undefined || session === undefined) throw new Error("station fixture missing");
      const request = {
        project,
        title: "Refreshed",
        hiddenBranch: "station-refresh-123456",
        harness: "codex" as const,
      };

      const refreshed = harness();
      refreshed.service.setSnapshot({
        ...snapshot,
        rows: snapshot.rows.map((row) =>
          row.id === session.worktreeId ? { ...row, branch: request.hiddenBranch } : row,
        ),
      });
      const refreshedCompletion = refreshed.capabilities.managedSessions.create(request).completion;
      await new Promise((resolve) => realSetTimeout(resolve, 0));
      longTimers.shift()?.();
      expect(await refreshedCompletion).toEqual({ kind: "success" });
      expect(refreshed.service.loadCount).toBe(1);

      const unconfirmed = harness();
      const warningCompletion = unconfirmed.capabilities.managedSessions.create({
        ...request,
        hiddenBranch: "station-unconfirmed-123456",
      }).completion;
      await new Promise((resolve) => realSetTimeout(resolve, 0));
      longTimers.shift()?.();
      expect(await warningCompletion).toEqual({
        kind: "success",
        notice: {
          kind: "error",
          message: "The session was created, but Station could not confirm its Group placement.",
          hint: "Refresh the dashboard before creating another session.",
        },
      });
      expect(unconfirmed.service.loadCount).toBe(1);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });

  it("settles a retained-worktree notice as non-retryable deliberate completion", async () => {
    const fixture = harness();
    const project = manyProjectsSnapshot().projects.find(
      (candidate) => candidate.id === "station",
    );
    if (project === undefined) throw new Error("project fixture missing");
    fixture.setCreateResult({
      kind: "notice",
      notice: { kind: "error", message: "Station retained the worktree." },
    });

    await expect(
      fixture.capabilities.managedSessions.create({
        project,
        title: "Retained",
        hiddenBranch: "station-retained-123456",
        harness: "codex",
      }).completion,
    ).resolves.toEqual({
      kind: "success",
      notice: { kind: "error", message: "Station retained the worktree." },
    });
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

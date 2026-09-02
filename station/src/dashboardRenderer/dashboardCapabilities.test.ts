import { describe, expect, it } from "bun:test";
import { manyProjectsSnapshot } from "../station/fixtures/scenarios.js";
import { FakeStationSource } from "../station/test/support/fakeStationSource.js";
import { FakeTuiObserverService } from "../station/test/support/fakeObserverService.js";
import { createDashboardCapabilities } from "./dashboardCapabilities.js";

const ACTIVATION = {
  sessionId: "ses_wt_station_idle",
  projectId: "station",
  worktreeId: "wt_station_idle",
  branch: "pty-buffer",
  preferredObserverAction: "focus" as const,
};

describe("standalone dashboard capabilities", () => {
  it("uses semantic activation success as the only automatic exit authority", async () => {
    const snapshot = manyProjectsSnapshot();
    const source = new FakeStationSource(snapshot);
    const service = new FakeTuiObserverService(snapshot);
    let dismissCount = 0;
    const capabilities = createDashboardCapabilities({
      clientState: source,
      observerService: service,
      popupRuntime: {
        persistentPopup: false,
        exitOnFocusSuccess: true,
        dispose: () => {},
      },
      sessionCreatePolicies: {
        global: { focusCreatedSession: true, dismissDashboard: true },
        terminals: {},
      },
      exitRenderer: () => {
        dismissCount += 1;
      },
    });

    expect(await capabilities.activation.activate(ACTIVATION).completion).toEqual({
      kind: "success",
    });
    expect(service.dispatched).toEqual([
      { type: "terminal.focus", payload: { sessionId: ACTIVATION.sessionId } },
    ]);
    expect(dismissCount).toBe(1);

    service.nextReceipt = {
      commandId: "cmd_rejected",
      accepted: false,
      status: "rejected",
      error: {
        tag: "ClientObserverError",
        code: "FOCUS_REJECTED",
        message: "Focus rejected.",
      },
    };
    expect(await capabilities.activation.activate(ACTIVATION).completion).toMatchObject({
      kind: "failure",
    });
    expect(dismissCount).toBe(1);
  });

  it("delegates shell opening and explicit dismissal to renderer IPC capabilities", async () => {
    const snapshot = manyProjectsSnapshot();
    const shells: string[] = [];
    let dismissCount = 0;
    const capabilities = createDashboardCapabilities({
      clientState: new FakeStationSource(snapshot),
      observerService: new FakeTuiObserverService(snapshot),
      popupRuntime: {
        persistentPopup: true,
        exitOnFocusSuccess: false,
        openShell: async (cwd: string) => {
          shells.push(cwd);
        },
        dismissDashboard: async () => {
          dismissCount += 1;
        },
        dispose: () => {},
      },
      sessionCreatePolicies: {
        global: { focusCreatedSession: true, dismissDashboard: true },
        terminals: {},
      },
      exitRenderer: () => {},
    });

    expect(
      await capabilities.shell.open({ kind: "session", sessionId: ACTIVATION.sessionId }).completion,
    ).toEqual({ kind: "success" });
    expect(shells).toEqual(["/Users/example/.worktrees/station/pty-buffer"]);

    expect(await capabilities.dismissal.dismissDashboard().completion).toEqual({
      kind: "success",
    });
    expect(
      await capabilities.dismissal.exitRenderer({ exitCode: 0 }).completion,
    ).toEqual({ kind: "success" });
    expect(dismissCount).toBe(2);
  });

  it("selects the resolved policy from the durable create provider", async () => {
    const snapshot = manyProjectsSnapshot();
    const source = new FakeStationSource(snapshot);
    const service = new FakeTuiObserverService(snapshot);
    service.nextCompletion = {
      status: "succeeded",
      commandId: "cmd_tui_1",
      result: {
        type: "session.create",
        projectId: "station",
        worktreeId: "wt_station_idle",
        sessionId: "ses_wt_station_idle",
        requestedPlacement: "detached",
        resolvedPlacement: {
          provider: "tmux",
          targetId: "tmux:station:pty-buffer",
          generation: "1",
          presentation: "detached",
        },
      },
    };
    const capabilities = createDashboardCapabilities({
      clientState: source,
      observerService: service,
      popupRuntime: {
        persistentPopup: false,
        exitOnFocusSuccess: false,
        dispose: () => {},
      },
      sessionCreatePolicies: {
        global: { focusCreatedSession: true, dismissDashboard: true },
        terminals: {
          tmux: { focusCreatedSession: false, dismissDashboard: false },
        },
      },
      exitRenderer: () => {},
    });
    const project = snapshot.projects.find((candidate) => candidate.id === "station");
    if (project === undefined) throw new Error("station project fixture missing");

    await expect(
      capabilities.managedSessions.quickCreate({
        project,
        title: "Quick session",
        hiddenBranch: "pty-buffer",
        harness: "codex",
      }).completion,
    ).resolves.toMatchObject({
      kind: "success",
      createdSessionCommand: {
        target: {
          sessionId: "ses_wt_station_idle",
          worktreeId: "wt_station_idle",
          terminalProvider: "tmux",
        },
        policy: { focusCreatedSession: false, dismissDashboard: false },
      },
    });
  });
});

import { describe, expect, it } from "bun:test";
import type { StationSnapshot, WorktreeRow } from "@station/contracts";
import { createStationStore } from "../../state/store.js";
import { manyProjectsSnapshot } from "../../station/fixtures/scenarios.js";
import { FakeStationSource } from "../../station/test/support/fakeStationSource.js";
import { FakeTuiObserverService } from "../../station/test/support/fakeObserverService.js";
import { createManagedLaunch } from "./managedLaunch.js";

const CREATE_REQUEST = {
  projectId: "station",
  title: "Pty buffer",
  branch: "pty-buffer",
  harness: "codex" as const,
};

function launchHarness(snapshot: StationSnapshot, observer = true) {
  const service = new FakeTuiObserverService(snapshot);
  const launch = createManagedLaunch({
    store: createStationStore(),
    clientState: new FakeStationSource(snapshot),
    observerService: observer ? service : undefined,
    registry: undefined,
    managedTerminalAttacher: undefined,
  });
  return { launch, service };
}

function withoutIdleAgent(): StationSnapshot {
  const snapshot = manyProjectsSnapshot();
  return {
    ...snapshot,
    rows: snapshot.rows.map((row): WorktreeRow => {
      if (row.id !== "wt_station_idle") return row;
      const { agent: _agent, terminal: _terminal, ...bareRow } = row;
      return bareRow;
    }),
    sessions: snapshot.sessions.map((session) => {
      if (session.id !== "ses_wt_station_idle") return session;
      const { terminal: _terminal, ...detachedSession } = session;
      return detachedSession;
    }),
  };
}

describe("createManagedLaunch", () => {
  it("classifies missing Observer authority as a worktree failure", async () => {
    const { launch } = launchHarness(manyProjectsSnapshot(), false);

    expect(await launch.create(CREATE_REQUEST)).toMatchObject({
      kind: "failure",
      stage: "worktree",
      error: { code: "OBSERVER_UNAVAILABLE" },
    });
  });

  it("preserves the fork product request when worktree dispatch is rejected", async () => {
    const { launch, service } = launchHarness(manyProjectsSnapshot());
    service.nextReceipt = {
      commandId: "cmd_rejected",
      accepted: false,
      status: "rejected",
    };

    expect(
      await launch.fork({
        ...CREATE_REQUEST,
        sourceWorktreeId: "wt_station_working",
        copyDirty: true,
      }),
    ).toMatchObject({ kind: "failure", stage: "worktree" });
    expect(service.dispatched).toEqual([
      {
        type: "worktree.fork",
        payload: {
          projectId: "station",
          sourceWorktreeId: "wt_station_working",
          branch: "pty-buffer",
          copyDirty: true,
          launchHarness: "codex",
        },
      },
    ]);
  });

  it("classifies post-worktree preparation failures as launch failures", async () => {
    const { launch, service } = launchHarness(withoutIdleAgent());
    service.prepareExternalLaunch = async () => {
      throw new Error("prepare failed");
    };

    expect(await launch.create(CREATE_REQUEST)).toMatchObject({
      kind: "failure",
      stage: "launch",
    });
    expect(service.dispatched[0]).toEqual({
      type: "worktree.create",
      payload: {
        projectId: "station",
        branch: "pty-buffer",
        launchHarness: "codex",
      },
    });
  });
});

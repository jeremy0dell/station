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

const GROUP_FAILURE = {
  tag: "CommandValidationError" as const,
  code: "SESSION_GROUP_NOT_FOUND",
  message: "The selected Group no longer exists.",
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
        group: {
          kind: "source",
          sourceSessionId: "ses_wt_station_working",
          groupId: "group_active",
        },
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
          group: {
            kind: "source",
            sourceSessionId: "ses_wt_station_working",
            groupId: "group_active",
          },
        },
      },
    ]);
  });

  it("carries fork inheritance from worktree dispatch through external preparation", async () => {
    const { launch, service } = launchHarness(withoutIdleAgent());
    const group = {
      kind: "source" as const,
      sourceSessionId: "ses_wt_station_working" as const,
      groupId: "group_active" as const,
    };

    await launch.fork({
      ...CREATE_REQUEST,
      sourceWorktreeId: "wt_station_working",
      copyDirty: true,
      group,
    });

    expect(service.dispatched[0]).toMatchObject({
      type: "worktree.fork",
      payload: { group },
    });
    expect(service.preparedLaunches).toEqual([
      {
        projectId: "station",
        worktreeId: "wt_station_idle",
        title: "Pty buffer",
        harness: "codex",
        group,
      },
    ]);
  });

  it("classifies post-worktree preparation failures as launch failures", async () => {
    const { launch, service } = launchHarness(withoutIdleAgent());
    const prepared: Parameters<typeof service.prepareExternalLaunch>[0][] = [];
    service.prepareExternalLaunch = async (params) => {
      prepared.push(params);
      throw new Error("prepare failed");
    };

    expect(
      await launch.create({
        ...CREATE_REQUEST,
        group: { kind: "create", name: "Release" },
      }),
    ).toMatchObject({
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
    expect(prepared).toEqual([
      {
        projectId: "station",
        worktreeId: "wt_station_idle",
        title: "Pty buffer",
        harness: "codex",
        group: { kind: "create", name: "Release" },
      },
    ]);
  });

  it("rolls back the exact fresh worktree after Group placement rejection", async () => {
    const { launch, service } = launchHarness(withoutIdleAgent());
    service.prepareExternalLaunch = async () => {
      throw GROUP_FAILURE;
    };

    await expect(
      launch.create({
        ...CREATE_REQUEST,
        group: { kind: "existing", groupId: "grp_deleted" },
      }),
    ).resolves.toMatchObject({
      kind: "failure",
      stage: "worktree",
      error: { code: "SESSION_GROUP_NOT_FOUND" },
    });
    expect(service.dispatched[1]).toEqual({
      type: "worktree.remove",
      payload: {
        projectId: "station",
        worktreeId: "wt_station_idle",
        expectedPath: "/Users/example/.worktrees/station/pty-buffer",
        expectedBranch: "pty-buffer",
        expectedRegistrationIdentity: "git-registration:wt_station_idle",
      },
    });
  });

  it("retains the fresh worktree and prevents retry when safe rollback is unconfirmed", async () => {
    const { launch, service } = launchHarness(withoutIdleAgent());
    service.prepareExternalLaunch = async () => {
      service.nextCompletion = {
        status: "failed",
        commandId: "cmd_tui_1",
        error: {
          tag: "CommandConflictError",
          code: "WORKTREE_REMOVE_STALE_SELECTION",
          message: "The worktree changed before removal.",
        },
      };
      throw GROUP_FAILURE;
    };

    await expect(
      launch.create({
        ...CREATE_REQUEST,
        group: { kind: "existing", groupId: "grp_deleted" },
      }),
    ).resolves.toEqual({
      kind: "notice",
      notice: {
        kind: "error",
        message:
          "The selected Group no longer exists. Station kept the new worktree because safe rollback was not confirmed.",
        hint: "Refresh the dashboard, then open or remove that worktree before retrying this branch.",
      },
    });
    expect(service.dispatched.at(-1)?.type).toBe("worktree.remove");
  });

  it("does not remove a fresh worktree for unrelated preparation failures", async () => {
    const { launch, service } = launchHarness(withoutIdleAgent());
    service.prepareExternalLaunch = async () => {
      throw new Error("prepare failed");
    };

    await launch.create({
      ...CREATE_REQUEST,
      group: { kind: "existing", groupId: "grp_release" },
    });
    expect(service.dispatched.map((command) => command.type)).toEqual(["worktree.create"]);
  });
});

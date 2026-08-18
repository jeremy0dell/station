import { describe, expect, it } from "bun:test";
import type { StationCommand } from "@station/contracts";
import { createObserverWorktreeRemovalCapabilities } from "@station/dashboard-core/runtime";
import { createStationStore } from "../state/store.js";
import { agentWorktreePaneId } from "../state/types.js";
import { manyProjectsSnapshot } from "../station/fixtures/scenarios.js";
import { FakeTuiObserverService } from "../station/test/support/fakeObserverService.js";
import { FakeStationSource } from "../station/test/support/fakeStationSource.js";
import type { PtyRegistry } from "../terminal/registry/ptyRegistry.js";
import { prepareNativeWorktreeRemoval } from "./nativeWorktreeRemoval.js";

const WORKTREE_ID = "wt_station_idle";
const SESSION_ID = "ses_wt_station_idle";

function removeCommand(): Extract<StationCommand, { type: "worktree.remove" }> {
  const row = manyProjectsSnapshot().rows.find((candidate) => candidate.id === WORKTREE_ID);
  if (row?.registrationIdentity === undefined) {
    throw new Error("Fixture worktree must have registration identity.");
  }
  return {
    type: "worktree.remove",
    payload: {
      worktreeId: row.id,
      projectId: row.projectId,
      expectedPath: row.path,
      expectedBranch: row.branch,
      expectedRegistrationIdentity: row.registrationIdentity,
      force: true,
    },
  };
}

describe("native worktree removal", () => {
  it("closes and releases the local managed pane before dispatching worktree.remove", async () => {
    const snapshot = manyProjectsSnapshot();
    const source = new FakeStationSource(snapshot);
    const observer = new FakeTuiObserverService(snapshot);
    const store = createStationStore({ boot: "empty" });
    const paneId = agentWorktreePaneId(WORKTREE_ID);
    store.actions.createPane(paneId, { role: "primary-agent" });
    store.actions.setPrimaryAgent(paneId, {
      sessionId: SESSION_ID,
      terminalTargetId: `native:${WORKTREE_ID}`,
      terminalBindingToken: "binding_1",
    });
    let kills = 0;
    const registry = {
      get: () => ({ terminal: { kill: () => (kills += 1) } }),
    } as unknown as PtyRegistry;
    const order: string[] = [];
    const released: unknown[] = [];
    observer.reportExternalExit = async (params) => {
      order.push("release");
      released.push(params);
      const exited = {
        ...snapshot,
        rows: snapshot.rows.map((row) =>
          row.id === WORKTREE_ID && row.agent !== undefined
            ? { ...row, agent: { ...row.agent, state: "exited" as const } }
            : row,
        ),
        sessions: snapshot.sessions.map((session) =>
          session.id === SESSION_ID
            ? {
                ...session,
                status: { ...session.status, value: "exited" as const },
              }
            : session,
        ),
      };
      source.setSnapshot(exited);
      observer.setSnapshot(exited);
      return { acknowledged: true, terminalTargetId: params.terminalTargetId };
    };
    const originalDispatch = observer.dispatch.bind(observer);
    observer.dispatch = async (command) => {
      order.push(command.type);
      return originalDispatch(command);
    };
    const removal = createObserverWorktreeRemovalCapabilities({
      service: observer,
      clientLabel: "Station",
      beforeRemove: (request) =>
        prepareNativeWorktreeRemoval(
          { service: observer, clientState: source, store, registry },
          request.worktreeId,
        ),
    });

    await removal.remove({ worktreeId: WORKTREE_ID, command: removeCommand() }).completion;

    expect(order).toEqual(["release", "worktree.remove"]);
    expect(kills).toBe(1);
    expect(store.getState().workspace.panes).toEqual([]);
    expect(released).toEqual([
      {
        terminalTargetId: `native:${WORKTREE_ID}`,
        expectedSessionId: SESSION_ID,
        expectedBindingToken: "binding_1",
      },
    ]);
    expect(observer.reconcileReasons).toEqual(["station.worktree.remove.local-pane-close"]);
  });
});

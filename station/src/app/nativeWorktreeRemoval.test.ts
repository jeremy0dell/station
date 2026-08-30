import { describe, expect, it } from "bun:test";
import type { StationCommand, StationSnapshot } from "@station/contracts";
import { createObserverWorktreeRemovalCapabilities } from "@station/dashboard-core/runtime";
import { createStationStore } from "../state/store.js";
import { agentWorktreePaneId } from "../state/types.js";
import { manyProjectsSnapshot } from "../station/fixtures/scenarios.js";
import { FakeTuiObserverService } from "../station/test/support/fakeObserverService.js";
import { FakeStationSource } from "../station/test/support/fakeStationSource.js";
import type { PtyRegistry } from "../terminal/registry/ptyRegistry.js";
import {
  finalizeNativeWorktreeRemoval,
  prepareNativeWorktreeRemoval,
} from "./nativeWorktreeRemoval.js";

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
  it("proves local fallback PTY exit despite provider-wide Host close capability", async () => {
    const base = manyProjectsSnapshot();
    const snapshot: StationSnapshot = {
      ...base,
      providerHealth: {
        ...base.providerHealth,
        native: {
          provider: "native",
          providerType: "terminal",
          status: "healthy",
          lastCheckedAt: base.generatedAt,
          capabilities: { canCloseTarget: true },
        },
      },
      rows: base.rows.map((row) =>
        row.id === WORKTREE_ID
          ? {
              ...row,
              terminal: { provider: "native", state: "open" as const, closeable: false },
            }
          : row,
      ),
    };
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
    let confirmExit!: () => void;
    const exit = new Promise<void>((resolve) => {
      confirmExit = resolve;
    });
    const registry = {
      terminate: async () => {
        kills += 1;
        await exit;
      },
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
      afterRemove: (request) =>
        finalizeNativeWorktreeRemoval({ store }, request.worktreeId),
    });

    const completion = removal.remove({
      worktreeId: WORKTREE_ID,
      command: removeCommand(),
    }).completion;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual([]);
    expect(store.getState().workspace.panes).toHaveLength(1);

    confirmExit();
    await completion;

    expect(order).toEqual(["release", "worktree.remove"]);
    expect(observer.preparedRemovals).toHaveLength(1);
    expect(observer.dispatched.at(-1)).toMatchObject({
      type: "worktree.remove",
      payload: { removalReservationId: "reservation_1" },
    });
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

  it("keeps the worktree and pane when canonical exit reconciliation fails", async () => {
    const snapshot = manyProjectsSnapshot();
    const source = new FakeStationSource(snapshot);
    const observer = new FakeTuiObserverService(snapshot);
    observer.nextReconcileError = {
      tag: "ObserverUnavailableError",
      code: "OBSERVER_RECONCILE_FAILED",
      message: "reconcile failed",
    };
    const store = createStationStore({ boot: "empty" });
    const paneId = agentWorktreePaneId(WORKTREE_ID);
    store.actions.createPane(paneId, { role: "primary-agent", worktreeId: WORKTREE_ID });
    store.actions.setPrimaryAgent(paneId, {
      sessionId: SESSION_ID,
      terminalTargetId: `native:${WORKTREE_ID}`,
      terminalBindingToken: "binding_1",
    });
    const registry = { terminate: async () => undefined } as unknown as PtyRegistry;
    const removal = createObserverWorktreeRemovalCapabilities({
      service: observer,
      beforeRemove: (request) =>
        prepareNativeWorktreeRemoval(
          { service: observer, clientState: source, store, registry },
          request.worktreeId,
        ),
      afterRemove: (request) =>
        finalizeNativeWorktreeRemoval({ store }, request.worktreeId),
    });

    await expect(
      removal.remove({ worktreeId: WORKTREE_ID, command: removeCommand() }).completion,
    ).resolves.toMatchObject({
      kind: "failure",
      error: { code: "OBSERVER_RECONCILE_FAILED" },
    });
    expect(observer.dispatched.some((command) => command.type === "worktree.remove")).toBe(false);
    expect(observer.cancelledRemovalReservations).toEqual(["reservation_1"]);
    expect(store.getState().workspace.panes.map((pane) => pane.id)).toEqual([paneId]);
  });

  it("fails closed when canonical state remains running at the exit deadline", async () => {
    const snapshot = manyProjectsSnapshot();
    const source = new FakeStationSource(snapshot);
    const observer = new FakeTuiObserverService(snapshot);
    const store = createStationStore({ boot: "empty" });
    const paneId = agentWorktreePaneId(WORKTREE_ID);
    store.actions.createPane(paneId, { role: "primary-agent", worktreeId: WORKTREE_ID });
    store.actions.setPrimaryAgent(paneId, {
      sessionId: SESSION_ID,
      terminalTargetId: `native:${WORKTREE_ID}`,
      terminalBindingToken: "binding_1",
    });
    const registry = { terminate: async () => undefined } as unknown as PtyRegistry;
    const removal = createObserverWorktreeRemovalCapabilities({
      service: observer,
      beforeRemove: (request) =>
        prepareNativeWorktreeRemoval(
          {
            service: observer,
            clientState: source,
            store,
            registry,
            exitSettleTimeoutMs: 1,
          },
          request.worktreeId,
        ),
    });

    await expect(
      removal.remove({ worktreeId: WORKTREE_ID, command: removeCommand() }).completion,
    ).resolves.toMatchObject({
      kind: "failure",
      error: { code: "TERMINAL_EXIT_NOT_CONFIRMED" },
    });
    expect(observer.dispatched.some((command) => command.type === "worktree.remove")).toBe(false);
    expect(observer.cancelledRemovalReservations).toEqual(["reservation_1"]);
  });

  it("removes retained Host layout without emitting a tokenless release", async () => {
    const base = manyProjectsSnapshot();
    const snapshot = {
      ...base,
      rows: base.rows.map((row) =>
        row.id === WORKTREE_ID
          ? {
              ...row,
              terminal: { provider: "managed-terminal", state: "open" as const, closeable: true },
            }
          : row,
      ),
    };
    const source = new FakeStationSource(snapshot);
    const observer = new FakeTuiObserverService(snapshot);
    const store = createStationStore({ boot: "empty" });
    const paneId = agentWorktreePaneId(WORKTREE_ID);
    store.actions.createPane(paneId, { role: "primary-agent", worktreeId: WORKTREE_ID });
    store.actions.setPrimaryAgent(paneId, {
      sessionId: SESSION_ID,
      terminalTargetId: `native:${WORKTREE_ID}`,
      terminalBindingToken: "binding_host",
      processOwner: "host",
    });
    let terminations = 0;
    const registry = {
      terminate: async () => {
        terminations += 1;
      },
    } as unknown as PtyRegistry;
    const removal = createObserverWorktreeRemovalCapabilities({
      service: observer,
      beforeRemove: (request) =>
        prepareNativeWorktreeRemoval(
          { service: observer, clientState: source, store, registry },
          request.worktreeId,
        ),
      afterRemove: (request) =>
        finalizeNativeWorktreeRemoval({ store }, request.worktreeId),
    });

    await removal.remove({ worktreeId: WORKTREE_ID, command: removeCommand() }).completion;
    expect(terminations).toBe(0);
    expect(observer.reportedExits).toEqual([]);
    expect(store.getState().workspace.panes).toEqual([]);
  });

  it("retains child worktree ownership across Close Pane and settles it on Delete", async () => {
    const base = manyProjectsSnapshot();
    const snapshot = {
      ...base,
      rows: base.rows.map((row) =>
        row.id === WORKTREE_ID
          ? {
              ...row,
              terminal: { provider: "managed-terminal", state: "open" as const, closeable: true },
            }
          : row,
      ),
    };
    const source = new FakeStationSource(snapshot);
    const observer = new FakeTuiObserverService(snapshot);
    const store = createStationStore({ boot: "empty" });
    const paneId = agentWorktreePaneId(WORKTREE_ID);
    const childId = "pane-split-owned";
    store.actions.createPane(paneId, { role: "primary-agent", worktreeId: WORKTREE_ID });
    store.actions.setPrimaryAgent(paneId, {
      sessionId: SESSION_ID,
      terminalTargetId: `native:${WORKTREE_ID}`,
    });
    store.actions.createPane(childId, {
      split: { anchorPaneId: paneId, direction: "right" },
      worktreeId: WORKTREE_ID,
    });
    store.actions.closePane(paneId);
    expect(store.getState().workspace.panes).toMatchObject([
      { id: childId, worktreeId: WORKTREE_ID },
    ]);
    const terminated: string[] = [];
    const registry = {
      terminate: async (id: string) => {
        terminated.push(id);
      },
    } as unknown as PtyRegistry;
    const removal = createObserverWorktreeRemovalCapabilities({
      service: observer,
      beforeRemove: (request) =>
        prepareNativeWorktreeRemoval(
          { service: observer, clientState: source, store, registry },
          request.worktreeId,
        ),
      afterRemove: (request) =>
        finalizeNativeWorktreeRemoval({ store }, request.worktreeId),
    });

    await removal.remove({ worktreeId: WORKTREE_ID, command: removeCommand() }).completion;
    expect(terminated).toEqual([childId]);
    expect(store.getState().workspace.panes).toEqual([]);
  });
});

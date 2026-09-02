import type { ReconcileReceipt } from "@station/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  reconcilePersistedState,
  requireCurrentObserverIdentity,
} from "../../src/persistedStateReconcile.js";

const expectedObserverIdentity = {
  pid: 41,
  startedAt: "2026-08-24T12:00:00.000Z",
  version: `0.0.0-local+station.${"a".repeat(64)}`,
  socketPath: "/tmp/station-observer.sock",
};

const receipt: ReconcileReceipt = {
  schemaVersion: "0.13.0",
  reason: "manual",
  reconciledAt: "2026-08-24T12:01:00.000Z",
  snapshot: {
    schemaVersion: "0.13.0",
    generatedAt: "2026-08-24T12:01:00.000Z",
    projects: [],
    worktrees: [],
    sessionGroups: [],
    sessions: [],
    terminalTargets: [],
    harnessRuns: [],
    commands: [],
    diagnostics: [],
  },
};

describe("reconcilePersistedState", () => {
  it("pins the exact Observer identity and preserves an absent reason", async () => {
    const reconcile = vi.fn(async () => receipt);
    const connect = vi.fn(() => ({ reconcile }));

    await expect(
      reconcilePersistedState(
        {
          observerIdentity: expectedObserverIdentity,
          timeoutMs: 50,
        },
        connect,
      ),
    ).resolves.toEqual(receipt);

    expect(connect).toHaveBeenCalledWith({
      timeoutMs: 50,
      observerIdentity: expectedObserverIdentity,
    });
    expect(reconcile).toHaveBeenCalledWith(undefined);
  });

  it("passes a reason without gaining lifecycle methods", async () => {
    const reconcile = vi.fn(async () => receipt);
    await reconcilePersistedState(
      {
        observerIdentity: expectedObserverIdentity,
        reason: "manual",
        timeoutMs: 50,
      },
      () => ({ reconcile }),
    );
    expect(reconcile).toHaveBeenCalledWith("manual");
  });

  it("defaults an absent caller timeout before creating reconcile authority", async () => {
    const reconcile = vi.fn(async () => receipt);
    const connect = vi.fn(() => ({ reconcile }));

    await reconcilePersistedState({ observerIdentity: expectedObserverIdentity }, connect);

    expect(connect).toHaveBeenCalledWith({
      observerIdentity: expectedObserverIdentity,
      timeoutMs: 30_000,
    });
    expect(reconcile).toHaveBeenCalledWith(undefined);
  });

  it("fails closed before client creation without current build identity", async () => {
    const connect = vi.fn(() => ({ reconcile: vi.fn(async () => receipt) }));
    await expect(
      reconcilePersistedState(
        {
          observerIdentity: { ...expectedObserverIdentity, version: "0.0.0-local" },
          timeoutMs: 50,
        },
        connect,
      ),
    ).rejects.toMatchObject({
      tag: "ReconcileCommandError",
      code: "RECONCILE_OBSERVER_IDENTITY_REQUIRED",
    });
    expect(connect).not.toHaveBeenCalled();
  });

  it("rejects absent or different health sockets with reconcile-specific evidence", () => {
    const { socketPath: _socketPath, ...healthWithoutSocket } = expectedObserverIdentity;
    for (const health of [
      healthWithoutSocket,
      { ...expectedObserverIdentity, socketPath: "/tmp/other-observer.sock" },
    ]) {
      expect(() =>
        requireCurrentObserverIdentity(health, expectedObserverIdentity.socketPath),
      ).toThrow(expect.objectContaining({ code: "RECONCILE_OBSERVER_IDENTITY_REQUIRED" }));
    }
  });
});

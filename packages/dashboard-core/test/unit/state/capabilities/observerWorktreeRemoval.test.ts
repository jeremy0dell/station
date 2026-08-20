import type { StationCommand } from "@station/contracts";
import { describe, expect, it } from "vitest";
import { createObserverWorktreeRemovalCapabilities } from "../../../../src/state/capabilities/worktreeRemoval.js";
import { createDashboardSnapshot } from "../../../fixtures/snapshots.js";
import { FakeTuiObserverService } from "../../../support/fakeObserverService.js";

function command(): Extract<StationCommand, { type: "worktree.remove" }> {
  const row = createDashboardSnapshot().rows.find((candidate) => candidate.id === "wt_web_idle");
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

describe("Observer worktree removal capabilities", () => {
  it("settles renderer cleanup before dispatching and waiting for worktree.remove", async () => {
    const service = new FakeTuiObserverService(createDashboardSnapshot());
    const order: string[] = [];
    const originalPrepare = service.prepareWorktreeRemoval.bind(service);
    service.prepareWorktreeRemoval = async (params) => {
      order.push("prepareRemoval");
      return originalPrepare(params);
    };
    const originalDispatch = service.dispatch.bind(service);
    service.dispatch = async (next) => {
      order.push(next.type);
      return originalDispatch(next);
    };
    const capability = createObserverWorktreeRemovalCapabilities({
      service,
      beforeRemove: async () => {
        order.push("beforeRemove");
      },
      afterRemove: async () => {
        order.push("afterRemove");
      },
    });
    const nextCommand = command();
    const handle = capability.remove({
      worktreeId: nextCommand.payload.worktreeId,
      command: nextCommand,
    });

    expect(handle.successDisposition).toBe("wait-for-canonical");
    await expect(handle.completion).resolves.toEqual({ kind: "success" });
    expect(order).toEqual(["prepareRemoval", "beforeRemove", "worktree.remove", "afterRemove"]);
    expect(service.dispatched[0]).toMatchObject({
      type: "worktree.remove",
      payload: { removalReservationId: "reservation_tui_1" },
    });
    expect(service.waitedForCommandIds).toEqual([service.nextReceipt.commandId]);
  });

  it("refuses externally owned PTYs when this renderer has no settlement capability", async () => {
    const service = new FakeTuiObserverService(createDashboardSnapshot());
    const originalPrepare = service.prepareWorktreeRemoval.bind(service);
    service.prepareWorktreeRemoval = async (params) => ({
      ...(await originalPrepare(params)),
      externalTerminalExitRequired: true,
    });
    let cancelled = 0;
    service.cancelWorktreeRemoval = async () => {
      cancelled += 1;
      return { cancelled: true };
    };
    const capability = createObserverWorktreeRemovalCapabilities({ service });
    const nextCommand = command();

    await expect(
      capability.remove({
        worktreeId: nextCommand.payload.worktreeId,
        command: nextCommand,
      }).completion,
    ).resolves.toMatchObject({
      kind: "failure",
      error: { code: "EXTERNAL_TERMINAL_SETTLEMENT_UNAVAILABLE" },
    });
    expect(service.dispatched).toEqual([]);
    expect(cancelled).toBe(1);
  });

  it("does not mutate renderer state when authoritative preparation refuses", async () => {
    const service = new FakeTuiObserverService(createDashboardSnapshot());
    service.prepareWorktreeRemoval = async () => {
      throw {
        tag: "CommandValidationError",
        code: "WORKTREE_REMOVE_STALE_SELECTION",
        message: "The selected worktree changed.",
      };
    };
    let rendererCalls = 0;
    const capability = createObserverWorktreeRemovalCapabilities({
      service,
      beforeRemove: async () => {
        rendererCalls += 1;
      },
    });
    const nextCommand = command();

    await expect(
      capability.remove({
        worktreeId: nextCommand.payload.worktreeId,
        command: nextCommand,
      }).completion,
    ).resolves.toMatchObject({
      kind: "failure",
      error: { code: "WORKTREE_REMOVE_STALE_SELECTION" },
    });
    expect(rendererCalls).toBe(0);
    expect(service.dispatched).toEqual([]);
  });

  it("does not dispatch when renderer-owned cleanup fails", async () => {
    const service = new FakeTuiObserverService(createDashboardSnapshot());
    let cancelled = 0;
    service.cancelWorktreeRemoval = async () => {
      cancelled += 1;
      return { cancelled: true };
    };
    const capability = createObserverWorktreeRemovalCapabilities({
      service,
      beforeRemove: async () => {
        throw {
          tag: "TerminalProviderError",
          code: "NATIVE_PANE_CLOSE_FAILED",
          message: "Station could not close the native pane.",
        };
      },
    });
    const nextCommand = command();

    await expect(
      capability.remove({
        worktreeId: nextCommand.payload.worktreeId,
        command: nextCommand,
      }).completion,
    ).resolves.toMatchObject({
      kind: "failure",
      error: { code: "NATIVE_PANE_CLOSE_FAILED" },
    });
    expect(service.dispatched).toEqual([]);
    expect(cancelled).toBe(1);
  });
});

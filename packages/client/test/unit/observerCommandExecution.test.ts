import {
  type ObserverService,
  type StationClientCommandCompletion,
  safeErrorToNotice,
} from "@station/client";
import type {
  CommandReceipt,
  SafeError,
  StationCommand,
  StationSnapshot,
} from "@station/contracts";
import { describe, expect, it, vi } from "vitest";
import { executeObserverCommand } from "../../src/index.js";
import { createCommandSnapshot, sessionGroup } from "../support/snapshots.js";

const command: StationCommand = {
  type: "terminal.focus",
  payload: { sessionId: "ses_command" },
};

const groupCommand: StationCommand = {
  type: "sessionGroup.create",
  payload: { projectId: "web", name: "Active work" },
};

describe("executeObserverCommand", () => {
  it("normalizes rejection without waiting", async () => {
    const service = commandService({
      receipt: {
        accepted: false,
        status: "rejected",
        commandId: "cmd_rejected",
        traceId: "trace_rejected",
      },
    });

    await expect(executeObserverCommand(service, command)).resolves.toMatchObject({
      status: "rejected",
      receipt: { commandId: "cmd_rejected", traceId: "trace_rejected" },
      error: {
        code: "COMMAND_REJECTED",
        commandId: "cmd_rejected",
        traceId: "trace_rejected",
      },
    });
    expect(service.waitForCommandCompletion).not.toHaveBeenCalled();
    expect(service.loadSnapshot).not.toHaveBeenCalled();
  });

  it("returns acceptance without observing completion when requested", async () => {
    const service = commandService();

    await expect(
      executeObserverCommand(service, command, { waitForCompletion: false }),
    ).resolves.toMatchObject({ status: "accepted", receipt: { commandId: "cmd_accepted" } });
    expect(service.waitForCommandCompletion).not.toHaveBeenCalled();
    expect(service.loadSnapshot).not.toHaveBeenCalled();
  });

  it("normalizes successful and failed completion exactly once", async () => {
    const succeeded = commandService();
    await expect(executeObserverCommand(succeeded, command)).resolves.toMatchObject({
      status: "succeeded",
      receipt: { commandId: "cmd_accepted" },
    });
    expect(succeeded.dispatch).toHaveBeenCalledTimes(1);
    expect(succeeded.waitForCommandCompletion).toHaveBeenCalledTimes(1);
    expect(succeeded.loadSnapshot).not.toHaveBeenCalled();

    const failed = commandService({
      completion: {
        status: "failed",
        commandId: "cmd_accepted",
        error: {
          tag: "CommandExecutionError",
          code: "FOCUS_FAILED",
          message: "Focus failed.",
        },
      },
    });
    await expect(executeObserverCommand(failed, command)).resolves.toMatchObject({
      status: "failed",
      error: { code: "FOCUS_FAILED", commandId: "cmd_accepted" },
    });
    expect(failed.dispatch).toHaveBeenCalledTimes(1);
    expect(failed.waitForCommandCompletion).toHaveBeenCalledTimes(1);
    expect(failed.loadSnapshot).not.toHaveBeenCalled();
  });

  it("loads canonical state after accepted Group terminal outcomes", async () => {
    const succeeded = commandService();
    await expect(executeObserverCommand(succeeded, groupCommand)).resolves.toMatchObject({
      status: "succeeded",
      receipt: { commandId: "cmd_accepted" },
    });
    expect(succeeded.loadSnapshot).toHaveBeenCalledTimes(1);
    expect(succeeded.waitForCommandCompletion.mock.invocationCallOrder[0]).toBeLessThan(
      succeeded.loadSnapshot.mock.invocationCallOrder[0] ?? 0,
    );

    const failed = commandService({
      completion: {
        status: "failed",
        commandId: "cmd_accepted",
        error: {
          tag: "CommandConflictError",
          code: "SESSION_GROUP_VERSION_CONFLICT",
          message: "The Group changed.",
        },
      },
    });
    await expect(executeObserverCommand(failed, groupCommand)).resolves.toMatchObject({
      status: "failed",
      error: { code: "SESSION_GROUP_VERSION_CONFLICT", commandId: "cmd_accepted" },
    });
    expect(failed.loadSnapshot).toHaveBeenCalledTimes(1);
  });

  it("returns a thrown result with receipt identity when the post-Group load fails", async () => {
    const service = commandService({ loadError: new Error("snapshot closed") });

    await expect(
      executeObserverCommand(service, groupCommand, { clientLabel: "Station" }),
    ).resolves.toMatchObject({
      status: "thrown",
      receipt: { commandId: "cmd_accepted" },
      error: { code: "CLIENT_OBSERVER_OPERATION_FAILED", commandId: "cmd_accepted" },
    });
  });

  it.each([
    ["grouped", 'The session\'s Group changed; it is now in "Destination".', true],
    ["ungrouped", "The session's Group changed; it is now ungrouped.", false],
  ] as const)("normalizes a stale single-session assignment to its %s destination", async (_, message, grouped) => {
    const snapshot = createCommandSnapshot("idle");
    const sessionId = snapshot.sessions[0]?.id;
    if (sessionId === undefined) throw new Error("Expected an idle fixture session.");
    if (grouped) {
      snapshot.sessionGroups = [
        sessionGroup({ id: "grp_destination", name: "Destination", sessionIds: [sessionId] }),
      ];
    }
    const error = assignmentConflictError();
    const service = commandService({
      snapshot,
      receipt: {
        accepted: true,
        status: "accepted",
        commandId: "cmd_accepted",
        traceId: "trace_receipt",
      },
      completion: { status: "failed", commandId: "cmd_accepted", error },
    });
    const membershipCommand: StationCommand = {
      type: "sessionGroup.updateMembership",
      payload: {
        projectId: "web",
        groupId: "grp_destination",
        expectedVersion: 1,
        add: [{ sessionId, expectedGroupId: null }],
      },
    };

    const result = await executeObserverCommand(service, membershipCommand);
    expect(result).toEqual({
      status: "failed",
      receipt: {
        accepted: true,
        status: "accepted",
        commandId: "cmd_accepted",
        traceId: "trace_receipt",
      },
      error: {
        ...error,
        message,
        hint: "Review the canonical destination before retrying the membership change.",
        sessionId,
      },
    });
    if (result.status !== "failed") throw new Error("Expected a failed command result.");
    expect(safeErrorToNotice(result.error)).toEqual({
      kind: "error",
      message,
      hint: "Review the canonical destination before retrying the membership change.",
      commandId: "cmd_accepted",
      traceId: "trace_original",
      diagnosticId: "diag_assignment",
    });
  });

  it("preserves the generic assignment conflict when the referenced session disappeared", async () => {
    const snapshot = createCommandSnapshot("idle");
    const sessionId = snapshot.sessions[0]?.id;
    if (sessionId === undefined) throw new Error("Expected an idle fixture session.");
    snapshot.sessions = [];
    const error = assignmentConflictError();
    const service = commandService({
      snapshot,
      completion: { status: "failed", commandId: "cmd_accepted", error },
    });

    await expect(
      executeObserverCommand(service, {
        type: "sessionGroup.updateMembership",
        payload: {
          projectId: "web",
          groupId: "grp_destination",
          expectedVersion: 1,
          remove: [{ sessionId, expectedGroupId: "grp_destination" }],
        },
      }),
    ).resolves.toEqual({
      status: "failed",
      receipt: { accepted: true, status: "accepted", commandId: "cmd_accepted" },
      error,
    });
  });

  it("preserves the generic assignment conflict when multiple sessions were referenced", async () => {
    const snapshot = createCommandSnapshot("idle");
    const session = snapshot.sessions[0];
    if (session === undefined) throw new Error("Expected an idle fixture session.");
    const secondSession = { ...session, id: "ses_web_second" };
    snapshot.sessions = [session, secondSession];
    const error = assignmentConflictError();
    const service = commandService({
      snapshot,
      completion: { status: "failed", commandId: "cmd_accepted", error },
    });

    await expect(
      executeObserverCommand(service, {
        type: "sessionGroup.updateMembership",
        payload: {
          projectId: "web",
          groupId: "grp_destination",
          expectedVersion: 1,
          add: [
            { sessionId: session.id, expectedGroupId: null },
            { sessionId: secondSession.id, expectedGroupId: null },
          ],
        },
      }),
    ).resolves.toEqual({
      status: "failed",
      receipt: { accepted: true, status: "accepted", commandId: "cmd_accepted" },
      error,
    });
  });

  it("normalizes thrown dispatch and completion failures with receipt identity", async () => {
    const dispatchFailure = commandService({ dispatchError: new Error("socket closed") });
    await expect(
      executeObserverCommand(dispatchFailure, command, { clientLabel: "Station" }),
    ).resolves.toMatchObject({
      status: "thrown",
      error: { code: "CLIENT_OBSERVER_OPERATION_FAILED" },
    });
    expect(dispatchFailure.waitForCommandCompletion).not.toHaveBeenCalled();
    expect(dispatchFailure.loadSnapshot).not.toHaveBeenCalled();

    const waitFailure = commandService({ waitError: new Error("wait closed") });
    await expect(
      executeObserverCommand(waitFailure, command, { clientLabel: "Station" }),
    ).resolves.toMatchObject({
      status: "thrown",
      receipt: { commandId: "cmd_accepted" },
      error: { commandId: "cmd_accepted" },
    });
    expect(waitFailure.dispatch).toHaveBeenCalledTimes(1);
    expect(waitFailure.waitForCommandCompletion).toHaveBeenCalledTimes(1);
    expect(waitFailure.loadSnapshot).not.toHaveBeenCalled();
  });
});

function commandService(
  options: {
    receipt?: CommandReceipt;
    completion?: StationClientCommandCompletion;
    dispatchError?: unknown;
    waitError?: unknown;
    loadError?: unknown;
    snapshot?: StationSnapshot;
  } = {},
): ObserverService & {
  dispatch: ReturnType<typeof vi.fn<ObserverService["dispatch"]>>;
  waitForCommandCompletion: ReturnType<typeof vi.fn<ObserverService["waitForCommandCompletion"]>>;
  loadSnapshot: ReturnType<typeof vi.fn<ObserverService["loadSnapshot"]>>;
} {
  const receipt =
    options.receipt ??
    ({ accepted: true, status: "accepted", commandId: "cmd_accepted" } satisfies CommandReceipt);
  const completion =
    options.completion ??
    ({
      status: "succeeded",
      commandId: receipt.commandId,
    } satisfies StationClientCommandCompletion);
  const dispatch = vi.fn<ObserverService["dispatch"]>(async () => {
    if (options.dispatchError !== undefined) throw options.dispatchError;
    return receipt;
  });
  const waitForCommandCompletion = vi.fn<ObserverService["waitForCommandCompletion"]>(async () => {
    if (options.waitError !== undefined) throw options.waitError;
    return completion;
  });
  const loadSnapshot = vi.fn<ObserverService["loadSnapshot"]>(async () => {
    if (options.loadError !== undefined) throw options.loadError;
    return options.snapshot ?? createCommandSnapshot("idle");
  });
  return {
    loadSnapshot,
    subscribeEvents: async function* () {},
    dispatch,
    waitForCommandCompletion,
    reconcile: async () => createCommandSnapshot("idle"),
    prepareExternalLaunch: async () => {
      throw new Error("not used");
    },
    reportExternalExit: async () => {
      throw new Error("not used");
    },
    prepareWorktreeRemoval: async () => {
      throw new Error("not used");
    },
    cancelWorktreeRemoval: async () => ({ cancelled: false }),
  };
}

function assignmentConflictError(): SafeError {
  return {
    tag: "CommandConflictError",
    code: "SESSION_GROUP_ASSIGNMENT_CONFLICT",
    message: "A session's current Group assignment did not match the command expectation.",
    hint: "Refresh the canonical Group state before retrying the membership change.",
    projectId: "web",
    commandId: "cmd_accepted",
    traceId: "trace_original",
    diagnosticId: "diag_assignment",
  };
}

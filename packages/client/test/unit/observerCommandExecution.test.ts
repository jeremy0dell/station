import type { ObserverService, StationClientCommandCompletion } from "@station/client";
import type { CommandReceipt, StationCommand } from "@station/contracts";
import { describe, expect, it, vi } from "vitest";
import { executeObserverCommand } from "../../src/index.js";
import { createCommandSnapshot } from "../support/snapshots.js";

const command: StationCommand = {
  type: "terminal.focus",
  payload: { sessionId: "ses_command" },
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
  });

  it("returns acceptance without observing completion when requested", async () => {
    const service = commandService();

    await expect(
      executeObserverCommand(service, command, { waitForCompletion: false }),
    ).resolves.toMatchObject({ status: "accepted", receipt: { commandId: "cmd_accepted" } });
    expect(service.waitForCommandCompletion).not.toHaveBeenCalled();
  });

  it("normalizes successful and failed completion exactly once", async () => {
    const succeeded = commandService();
    await expect(executeObserverCommand(succeeded, command)).resolves.toMatchObject({
      status: "succeeded",
      receipt: { commandId: "cmd_accepted" },
    });
    expect(succeeded.dispatch).toHaveBeenCalledTimes(1);
    expect(succeeded.waitForCommandCompletion).toHaveBeenCalledTimes(1);

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
  });
});

function commandService(
  options: {
    receipt?: CommandReceipt;
    completion?: StationClientCommandCompletion;
    dispatchError?: unknown;
    waitError?: unknown;
  } = {},
): ObserverService & {
  dispatch: ReturnType<typeof vi.fn<ObserverService["dispatch"]>>;
  waitForCommandCompletion: ReturnType<typeof vi.fn<ObserverService["waitForCommandCompletion"]>>;
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
  return {
    loadSnapshot: async () => createCommandSnapshot("idle"),
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
  };
}

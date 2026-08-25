import type { CommandRecord, FailedCommandRecord, StationCommand } from "../../src/index.js";

const command = {
  type: "worktree.create",
  payload: { projectId: "web", branch: "feature/type-safety" },
} as const satisfies StationCommand;

const legacySuccess: CommandRecord = {
  id: "cmd_legacy",
  type: command.type,
  command,
  status: "succeeded",
  createdAt: "2026-05-20T12:00:00.000Z",
};

const successWithResult: CommandRecord = {
  id: "cmd_succeeded",
  type: command.type,
  command,
  status: "succeeded",
  createdAt: "2026-05-20T12:00:00.000Z",
  result: {
    type: "worktree.create",
    projectId: "web",
    worktreeId: "wt_created",
  },
};

const failureWithoutResult: FailedCommandRecord = {
  id: "cmd_failed_without_result",
  type: command.type,
  command,
  status: "failed",
  createdAt: "2026-05-20T12:00:00.000Z",
};

const impossibleResult = {
  type: "worktree.create",
  projectId: "web",
  worktreeId: "wt_impossible",
} as const;

// @ts-expect-error Failed records cannot retain a success result.
const failedWithResult: CommandRecord = {
  id: "cmd_failed",
  type: command.type,
  command,
  status: "failed",
  createdAt: "2026-05-20T12:00:00.000Z",
  result: impossibleResult,
};

void legacySuccess;
void successWithResult;
void failureWithoutResult;
void failedWithResult;

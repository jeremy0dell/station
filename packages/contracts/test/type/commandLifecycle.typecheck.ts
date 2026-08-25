import type {
  CommandExecutionOutcome,
  CommandRecord,
  FailedCommandRecord,
  StationCommand,
} from "../../src/index.js";

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

const typedSuccess = {
  status: "succeeded",
  receipt: {
    commandId: "cmd_typed_success",
    accepted: true,
    status: "accepted",
  },
  record: {
    id: "cmd_typed_success",
    type: command.type,
    command,
    status: "succeeded",
    createdAt: "2026-05-20T12:00:00.000Z",
    result: {
      type: "worktree.create",
      projectId: "web",
      worktreeId: "wt_typed",
    },
  },
} satisfies CommandExecutionOutcome<typeof command>;

type TypedWorktreeResult = NonNullable<
  Extract<CommandExecutionOutcome<typeof command>, { status: "succeeded" }>["record"]["result"]
>;

const mismatchedTypedResult = {
  // @ts-expect-error The generic outcome accepts only the submitted command subtype's result.
  type: "session.create",
  projectId: "web",
  worktreeId: "wt_mismatched",
  sessionId: "ses_mismatched",
} satisfies TypedWorktreeResult;

const projectCommand = {
  type: "project.add",
  payload: { path: "/tmp/station/web" },
} as const satisfies StationCommand;

type ProjectSuccessRecord = Extract<
  CommandExecutionOutcome<typeof projectCommand>,
  { status: "succeeded" }
>["record"];

const projectSuccessWithInventedResult = {
  id: "cmd_project",
  type: projectCommand.type,
  command: projectCommand,
  status: "succeeded",
  createdAt: "2026-05-20T12:00:00.000Z",
  // @ts-expect-error Result-less project commands cannot invent a success result.
  result: {
    type: "worktree.create",
    projectId: "web",
    worktreeId: "wt_impossible",
  },
} satisfies ProjectSuccessRecord;

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
void typedSuccess;
void mismatchedTypedResult;
void projectSuccessWithInventedResult;
void failureWithoutResult;
void failedWithResult;

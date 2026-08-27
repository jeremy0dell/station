import type { SessionCreateCommandResult } from "@station/contracts";
import type { ParsedForkSessionArgs } from "../../src/commands/session/args.js";
import type {
  SessionCommandResult,
  SessionCreationOutcome,
} from "../../src/commands/session/result.js";

const omittedCopyDirty: ParsedForkSessionArgs = {
  action: "fork",
  sourceSessionId: "ses_source",
  branch: "feature/fork",
  group: "default",
  outputFormat: "json",
  placement: { kind: "terminal", provider: "tmux" },
  promptStdin: false,
};

const explicitCopyDirty: ParsedForkSessionArgs = {
  ...omittedCopyDirty,
  copyDirty: false,
};

// @ts-expect-error copy-dirty absence is distinct from an explicit undefined value.
const invalidCopyDirty: ParsedForkSessionArgs = {
  ...omittedCopyDirty,
  copyDirty: undefined,
};

const succeeded: SessionCreationOutcome<SessionCreateCommandResult> = {
  status: "succeeded",
  receipt: {
    commandId: "cmd_create",
    accepted: true,
    status: "accepted",
  },
  completion: { commandId: "cmd_create" },
  result: {
    type: "session.create",
    projectId: "web",
    worktreeId: "wt_created",
    sessionId: "ses_created",
    requestedPlacement: "detached",
    resolvedPlacement: {
      provider: "tmux",
      targetId: "tmux:created",
      generation: "generation",
      presentation: "detached",
    },
  },
};

const invalidCompletionTrace: SessionCreationOutcome<SessionCreateCommandResult> = {
  status: "succeeded",
  receipt: succeeded.receipt,
  // @ts-expect-error absent completion trace is not represented as undefined.
  completion: {
    commandId: "cmd_create",
    traceId: undefined,
  },
  result: succeeded.result,
};

// @ts-expect-error resolved Group absence is distinct from an explicit undefined value.
const invalidResolvedGroup: SessionCreateCommandResult = {
  ...succeeded.result,
  resolvedGroupId: undefined,
};

const absentConvergence: SessionCommandResult = {
  action: "create",
  outcome: succeeded,
};

// @ts-expect-error absent convergence is not represented as undefined.
const invalidConvergence: SessionCommandResult = {
  action: "create",
  outcome: succeeded,
  convergence: undefined,
};

void omittedCopyDirty;
void explicitCopyDirty;
void invalidCopyDirty;
void invalidCompletionTrace;
void invalidResolvedGroup;
void absentConvergence;
void invalidConvergence;

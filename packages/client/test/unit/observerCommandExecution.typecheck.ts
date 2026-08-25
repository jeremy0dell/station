import type { StationCommand } from "@station/contracts";
import type { ObserverService } from "../../src/index.js";
import { executeObserverCommand, type ObserverCommandExecutionResult } from "../../src/index.js";

declare const service: ObserverService;

const createWorktree = {
  type: "worktree.create",
  payload: { projectId: "web", branch: "feature/client-type-safety" },
} as const satisfies StationCommand;

const focusTerminal = {
  type: "terminal.focus",
  payload: { sessionId: "ses_web" },
} as const satisfies StationCommand;

async function resultFollowsTheDispatchedCommand(): Promise<void> {
  const outcome = await executeObserverCommand(service, createWorktree);
  if (outcome.status !== "succeeded" || outcome.result === undefined) return;

  const resultType: "worktree.create" = outcome.result.type;
  // @ts-expect-error A worktree creation result cannot expose a session identity.
  outcome.result.sessionId;
  void resultType;
}

const impossibleFocusResult: ObserverCommandExecutionResult<typeof focusTerminal> = {
  status: "succeeded",
  receipt: { accepted: true, status: "accepted", commandId: "cmd_focus" },
  // @ts-expect-error terminal.focus cannot produce a command result.
  result: {
    type: "worktree.create",
    projectId: "web",
    worktreeId: "wt_unrelated",
  },
};

void resultFollowsTheDispatchedCommand;
void impossibleFocusResult;

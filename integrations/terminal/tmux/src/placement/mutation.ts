import { buildGuardedTmuxCommandArgs } from "../commandGuard.js";
import {
  defaultTmuxWorkbenchSessionOptions,
  tmuxNewWindowTarget,
  tmuxSessionOptionArgs,
  tmuxWindowTarget,
} from "../topology.js";

type BuildPlacedWorkspaceMutationInput = {
  sessionTarget: string;
  windowName: string;
  cwd: string;
  bindingToken: string;
  stationSessionId: string;
  projectId: string;
  worktreeId: string;
  worktreePath: string;
  harness: string;
  proofFormat: string;
  configureWorkbench: boolean;
  guard?: {
    serverPid: number;
    sessionId: string;
    windowId: string;
    paneId: string;
    panePid: number;
    rejectionMarker: string;
  };
} & ({ create: "session"; sessionName: string } | { create: "window"; sessionName?: never });

export function buildPlacedWorkspaceMutationArgs(
  input: BuildPlacedWorkspaceMutationInput,
): string[] {
  const provisionalWindowTarget = tmuxWindowTarget({
    sessionId: input.sessionTarget,
    windowNameOrId: input.bindingToken,
  });
  const create =
    input.create === "session"
      ? ["new-session", "-d", "-s", input.sessionName]
      : ["new-window", "-d", "-t", tmuxNewWindowTarget(input.sessionTarget)];
  const commands = [
    [...create, "-n", input.bindingToken, "-c", input.cwd],
    ...stationIdentityCommands(input, provisionalWindowTarget),
    ...(input.configureWorkbench
      ? defaultTmuxWorkbenchSessionOptions.map((option) =>
          tmuxSessionOptionArgs(input.sessionTarget, option),
        )
      : []),
    ["display-message", "-p", "-t", provisionalWindowTarget, input.proofFormat],
    ["rename-window", "-t", provisionalWindowTarget, input.windowName],
  ];
  const [first, ...rest] = commands;
  if (first === undefined) throw new Error("A placed workspace mutation requires a command.");
  const mutation = [...first, ...rest.flatMap((command) => [";", ...command])];
  if (input.guard === undefined) return mutation;

  // The proof, creation, stamping, and final rename must stay in one tmux invocation.
  return buildGuardedTmuxCommandArgs({
    target: input.guard.paneId,
    serverPid: input.guard.serverPid,
    sessionId: input.guard.sessionId,
    windowId: input.guard.windowId,
    paneId: input.guard.paneId,
    panePid: input.guard.panePid,
    commands: mutation,
    rawFormatArgs: [input.proofFormat],
    rejectionMarker: input.guard.rejectionMarker,
  });
}

function stationIdentityCommands(
  input: BuildPlacedWorkspaceMutationInput,
  target: string,
): string[][] {
  return [
    ["set-option", "-w", "-t", target, "@station.open_token", input.bindingToken],
    ["set-option", "-w", "-t", target, "@station.session_id", input.stationSessionId],
    ["set-option", "-w", "-t", target, "@station.project_id", input.projectId],
    ["set-option", "-w", "-t", target, "@station.worktree_id", input.worktreeId],
    ["set-option", "-w", "-t", target, "@station.worktree_path", input.worktreePath],
    ["set-option", "-p", "-t", target, "@station.role", "main-agent"],
    ["set-option", "-p", "-t", target, "@station.harness", input.harness],
  ];
}

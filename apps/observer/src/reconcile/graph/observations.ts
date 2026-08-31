import type {
  HarnessRunObservation,
  TerminalTargetObservation,
  WorktreeObservation,
} from "@station/contracts";
import { AGENT_STATUS } from "@station/contracts";
import { pathIsSameOrInside } from "@station/runtime";

const confidenceRank = {
  high: 3,
  medium: 2,
  low: 1,
};

export function chooseTerminal(
  worktree: WorktreeObservation,
  terminals: TerminalTargetObservation[],
): TerminalTargetObservation | undefined {
  return terminals
    .filter(
      (terminal) =>
        terminal.worktreeId === worktree.id && terminalTargetMatchesWorktree(terminal, worktree),
    )
    .sort(compareObservations)[0];
}

export function terminalTargetMatchesWorktree(
  terminal: TerminalTargetObservation,
  worktree: WorktreeObservation,
): boolean {
  if (terminal.cwd === undefined || terminal.cwd.length === 0) {
    return true;
  }
  return pathIsSameOrInside(terminal.cwd, worktree.path);
}

export function chooseHarnessRun(
  worktree: WorktreeObservation,
  terminal: TerminalTargetObservation | undefined,
  runs: HarnessRunObservation[],
): HarnessRunObservation | undefined {
  // Prefer an explicit terminal-to-run binding, then fall back to the best run for the worktree.
  if (terminal?.harnessRunId !== undefined) {
    const boundRun = runs.find((run) => run.id === terminal.harnessRunId);
    if (boundRun !== undefined) {
      return boundRun;
    }
  }

  return runs.filter((run) => run.worktreeId === worktree.id).sort(compareHarnessRuns)[0];
}

function compareObservations(
  left: TerminalTargetObservation,
  right: TerminalTargetObservation,
): number {
  return (
    confidenceRank[right.confidence] - confidenceRank[left.confidence] ||
    Date.parse(right.observedAt) - Date.parse(left.observedAt) ||
    left.id.localeCompare(right.id)
  );
}

function compareHarnessRuns(left: HarnessRunObservation, right: HarnessRunObservation): number {
  return (
    AGENT_STATUS[left.status.value].priority - AGENT_STATUS[right.status.value].priority ||
    confidenceRank[right.status.confidence] - confidenceRank[left.status.confidence] ||
    Date.parse(right.status.updatedAt) - Date.parse(left.status.updatedAt) ||
    left.id.localeCompare(right.id)
  );
}

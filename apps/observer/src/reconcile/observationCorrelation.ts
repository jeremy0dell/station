import type {
  HarnessRunObservation,
  TerminalTargetObservation,
  WorktreeObservation,
} from "@station/contracts";
import { pathIsSameOrInside } from "@station/runtime";
import type { PersistedSession } from "../persistence/index.js";
import type { ObserverHarnessRun } from "./harnessEventStatus.js";

/**
 * Reattaches terminal targets to the current worktree identity, preferring an unambiguous cwd match.
 */
export function normalizeTerminalTargetsForCurrentWorktrees(input: {
  terminalTargets: TerminalTargetObservation[];
  worktrees: WorktreeObservation[];
}): TerminalTargetObservation[] {
  return input.terminalTargets.map((target) => {
    const worktree = resolveTerminalTargetWorktree(target, input.worktrees);
    if (worktree === undefined || target.worktreeId === worktree.id) {
      return target;
    }
    return {
      ...target,
      worktreeId: worktree.id,
    };
  });
}

/**
 * Reattaches discovered harness runs to current worktree identities after terminal correlation.
 */
export function normalizeHarnessRunsForCurrentWorktrees(input: {
  harnessRuns: ObserverHarnessRun[];
  worktrees: WorktreeObservation[];
  terminalTargets: TerminalTargetObservation[];
}): ObserverHarnessRun[] {
  return input.harnessRuns.map((harnessRun) => {
    const worktree = resolveHarnessRunWorktree({
      run: harnessRun.run,
      worktrees: input.worktrees,
      terminalTargets: input.terminalTargets,
    });
    if (worktree === undefined || harnessRun.run.worktreeId === worktree.id) {
      return harnessRun;
    }
    return {
      ...harnessRun,
      run: {
        ...harnessRun.run,
        worktreeId: worktree.id,
      },
    };
  });
}

/**
 * Reattaches persisted session title evidence only when current observations agree on one worktree.
 */
export function reattachSessionTitleEvidence(input: {
  sessions: PersistedSession[];
  harnessRuns: readonly ObserverHarnessRun[];
  terminalTargets: readonly TerminalTargetObservation[];
}): PersistedSession[] {
  return input.sessions.map((session) => {
    const currentWorktreeIds = new Set<string>();
    for (const harnessRun of input.harnessRuns) {
      if (
        harnessRun.run.sessionId === session.id &&
        harnessRun.run.projectId === session.projectId &&
        harnessRun.run.worktreeId !== undefined
      ) {
        currentWorktreeIds.add(harnessRun.run.worktreeId);
      }
    }
    for (const terminal of input.terminalTargets) {
      if (
        terminal.sessionId === session.id &&
        terminal.projectId === session.projectId &&
        terminal.worktreeId !== undefined
      ) {
        currentWorktreeIds.add(terminal.worktreeId);
      }
    }
    if (currentWorktreeIds.size !== 1) return session;
    const [worktreeId] = currentWorktreeIds;
    return worktreeId === undefined ? session : { ...session, worktreeId };
  });
}

/**
 * Resolves a worktree by project and cwd, rejecting equal-length matches as ambiguous.
 */
export function resolveWorktreeByProjectPath(input: {
  projectId: string;
  cwd: string;
  worktrees: readonly WorktreeObservation[];
}): WorktreeObservation | undefined {
  const matches = input.worktrees
    .filter(
      (worktree) =>
        worktree.projectId === input.projectId && pathIsSameOrInside(input.cwd, worktree.path),
    )
    .sort(
      (left, right) =>
        right.path.length - left.path.length ||
        left.id.localeCompare(right.id) ||
        left.path.localeCompare(right.path),
    );
  const match = matches[0];
  if (match === undefined) {
    return undefined;
  }
  const next = matches[1];
  if (next !== undefined && next.path.length === match.path.length) {
    return undefined;
  }
  return match;
}

function resolveTerminalTargetWorktree(
  target: TerminalTargetObservation,
  worktrees: readonly WorktreeObservation[],
): WorktreeObservation | undefined {
  if (target.projectId !== undefined && target.cwd !== undefined) {
    const cwdWorktree = resolveWorktreeByProjectPath({
      projectId: target.projectId,
      cwd: target.cwd,
      worktrees,
    });
    if (cwdWorktree !== undefined) {
      return cwdWorktree;
    }
  }
  if (target.worktreeId !== undefined) {
    const claimed = worktrees.find((worktree) => worktree.id === target.worktreeId);
    if (claimed !== undefined) {
      return claimed;
    }
  }
  return undefined;
}

function resolveHarnessRunWorktree(input: {
  run: HarnessRunObservation;
  worktrees: readonly WorktreeObservation[];
  terminalTargets: readonly TerminalTargetObservation[];
}): WorktreeObservation | undefined {
  if (input.run.projectId !== undefined && input.run.cwd !== undefined) {
    const cwdWorktree = resolveWorktreeByProjectPath({
      projectId: input.run.projectId,
      cwd: input.run.cwd,
      worktrees: input.worktrees,
    });
    if (cwdWorktree !== undefined) {
      return cwdWorktree;
    }
  }
  if (input.run.sessionId !== undefined) {
    const terminal = input.terminalTargets.find(
      (target) => target.sessionId === input.run.sessionId && target.worktreeId !== undefined,
    );
    if (terminal?.worktreeId !== undefined) {
      const terminalWorktree = input.worktrees.find(
        (worktree) => worktree.id === terminal.worktreeId,
      );
      if (terminalWorktree !== undefined) {
        return terminalWorktree;
      }
    }
  }
  if (input.run.worktreeId !== undefined) {
    const claimed = input.worktrees.find((worktree) => worktree.id === input.run.worktreeId);
    if (claimed !== undefined) {
      return claimed;
    }
  }
  return undefined;
}

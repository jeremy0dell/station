import type {
  HarnessRunObservation,
  OrphanedRuntimeState,
  ProviderProjectConfig,
  WorktreeObservation,
} from "@station/contracts";
import type { ObserverGraphInput } from "./evidence.js";
import { terminalTargetMatchesWorktree } from "./observations.js";

export function projectOrphanedRuntimeState(
  input: ObserverGraphInput,
  harnessRuns: HarnessRunObservation[],
  worktreesById: Map<string, WorktreeObservation>,
  projectsById: Map<string, ProviderProjectConfig>,
  harnessRunsById: Map<string, HarnessRunObservation>,
): { orphans?: OrphanedRuntimeState[] } {
  // Runtime state without a configured worktree remains visible as an orphan instead of disappearing.
  const orphans: OrphanedRuntimeState[] = [];

  for (const terminal of input.terminalTargets) {
    const hasProject = terminal.projectId === undefined || projectsById.has(terminal.projectId);
    const worktree =
      terminal.worktreeId === undefined ? undefined : worktreesById.get(terminal.worktreeId);
    const hasWorktree = worktree !== undefined;
    const hasHarness =
      terminal.harnessRunId === undefined || harnessRunsById.has(terminal.harnessRunId);
    const pathMismatch =
      worktree !== undefined && !terminalTargetMatchesWorktree(terminal, worktree);

    if (!hasProject || !hasWorktree || !hasHarness || pathMismatch) {
      const orphan: OrphanedRuntimeState = {
        id: `orphan_${terminal.id}`,
        kind: "terminal_target",
        provider: terminal.provider,
        terminalTargetId: terminal.id,
        reason: pathMismatch
          ? "Terminal target path does not match the configured worktree."
          : "Terminal target has no matching configured project or worktree.",
        observedAt: terminal.observedAt,
      };
      if (terminal.projectId !== undefined) orphan.projectId = terminal.projectId;
      if (terminal.worktreeId !== undefined) orphan.worktreeId = terminal.worktreeId;
      if (terminal.sessionId !== undefined) orphan.sessionId = terminal.sessionId;
      orphans.push(orphan);
    }
  }

  for (const harnessRun of harnessRuns) {
    const run = harnessRun;
    const hasProject = run.projectId === undefined || projectsById.has(run.projectId);
    const hasWorktree = run.worktreeId !== undefined && worktreesById.has(run.worktreeId);

    if (!hasProject || !hasWorktree) {
      const orphan: OrphanedRuntimeState = {
        id: `orphan_${run.id}`,
        kind: "harness_run",
        provider: run.provider,
        harnessRunId: run.id,
        reason: "Harness run has no matching configured project or worktree.",
        observedAt: run.observedAt,
      };
      if (run.projectId !== undefined) orphan.projectId = run.projectId;
      if (run.worktreeId !== undefined) orphan.worktreeId = run.worktreeId;
      if (run.sessionId !== undefined) orphan.sessionId = run.sessionId;
      orphans.push(orphan);
    }
  }

  if (orphans.length === 0) {
    return {};
  }
  return { orphans };
}

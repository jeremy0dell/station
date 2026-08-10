import type {
  ProviderProjectConfig,
  SessionRecoveryHandle,
  TerminalTargetObservation,
  WorktreeObservation,
} from "@station/contracts";
import type {
  PersistedSession,
  PersistedSessionTurnReadiness,
  PersistedWorktreeDisplayTitle,
  SessionStore,
} from "../../persistence/index.js";
import { resolveWorktreeDisplayTitle } from "../../worktreeDisplayTitle.js";
import type { ObserverHarnessRun } from "../harnessEventStatus.js";
import { reattachSessionTitleEvidence } from "../observationCorrelation.js";

export type ReconcileSnapshotInputs = {
  sessionMetadata: PersistedSession[];
  worktreeDisplayTitles: PersistedWorktreeDisplayTitle[];
  recoveryHandles: SessionRecoveryHandle[];
  turnReadiness: PersistedSessionTurnReadiness[];
};

/**
 * Loads durable snapshot records and resolves missing worktree titles after current identities are correlated.
 */
export async function readReconcileSnapshotInputs(input: {
  persistence?: SessionStore;
  projects: ProviderProjectConfig[];
  worktrees: WorktreeObservation[];
  harnessRuns: readonly ObserverHarnessRun[];
  terminalTargets: readonly TerminalTargetObservation[];
  now: string;
}): Promise<ReconcileSnapshotInputs> {
  const [sessionMetadata, persistedWorktreeDisplayTitles, recoveryHandles, turnReadiness] =
    input.persistence === undefined
      ? [[], [], [], []]
      : await Promise.all([
          input.persistence.listSessions(),
          input.persistence.listWorktreeDisplayTitles(),
          input.persistence.listSessionRecoveryHandles(),
          input.persistence.listSessionTurnReadiness(),
        ]);
  const configuredProjectIds = new Set(input.projects.map((project) => project.id));
  const titleSessionEvidence = reattachSessionTitleEvidence({
    sessions: sessionMetadata,
    harnessRuns: input.harnessRuns,
    terminalTargets: input.terminalTargets,
  });
  const worktreeDisplayTitles: PersistedWorktreeDisplayTitle[] = input.worktrees
    .filter(
      (worktree) => worktree.state === "exists" && configuredProjectIds.has(worktree.projectId),
    )
    .map((worktree) => {
      const existing = persistedWorktreeDisplayTitles.find(
        (title) => title.projectId === worktree.projectId && title.worktreeId === worktree.id,
      );
      if (existing !== undefined) return existing;
      return {
        projectId: worktree.projectId,
        worktreeId: worktree.id,
        title: resolveWorktreeDisplayTitle({
          projectId: worktree.projectId,
          worktreeId: worktree.id,
          branch: worktree.branch,
          canonicalTitles: persistedWorktreeDisplayTitles,
          sessions: titleSessionEvidence,
        }),
        createdAt: input.now,
        updatedAt: input.now,
      };
    });

  return {
    sessionMetadata,
    worktreeDisplayTitles,
    recoveryHandles,
    turnReadiness,
  };
}

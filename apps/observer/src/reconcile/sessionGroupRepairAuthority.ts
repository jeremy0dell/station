import type {
  ProjectId,
  SessionGroupRepairBlocker,
  SessionGroupRepairSummary,
} from "@station/contracts";
import type { ProviderReadOutcome } from "./providerObservations.js";

/**
 * POLICY
 *
 * Decides which configured projects have enough provider evidence to prune absent Group members.
 * Terminal or harness uncertainty blocks absence pruning globally because assignments retain no
 * provider provenance; positive identity corruption remains repairable by persistence.
 */
export function decideSessionGroupRepairAuthority(input: {
  projectIds: readonly ProjectId[];
  providerReadOutcomes: readonly ProviderReadOutcome[];
}): SessionGroupRepairSummary {
  const configuredProjectIds = new Set(input.projectIds);
  const completeWorktreeProjectIds = new Set<ProjectId>();
  const indeterminateWorktreeProjectIds = new Set<ProjectId>();
  const blockers: SessionGroupRepairBlocker[] = [];
  let globallyBlocked = false;

  for (const outcome of input.providerReadOutcomes) {
    if (outcome.providerType === "worktree") {
      if (!configuredProjectIds.has(outcome.projectId)) continue;
      if (outcome.status === "complete") {
        completeWorktreeProjectIds.add(outcome.projectId);
        continue;
      }
      indeterminateWorktreeProjectIds.add(outcome.projectId);
      blockers.push({
        scope: "project",
        providerType: "worktree",
        providerId: outcome.providerId,
        projectId: outcome.projectId,
        code: outcome.failureCode,
      });
      continue;
    }

    if (outcome.status === "complete") continue;
    globallyBlocked = true;
    blockers.push({
      scope: "global",
      providerType: outcome.providerType,
      providerId: outcome.providerId,
      code: outcome.failureCode,
    });
  }

  const absenceAuthorityProjectIds = globallyBlocked
    ? []
    : input.projectIds.filter(
        (projectId) =>
          completeWorktreeProjectIds.has(projectId) &&
          !indeterminateWorktreeProjectIds.has(projectId),
      );
  const authorityProjectIds = new Set(absenceAuthorityProjectIds);
  const preservedProjectIds = input.projectIds.filter(
    (projectId) => !authorityProjectIds.has(projectId),
  );
  const status =
    absenceAuthorityProjectIds.length === 0
      ? "skipped"
      : preservedProjectIds.length === 0
        ? "applied"
        : "partially_scoped";

  return {
    status,
    absenceAuthorityProjectIds,
    preservedProjectIds,
    blockers,
  };
}

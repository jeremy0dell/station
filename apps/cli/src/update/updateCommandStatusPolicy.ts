import type { UpdateCommandReport, UpdateConvergencePlan } from "@station/contracts";

/**
 * POLICY
 *
 * Maps a strict update disposition to the process exit contract shared by parent and successor.
 */
export function updateCommandExitCode(report: Pick<UpdateCommandReport, "status">): 0 | 1 {
  switch (report.status) {
    case "current":
    case "updated":
    case "planned":
    case "deferred":
      return 0;
    case "failed":
    case "blocked":
    case "reap-required":
    case "intentionally-incomplete":
      return 1;
  }
}

export function nonExecutedPhases(plan: UpdateConvergencePlan) {
  return plan.phases.map((phase) => ({ id: phase.id, status: "not-executed" as const }));
}

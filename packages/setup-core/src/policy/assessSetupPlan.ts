import type { SetupIssue } from "../model/issues.js";
import type { SetupPlan } from "../model/plan.js";

export type SetupPlanAssessment = {
  readonly canPrepare: boolean;
  readonly canContinueEditing: boolean;
  readonly canApply: boolean;
};

/**
 * POLICY
 *
 * Classifies whether a semantic setup plan can prepare prerequisites, continue collecting intent, or begin mutation.
 */
export function assessSetupPlan(plan: SetupPlan): SetupPlanAssessment {
  return {
    canPrepare: !plan.issues.some((issue) => blocksPreparation(issue, plan.issues)),
    canContinueEditing: !plan.issues.some((issue) => blocksApply(issue, plan, false)),
    canApply: !plan.issues.some((issue) => blocksApply(issue, plan, true)),
  };
}

function blocksPreparation(issue: SetupIssue, issues: readonly SetupIssue[]): boolean {
  if (issue.code === "state-directory-unwritable") return true;
  return (
    issue.code === "git-unavailable" &&
    !issues.some((candidate) => candidate.code === "xcode-tools-missing")
  );
}

function blocksApply(issue: SetupIssue, plan: SetupPlan, selectedOnly: boolean): boolean {
  if (issue.tier !== "required" || issue.code === "station-ui-missing") return false;
  if (issue.code === "config-unready") {
    if (issue.state === "write-blocked" && plan.evidence.config.state === "valid") return false;
    if (issue.state !== "missing") return true;
    return !plan.operations.some(
      (operation) => operation.kind === "write-config" && operation.selected,
    );
  }
  if (issue.code !== "harness-tracking-unprepared") return true;
  return !plan.operations.some((operation) => {
    if (selectedOnly && !operation.selected) return false;
    if (operation.kind === "prepare-harness-tracking") {
      return operation.harnessId === issue.harnessId;
    }
    return (
      operation.kind === "write-config" && operation.trackingHarnessIds.includes(issue.harnessId)
    );
  });
}

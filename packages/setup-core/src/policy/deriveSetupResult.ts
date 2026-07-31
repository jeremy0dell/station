import type { SetupPlanningFacts } from "../model/facts.js";
import type { SetupIssue } from "../model/issues.js";
import type { SetupOperation } from "../model/operations.js";
import type { SetupResult } from "../model/result.js";

export type DeriveSetupResultInput = {
  readonly evidence: SetupPlanningFacts;
  readonly issues: readonly SetupIssue[];
  readonly operations: readonly SetupOperation[];
};

/**
 * POLICY
 *
 * Derives readiness and compatibility counts from current semantic evidence without trusting attempted mutations.
 */
export function deriveSetupResult(input: DeriveSetupResultInput): SetupResult {
  const requiredIssues = input.issues.filter((issue) => issue.tier === "required");
  const workflowIssues = requiredIssues.filter(
    (issue) =>
      issue.code !== "station-ui-missing" &&
      !(
        issue.code === "config-unready" &&
        issue.state === "write-blocked" &&
        input.evidence.config.state === "valid"
      ),
  );
  const bunAvailable = toolAvailable(input.evidence, "bun");
  const launchReady =
    input.evidence.stateDirectoryWritable &&
    (input.evidence.compiled || (bunAvailable && input.evidence.runtimeUi !== "missing"));

  return {
    readiness: {
      launchReady,
      workflowReady: workflowIssues.length === 0,
      requiredMissing: workflowIssues.length,
    },
    requiredIssueCount: requiredIssues.length,
    warningCount: deriveWarningCount(input.evidence, input.issues),
    selectedOperationCount: input.operations.filter((operation) => operation.selected).length,
  };
}

function deriveWarningCount(evidence: SetupPlanningFacts, issues: readonly SetupIssue[]): number {
  let count = 1;
  if (issues.some((issue) => issue.code === "socket-evidence-unavailable")) count += 1;
  if (issues.some((issue) => issue.code === "config-diagnostic")) count += 1;
  if (issues.some((issue) => issue.code === "launcher-unready")) count += 1;
  if (issues.some((issue) => issue.code === "station-ui-missing")) count += 1;
  if (issues.some((issue) => issue.code === "worktrunk-shell-missing")) count += 1;

  const tmuxPopupConflict = issues.some(
    (issue) =>
      issue.code === "tmux-popup-unready" &&
      issue.scope === "persisted" &&
      issue.state === "conflict",
  );
  const tmuxPopupWarning =
    tmuxPopupConflict ||
    (toolAvailable(evidence, "tmux") &&
      (evidence.launchers.tmuxPopup === "missing" ||
        issues.some((issue) => issue.code === "tmux-popup-unready")));
  if (tmuxPopupWarning) count += 1;

  const worktrunkWarning =
    toolAvailable(evidence, "worktrunk") &&
    (evidence.worktrunkAutomation === "warning" ||
      issues.some((issue) => issue.code === "worktrunk-hooks-missing"));
  if (worktrunkWarning) count += 1;

  count += issues.filter(
    (issue) => issue.code === "harness-tracking-unprepared" && issue.tier === "recommended",
  ).length;
  return count;
}

function toolAvailable(
  evidence: SetupPlanningFacts,
  toolId: SetupPlanningFacts["tools"][number]["id"],
): boolean {
  return evidence.tools.find((tool) => tool.id === toolId)?.available === true;
}

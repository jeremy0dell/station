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
 * Derives readiness from current semantic evidence without trusting attempted mutations.
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
    selectedOperationCount: input.operations.filter((operation) => operation.selected).length,
  };
}

function toolAvailable(
  evidence: SetupPlanningFacts,
  toolId: SetupPlanningFacts["tools"][number]["id"],
): boolean {
  return evidence.tools.find((tool) => tool.id === toolId)?.available === true;
}

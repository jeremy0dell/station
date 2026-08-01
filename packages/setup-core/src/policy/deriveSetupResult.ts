import type { SetupPlanningFacts } from "../model/facts.js";
import type { SetupIssue, SetupRecommendationCategory } from "../model/issues.js";
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
 * Derives readiness and semantic recommendations from current evidence without trusting attempted mutations.
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
    recommendations: deriveRecommendations(input.issues),
    selectedOperationCount: input.operations.filter((operation) => operation.selected).length,
  };
}

function deriveRecommendations(
  issues: readonly SetupIssue[],
): readonly SetupRecommendationCategory[] {
  const categories = new Set<SetupRecommendationCategory>(["doctor"]);
  for (const issue of issues) {
    switch (issue.code) {
      case "socket-evidence-unavailable":
        categories.add("socket-evidence");
        break;
      case "config-diagnostic":
        categories.add("config-diagnostics");
        break;
      case "launcher-unready":
        categories.add("launcher-path");
        break;
      case "station-ui-missing":
        categories.add("station-ui");
        break;
      case "worktrunk-automation-unready":
        categories.add("worktrunk-automation");
        break;
      case "worktrunk-shell-missing":
        categories.add("worktrunk-shell");
        break;
      case "tmux-popup-unready":
        categories.add("tmux-popup");
        break;
      case "worktrunk-hooks-missing":
        categories.add("worktrunk-hooks");
        break;
      case "harness-tracking-unprepared":
        if (issue.tier === "recommended") categories.add("harness-tracking");
        break;
      default:
        break;
    }
  }
  return [...categories];
}

function toolAvailable(
  evidence: SetupPlanningFacts,
  toolId: SetupPlanningFacts["tools"][number]["id"],
): boolean {
  return evidence.tools.find((tool) => tool.id === toolId)?.available === true;
}

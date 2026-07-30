import type { HarnessSelectionResolution, SetupPlanningFacts } from "./facts.js";
import type { SetupPlanningIntent } from "./intent.js";
import type { SetupIssue } from "./issues.js";
import type { SetupOperation } from "./operations.js";
import type { SetupResult } from "./result.js";

export type SetupPlan = {
  readonly generatedAt: string;
  readonly mode: SetupPlanningIntent["mode"];
  readonly selection: HarnessSelectionResolution;
  readonly evidence: SetupPlanningFacts;
  readonly issues: readonly SetupIssue[];
  readonly operations: readonly SetupOperation[];
  readonly result: SetupResult;
};

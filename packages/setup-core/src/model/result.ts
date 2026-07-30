import type { SetupReadiness } from "./facts.js";

export type SetupResult = {
  readonly readiness: SetupReadiness;
  readonly requiredIssueCount: number;
  readonly warningCount: number;
  readonly selectedOperationCount: number;
};

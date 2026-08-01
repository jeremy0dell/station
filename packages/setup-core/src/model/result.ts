import type { SetupReadiness } from "./facts.js";
import type { SetupRecommendationCategory } from "./issues.js";

export type SetupResult = {
  readonly readiness: SetupReadiness;
  readonly requiredIssueCount: number;
  readonly recommendations: readonly SetupRecommendationCategory[];
  readonly selectedOperationCount: number;
};

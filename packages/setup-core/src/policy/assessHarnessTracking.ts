import type { HarnessTrackingAssessment, HarnessTrackingFacts } from "../model/facts.js";

/**
 * POLICY
 *
 * Classifies normalized tracking evidence without provider or presentation concerns.
 */
export function assessHarnessTracking(facts: HarnessTrackingFacts): HarnessTrackingAssessment {
  if (facts.capability === "unsupported") return { state: "not-applicable" };
  if (facts.evidence.availability === "unavailable") return { state: "probe-failed" };

  if (facts.evidence.probeFailed) {
    return incompleteAssessment("probe-failed", facts.evidence);
  }
  if (!facts.configRequested || facts.evidence.requested !== true) {
    return incompleteAssessment("disabled", facts.evidence);
  }
  if (facts.evidence.installed !== true) {
    return incompleteAssessment("artifact-missing-or-drifted", facts.evidence);
  }
  return { state: "prepared", requested: true, installed: true };
}

function incompleteAssessment(
  state: "probe-failed" | "disabled" | "artifact-missing-or-drifted",
  evidence: Extract<HarnessTrackingFacts["evidence"], { availability: "available" }>,
): HarnessTrackingAssessment {
  const assessment: {
    state: "probe-failed" | "disabled" | "artifact-missing-or-drifted";
    requested?: boolean;
    installed?: boolean;
  } = { state };
  if (evidence.requested !== undefined) assessment.requested = evidence.requested;
  if (evidence.installed !== undefined) assessment.installed = evidence.installed;
  return assessment;
}

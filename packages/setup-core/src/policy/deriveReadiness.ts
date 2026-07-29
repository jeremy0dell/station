import type { SetupReadiness, SetupReadinessFacts } from "../model/facts.js";

/**
 * POLICY
 *
 * Derives launch and workflow readiness from normalized runtime and requirement facts.
 */
export function deriveSetupReadiness(facts: SetupReadinessFacts): SetupReadiness {
  const runtimeReady =
    facts.runtime.kind === "compiled" ||
    (facts.runtime.bunAvailable && facts.runtime.stationUiUsable);
  const requiredMissing = facts.requirements.filter(
    (requirement) => requirement === "unsatisfied",
  ).length;
  return {
    launchReady: facts.stateDirectoryWritable && runtimeReady,
    workflowReady: requiredMissing === 0,
    requiredMissing,
  };
}

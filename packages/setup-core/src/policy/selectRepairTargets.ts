import type { HarnessTrackingRepairFact, SupportedHarnessId } from "../model/facts.js";

/**
 * POLICY
 *
 * Selects available, supported, unprepared harnesses whose selected or persisted intent requires repair.
 */
export function selectHarnessTrackingRepairTargets(input: {
  readonly requiredHarnessIds: readonly SupportedHarnessId[];
  readonly persistedTrackingHarnessIds: readonly string[];
  readonly harnesses: readonly HarnessTrackingRepairFact[];
}): readonly SupportedHarnessId[] {
  const targets: SupportedHarnessId[] = [];
  const requestedIds: readonly string[] = [
    ...input.requiredHarnessIds,
    ...input.persistedTrackingHarnessIds,
  ];
  for (const requestedId of requestedIds) {
    const harness = input.harnesses.find((candidate) => candidate.id === requestedId);
    if (
      harness === undefined ||
      !harness.available ||
      harness.capability === "unsupported" ||
      harness.prepared ||
      targets.includes(harness.id)
    ) {
      continue;
    }
    targets.push(harness.id);
  }
  return targets;
}

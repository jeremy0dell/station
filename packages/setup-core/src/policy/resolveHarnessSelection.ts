import type { CliSetupHarnessId } from "@station/contracts";
import type { HarnessSelectionFacts, HarnessSelectionResolution } from "../model/facts.js";
import type { HarnessSelectionIntent } from "../model/intent.js";

/**
 * POLICY
 *
 * Resolves configured, explicit, or discovered harness intent without choosing an ambiguous candidate.
 */
export function resolveHarnessSelection(
  facts: HarnessSelectionFacts,
  intent: HarnessSelectionIntent,
): HarnessSelectionResolution {
  if (intent.kind === "cancelled") return { outcome: "cancelled" };

  if (facts.config.status === "unsupported") {
    return { outcome: "invalid", reason: "unsupported-configured-default" };
  }
  const configuredDefault =
    facts.config.status === "valid" ? facts.config.defaultHarness : undefined;

  if (intent.kind === "explicit") {
    const explicitHarnessIds = uniqueHarnessIds(intent.harnessIds);
    const firstExplicitHarness = explicitHarnessIds[0];
    if (firstExplicitHarness === undefined) {
      return { outcome: "invalid", reason: "empty-explicit-selection" };
    }
    const requiredHarnessIds =
      configuredDefault === undefined || explicitHarnessIds.includes(configuredDefault)
        ? explicitHarnessIds
        : [...explicitHarnessIds, configuredDefault];
    return {
      outcome: "selected",
      source: "explicit",
      requiredHarnessIds,
      defaultHarness: configuredDefault ?? firstExplicitHarness,
    };
  }

  if (facts.config.status === "invalid") {
    return { outcome: "invalid", reason: "invalid-config" };
  }
  if (configuredDefault !== undefined) {
    return {
      outcome: "selected",
      source: "configured",
      requiredHarnessIds: [configuredDefault],
      defaultHarness: configuredDefault,
    };
  }

  const candidateHarnessIds = uniqueHarnessIds(
    facts.harnesses.flatMap((harness) =>
      harness.availability === "available" ? [harness.id] : [],
    ),
  );
  const inferredHarness = candidateHarnessIds[0];
  if (inferredHarness === undefined) {
    return { outcome: "invalid", reason: "no-available-harness" };
  }
  if (candidateHarnessIds.length > 1) {
    return { outcome: "ambiguous", candidateHarnessIds };
  }
  return {
    outcome: "selected",
    source: "inferred",
    requiredHarnessIds: [inferredHarness],
    defaultHarness: inferredHarness,
  };
}

function uniqueHarnessIds(ids: readonly CliSetupHarnessId[]): CliSetupHarnessId[] {
  return ids.filter((id, index) => ids.indexOf(id) === index);
}

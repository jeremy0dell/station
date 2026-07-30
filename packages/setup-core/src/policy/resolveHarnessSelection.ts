import {
  type HarnessSelectionFacts,
  type HarnessSelectionResolution,
  type SupportedHarnessId,
  supportedHarnessIds,
} from "../model/facts.js";
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

  const configuredDefault = configuredDefaultHarness(facts);
  if (facts.config.status === "valid" && configuredDefault === undefined) {
    return { outcome: "invalid", reason: "unsupported-configured-default" };
  }

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

function configuredDefaultHarness(facts: HarnessSelectionFacts): SupportedHarnessId | undefined {
  if (facts.config.status !== "valid") return undefined;
  const defaultHarness = facts.config.defaultHarness;
  return supportedHarnessIds.find((harnessId) => harnessId === defaultHarness);
}

function uniqueHarnessIds(ids: readonly SupportedHarnessId[]): SupportedHarnessId[] {
  return ids.filter((id, index) => ids.indexOf(id) === index);
}

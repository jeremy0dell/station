import type {
  ClientFeatureFlags,
  ProviderId,
  ProviderProjectConfig,
  SnapshotHarness,
  StationSnapshot,
} from "@station/contracts";
import type { ProviderRegistry } from "../providers/registry.js";
import { buildStationSnapshot } from "./graph/build.js";

/**
 * Creates the empty graph used before the first reconcile has produced provider observations.
 */
export function buildInitialSnapshot(input: {
  generatedAt: string;
  observer: {
    pid: number;
    startedAt: string;
    version: string;
  };
  projects: ProviderProjectConfig[];
  worktreeProviderId: ProviderId;
  harnesses?: SnapshotHarness[];
  featureFlags?: ClientFeatureFlags;
}): StationSnapshot {
  return buildStationSnapshot({
    generatedAt: input.generatedAt,
    observer: {
      ...input.observer,
      healthy: true,
    },
    projects: input.projects,
    worktreeProviderId: input.worktreeProviderId,
    providerHealth: {},
    ...(input.harnesses === undefined ? {} : { harnesses: input.harnesses }),
    worktrees: [],
    terminalTargets: [],
    harnessRuns: [],
    ...(input.featureFlags === undefined ? {} : { featureFlags: input.featureFlags }),
  });
}

/**
 * Projects registered harness providers into the version-aware snapshot seed without probing them.
 */
export function harnessesFromRegistry(providers: ProviderRegistry): SnapshotHarness[] {
  return Array.from(providers.harnesses.values()).map((provider) => {
    const harness: SnapshotHarness = { id: provider.id, label: provider.id };
    const version = providers.harnessVersions.get(provider.id);
    if (version?.installedVersion !== undefined) {
      harness.installedVersion = version.installedVersion;
    }
    if (version?.latestVersion !== undefined) {
      harness.latestVersion = version.latestVersion;
    }
    if (harness.installedVersion !== undefined && harness.latestVersion !== undefined) {
      harness.updateAvailable = harness.installedVersion !== harness.latestVersion;
    }
    return harness;
  });
}

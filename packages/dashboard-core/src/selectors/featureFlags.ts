import {
  type ClientFeatureFlagKey,
  type ClientFeatureFlags,
  defaultClientFeatureFlagValue,
  type StationSnapshot,
} from "@station/contracts";

export function selectTuiFeatureFlags(
  snapshot: StationSnapshot | undefined,
): ClientFeatureFlags["flags"] {
  return (
    snapshot?.featureFlags?.flags ?? {
      sessionResumeAgent: defaultClientFeatureFlagValue("sessionResumeAgent"),
    }
  );
}

export function isTuiFeatureEnabled(
  snapshot: StationSnapshot | undefined,
  key: ClientFeatureFlagKey,
): boolean {
  return selectTuiFeatureFlags(snapshot)[key] ?? defaultClientFeatureFlagValue(key);
}

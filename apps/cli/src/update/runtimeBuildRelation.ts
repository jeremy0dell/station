import type { UpdateArtifact } from "@station/contracts";

/**
 * POLICY
 *
 * Classifies immutable runtime identity against the selected artifact without treating equal
 * display versions as build equivalence.
 */
export function classifyUpdateRuntimeBuildRelation(input: {
  runningDisplayVersion: string | undefined;
  runningBuildIdentity: string | undefined;
  currentBuildIdentity: string;
  artifacts: { installed: UpdateArtifact; target: UpdateArtifact };
}): "matching-target" | "different" | "unknown" {
  if (input.runningDisplayVersion === undefined) return "unknown";
  if (input.runningDisplayVersion !== input.artifacts.target.version) return "different";
  if (input.runningBuildIdentity === undefined) return "unknown";
  if (input.runningBuildIdentity === input.currentBuildIdentity) {
    return artifactsMatch(input.artifacts.installed, input.artifacts.target)
      ? "matching-target"
      : "different";
  }
  return artifactsMatch(input.artifacts.installed, input.artifacts.target)
    ? "different"
    : "unknown";
}

function artifactsMatch(left: UpdateArtifact, right: UpdateArtifact): boolean {
  return left.version === right.version && left.revision === right.revision;
}

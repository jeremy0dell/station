import { normalizeObservedPath } from "@station/contracts";
import { stableName } from "@station/runtime";

/** Derives the stable provider worktree ID shared by native creates and Worktrunk discovery. */
export function worktreeId(projectId: string, path: string): string {
  const identityPath = normalizeObservedPath(path);
  const stableDisplayName = basename(identityPath) || "worktree";
  return stableName({
    prefix: "wt",
    profile: "id",
    display: [projectId, stableDisplayName],
    unique: ["worktree", projectId, identityPath],
    hash: "always",
  });
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? "unknown";
}

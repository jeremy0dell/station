import { basename } from "node:path";
import type { SessionRecoveryArtifactLocator, SessionRecoveryHandle } from "@station/contracts";
import { walkFiles } from "@station/runtime";

async function locateClaudeArtifacts(
  claudeProjectsRoot: string,
  handle: SessionRecoveryHandle,
): Promise<string[]> {
  if (handle.provider !== "claude" || handle.target.kind !== "native-session") return [];
  const expected = `${handle.target.id}.jsonl`;
  const matches: string[] = [];
  await walkFiles(claudeProjectsRoot, (path) => {
    if (basename(path) === expected) matches.push(path);
  });
  return matches.sort((left, right) => left.localeCompare(right));
}

/**
 * ADAPTER
 *
 * Resolves exact Claude transcript files from the configured Claude projects
 * root without leaking that layout into migration orchestration.
 */
export function createClaudeRecoveryArtifactLocator(
  claudeProjectsRoot: string,
): SessionRecoveryArtifactLocator {
  return {
    provider: "claude",
    protectedRoots: () => [claudeProjectsRoot],
    locate: async (handle) => locateClaudeArtifacts(claudeProjectsRoot, handle),
  };
}

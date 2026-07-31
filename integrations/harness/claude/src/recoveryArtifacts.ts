import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { SessionRecoveryArtifactLocator, SessionRecoveryHandle } from "@station/contracts";

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

async function walkFiles(root: string, visit: (path: string) => void): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
    throw cause;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) await walkFiles(path, visit);
    else if (entry.isFile()) visit(path);
  }
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

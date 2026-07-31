import type { Dirent } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { SessionRecoveryArtifactLocator, SessionRecoveryHandle } from "@station/contracts";

async function locateCodexArtifacts(
  codexHome: string,
  handle: SessionRecoveryHandle,
): Promise<string[]> {
  if (handle.provider !== "codex" || handle.target.kind !== "native-session") return [];
  const nativeSessionId = handle.target.id;
  const matches: string[] = [];
  await walkFiles(join(codexHome, "sessions"), (path) => {
    if (basename(path).endsWith(`-${nativeSessionId}.jsonl`)) {
      matches.push(path);
    }
  });
  await walkFiles(join(codexHome, "shell_snapshots"), (path) => {
    if (basename(path).startsWith(`${nativeSessionId}.`)) {
      matches.push(path);
    }
  });
  const stateDatabase = join(codexHome, "state_5.sqlite");
  if (matches.length > 0 && (await fileExists(stateDatabase))) matches.push(stateDatabase);
  return matches.sort((left, right) => left.localeCompare(right));
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw cause;
  }
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
 * Resolves exact Codex rollout and shell-snapshot files for one native thread
 * while keeping Codex home layout private to the integration.
 */
export function createCodexRecoveryArtifactLocator(
  codexHome: string,
): SessionRecoveryArtifactLocator {
  return {
    provider: "codex",
    protectedRoots: () => [codexHome],
    locate: async (handle) => locateCodexArtifacts(codexHome, handle),
  };
}

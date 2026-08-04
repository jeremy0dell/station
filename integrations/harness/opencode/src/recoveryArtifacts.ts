import { DatabaseSync } from "node:sqlite";
import type { SessionRecoveryArtifactLocator, SessionRecoveryHandle } from "@station/contracts";

/**
 * ADAPTER
 *
 * Resolves OpenCode recovery to its provider-owned database, whose linked
 * session rows must be transferred as one indivisible artifact.
 */
export function createOpenCodeRecoveryArtifactLocator(
  databasePath: string,
): SessionRecoveryArtifactLocator {
  return {
    provider: "opencode",
    protectedRoots: () => [databasePath],
    locate: async (handle: SessionRecoveryHandle) => {
      if (handle.provider !== "opencode" || handle.target.kind !== "native-session") {
        return [];
      }
      const database = new DatabaseSync(databasePath, { readOnly: true });
      try {
        const row = database.prepare("SELECT id FROM session WHERE id = ?").get(handle.target.id);
        return row === undefined ? [] : [databasePath];
      } finally {
        database.close();
      }
    },
  };
}

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createOpenCodeRecoveryArtifactLocator } from "../../src/recoveryArtifacts.js";

const now = "2026-07-30T12:00:00.000Z";

describe("OpenCode recovery artifacts", () => {
  it("requires the exact native session in the provider database", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-opencode-recovery-"));
    const databasePath = join(root, "opencode.db");
    const database = new DatabaseSync(databasePath);
    database.exec("CREATE TABLE session (id TEXT PRIMARY KEY)");
    database.prepare("INSERT INTO session (id) VALUES (?)").run("session-1");
    database.close();

    try {
      const locator = createOpenCodeRecoveryArtifactLocator(databasePath);
      await expect(
        locator.locate({
          id: "rec_opencode",
          provider: "opencode",
          projectId: "station",
          worktreeId: "wt_station",
          target: { kind: "native-session", id: "session-1" },
          observedAt: now,
          lastSeenAt: now,
        }),
      ).resolves.toEqual([databasePath]);
      await expect(
        locator.locate({
          id: "rec_missing",
          provider: "opencode",
          projectId: "station",
          worktreeId: "wt_station",
          target: { kind: "native-session", id: "missing" },
          observedAt: now,
          lastSeenAt: now,
        }),
      ).resolves.toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createSqliteObserverPersistence,
  openObserverSqlite,
  readSessionRecoveryHandlesFromBackup,
} from "../../src/internal.js";

const now = "2026-07-30T12:00:00.000Z";

describe("recovery archive reader", () => {
  it("translates recovery rows from an offline Observer backup", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-recovery-reader-"));
    const path = join(root, "observer.sqlite");
    const sqlite = openObserverSqlite({ path, clock: { now: () => new Date(now) } });
    const persistence = createSqliteObserverPersistence({
      sqlite,
      clock: { now: () => new Date(now) },
    });
    const expected = await persistence.upsertSessionRecoveryHandle({
      id: "source-report",
      provider: "codex",
      projectId: "station",
      worktreeId: "wt_station_recovery",
      sessionId: "ses_station_recovery",
      target: { kind: "native-session", id: "thread-recovery" },
      cwd: "/tmp/station/recovery",
      observedAt: now,
      lastSeenAt: now,
    });
    sqlite.close();

    try {
      expect(readSessionRecoveryHandlesFromBackup(path)).toEqual([expected]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

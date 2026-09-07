import { mkdir, mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFilesystemRecoveryRepairAuthorizationPort,
  createSqliteObserverPersistence,
  createSqliteRecoveryBackupPort,
} from "../../src/persistence/index.js";
import { readSessionRecoveryHandlesFromBackup } from "../../src/persistence/recoveryArchiveReader.js";
import * as driver from "../../src/sqlite/driver.js";
import { openObserverSqlite } from "../../src/sqlite.js";

const now = "2026-09-04T12:00:00.000Z";

afterEach(() => vi.restoreAllMocks());

describe("Observer recovery backup", () => {
  it("reports a missing source as a path-free creation failure without creating a backup", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "station-backup-creation-"));
    const port = createSqliteRecoveryBackupPort({
      databasePath: join(stateDir, "missing.sqlite"),
      stateDir,
    });
    const failure = await port
      .create({ expectedRecoveryInventoryDigest: "a".repeat(64) })
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ tag: "RecoveryBackupCreationError", code: "ENOENT" });
    expect(JSON.stringify(failure)).not.toContain(stateDir);
    expect(await readdir(stateDir)).toEqual([]);
  });
  it.each([
    "Preparation",
    "Verification",
  ])("removes only a new copy after %s fails and retains a path-free SQLite cause", async (phase) => {
    const stateDir = await mkdtemp(join(tmpdir(), "station-backup-phase-"));
    const databasePath = join(stateDir, "observer.sqlite");
    const sqlite = openObserverSqlite({ path: databasePath });
    try {
      const persistence = createSqliteObserverPersistence({ sqlite });
      const snapshot = await persistence.readRecoveryRepairSnapshot();
      const port = createSqliteRecoveryBackupPort({ databasePath, stateDir });
      const recorded = await port.create({
        expectedRecoveryInventoryDigest: snapshot.recoveryInventoryDigest,
      });
      const originalOpen = driver.openSqlDatabase;
      vi.spyOn(driver, "openSqlDatabase").mockImplementation((path, options) => {
        if (
          path.includes("/backups/") &&
          (phase === "Verification") === (options?.readOnly === true)
        ) {
          throw Object.assign(new Error("private-path-canary: unable to open database file"), {
            code: "ERR_SQLITE_ERROR",
            errcode: 14,
          });
        }
        return originalOpen(path, options);
      });
      const failure = await port
        .create({ expectedRecoveryInventoryDigest: snapshot.recoveryInventoryDigest })
        .catch((error: unknown) => error);
      expect(failure).toMatchObject({ tag: `RecoveryBackup${phase}Error`, code: "SQLITE_14" });
      expect(JSON.stringify(failure)).not.toContain("private-path-canary");
      expect(await readdir(join(stateDir, "repair", "backups"))).toEqual([recorded.id]);
      expect(sqlite.database.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    } finally {
      sqlite.close();
    }
  });
  it("captures committed WAL rows and verifies a private read-only recovery inventory", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "station-recovery-backup-"));
    const databasePath = join(stateDir, "observer.sqlite");
    const sqlite = openObserverSqlite({ path: databasePath });
    sqlite.database.exec("PRAGMA wal_autocheckpoint = 0");
    const persistence = createSqliteObserverPersistence({ sqlite });
    await persistence.seedSession({
      sessionId: "session-1",
      projectId: "project-1",
      worktreeId: "worktree-1",
      initialTitle: "Recovery",
      harness: "codex",
      terminalProvider: "tmux",
      createdAt: now,
      lastSeenAt: now,
    });
    const handle = await persistence.upsertSessionRecoveryHandle({
      id: "report-1",
      provider: "codex",
      projectId: "project-1",
      worktreeId: "worktree-1",
      sessionId: "session-1",
      target: { kind: "native-session", id: "provider-session-1" },
      cwd: "/tmp/project-1/worktree-1",
      observedAt: now,
      lastSeenAt: now,
    });
    const captured = await persistence.readRecoveryRepairSnapshot();
    const backupPort = createSqliteRecoveryBackupPort({
      databasePath,
      stateDir,
      backupId: () => "00000000-0000-4000-8000-000000000001",
    });
    const backup = await backupPort.create({
      expectedRecoveryInventoryDigest: captured.recoveryInventoryDigest,
    });
    const backupPath = join(stateDir, "repair", "backups", backup.id, "observer.sqlite");
    expect(backup.recoveryInventoryDigest).toBe(captured.recoveryInventoryDigest);
    expect(backup.contentDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect((await stat(backupPath)).mode & 0o777).toBe(0o600);
    expect(readSessionRecoveryHandlesFromBackup(backupPath)).toEqual([handle]);
    await expect(backupPort.verify(backup)).resolves.toBeUndefined();
    await expect(backupPort.verify(backup)).resolves.toBeUndefined();
    const copy = driver.openSqlDatabase(backupPath, { readOnly: true });
    expect(copy.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
    copy.close();
    expect(await readdir(join(stateDir, "repair", "backups", backup.id))).toEqual([
      "observer.sqlite",
    ]);
    expect(sqlite.database.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });

    const action = {
      kind: "recovery-prune" as const,
      recoveryHandleId: handle.id,
      projectId: "project-1",
      worktreeId: "worktree-1",
      sessionId: "session-1",
      provider: "codex",
    };
    const proof = {
      journalId: "00000000-0000-4000-8000-000000000002",
      auditId: "00000000-0000-4000-8000-000000000003",
      planDigest: "a".repeat(64),
      inventoryDigest: "b".repeat(64),
      expectedRecoveryInventoryDigest: backup.recoveryInventoryDigest,
      backup,
    };
    await mkdir(join(stateDir, "repair", "journals"), { recursive: true, mode: 0o700 });
    await mkdir(join(stateDir, "repair", "audit"), { recursive: true, mode: 0o700 });
    await writeFile(
      join(stateDir, "repair", "journals", `${proof.journalId}.json`),
      `${JSON.stringify({
        schemaVersion: 1,
        id: proof.journalId,
        auditId: proof.auditId,
        planDigest: proof.planDigest,
        inventoryDigest: proof.inventoryDigest,
        configuredStateScopeDigest: "c".repeat(64),
        action,
        phase: "mutation-started",
        backup,
        createdAt: now,
        updatedAt: now,
      })}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      join(stateDir, "repair", "audit", `${proof.auditId}.json`),
      `${JSON.stringify({
        schemaVersion: 1,
        id: proof.auditId,
        action,
        planDigest: proof.planDigest,
        inventoryDigest: proof.inventoryDigest,
        backup,
        status: "in-progress",
        errorCodes: [],
        recoveryCommands: [],
        createdAt: now,
        updatedAt: now,
      })}\n`,
      { mode: 0o600 },
    );
    const authorization = createFilesystemRecoveryRepairAuthorizationPort({
      stateDir,
      backup: backupPort,
    });
    await expect(authorization.authorize({ action, proof })).resolves.toBeUndefined();
    await expect(
      authorization.authorize({
        action,
        proof: { ...proof, planDigest: "d".repeat(64) },
      }),
    ).rejects.toThrow("journal authority");
    sqlite.close();
  });

  it("removes an unverified backup when the expected inventory changed", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "station-recovery-backup-refusal-"));
    const databasePath = join(stateDir, "observer.sqlite");
    const sqlite = openObserverSqlite({ path: databasePath });
    const port = createSqliteRecoveryBackupPort({
      databasePath,
      stateDir,
      backupId: () => "00000000-0000-4000-8000-000000000002",
    });
    await expect(port.create({ expectedRecoveryInventoryDigest: "f".repeat(64) })).rejects.toThrow(
      "inventory changed",
    );
    await expect(
      stat(join(stateDir, "repair", "backups", "00000000-0000-4000-8000-000000000002")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    sqlite.close();
  });
});

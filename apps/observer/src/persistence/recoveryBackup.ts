import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import {
  type RepairAction,
  type RepairAudit,
  RepairAuditSchema,
  type RepairBackup,
  RepairBackupSchema,
  type RepairJournal,
  RepairJournalSchema,
  type RepairRecoveryMutationProof,
} from "@station/contracts";
import { latestSchemaVersion } from "../migrations/index.js";
import { recoveryInventoryDigest } from "../sessionRecovery/inventoryDigest.js";
import { openSqlDatabase } from "../sqlite/driver.js";
import * as correlationStore from "./correlations.js";
import * as sessionRecoveryHandleStore from "./sessionRecoveryHandles.js";

const defaultMaximumBackupBytes = 1024 * 1024 * 1024;

/**
 * DRIVEN PORT
 *
 * Creates a verified SQLite-consistent recovery backup without exposing its local path.
 */
export interface RecoveryBackupPort {
  create(input: { expectedRecoveryInventoryDigest: string }): Promise<RepairBackup>;
  verify(backup: RepairBackup): Promise<void>;
}

/** DRIVEN PORT: admits recovery mutation only through its exact active audit, journal, and backup. */
export interface RecoveryRepairAuthorizationPort {
  authorize(input: {
    action: Extract<RepairAction, { kind: "recovery-resume" | "recovery-prune" }>;
    proof: RepairRecoveryMutationProof;
  }): Promise<void>;
}

/**
 * ADAPTER
 *
 * Uses SQLite's online backup API so committed WAL rows are included, then reopens the result
 * read-only to verify schema, integrity, size, and recovery inventory before returning an opaque ID.
 */
export function createSqliteRecoveryBackupPort(options: {
  databasePath: string;
  stateDir: string;
  maximumBytes?: number;
  backupId?: () => string;
}): RecoveryBackupPort {
  const maximumBytes = options.maximumBytes ?? defaultMaximumBackupBytes;
  const backupRoot = join(options.stateDir, "repair", "backups");
  return {
    async create(input) {
      await requireRegularFile(options.databasePath);
      const sourceSize = (await stat(options.databasePath)).size;
      if (sourceSize > maximumBytes)
        throw new Error("Observer recovery backup exceeds the size limit.");

      await mkdir(backupRoot, { recursive: true, mode: 0o700 });
      await chmod(backupRoot, 0o700);
      await requirePrivateDirectory(backupRoot);
      const id = (options.backupId ?? randomUUID)();
      const destinationDirectory = join(backupRoot, id);
      await mkdir(destinationDirectory, { mode: 0o700 });
      const destination = join(destinationDirectory, "observer.sqlite");
      try {
        const source = new DatabaseSync(options.databasePath, {
          readOnly: true,
        });
        try {
          await backup(source, destination);
        } finally {
          source.close();
        }
        await chmod(destination, 0o600);
        const verified = await inspectBackup(destination, maximumBytes);
        if (verified.recoveryInventoryDigest !== input.expectedRecoveryInventoryDigest) {
          throw new Error("Observer recovery inventory changed before backup verification.");
        }
        return RepairBackupSchema.parse({
          schemaVersion: 1,
          id,
          ...verified,
        });
      } catch (error) {
        await rm(destinationDirectory, { recursive: true, force: true });
        throw error;
      }
    },
    async verify(input) {
      const expected = RepairBackupSchema.parse(input);
      await requirePrivateDirectory(backupRoot);
      const destinationDirectory = join(backupRoot, expected.id);
      await requirePrivateDirectory(destinationDirectory);
      const verified = await inspectBackup(
        join(destinationDirectory, "observer.sqlite"),
        maximumBytes,
      );
      if (
        verified.contentDigest !== expected.contentDigest ||
        verified.recoveryInventoryDigest !== expected.recoveryInventoryDigest
      ) {
        throw new Error("Observer recovery backup proof did not match its private copy.");
      }
    },
  };
}

/** ADAPTER: verifies one active private journal, audit, and SQLite backup before recovery mutation. */
export function createFilesystemRecoveryRepairAuthorizationPort(options: {
  stateDir: string;
  backup: Pick<RecoveryBackupPort, "verify">;
}): RecoveryRepairAuthorizationPort {
  return {
    async authorize(input) {
      const proof = input.proof;
      const journal = await readPrivateJournal(
        join(options.stateDir, "repair", "journals", `${proof.journalId}.json`),
      );
      const audit = await readPrivateAudit(
        join(options.stateDir, "repair", "audit", `${proof.auditId}.json`),
      );
      if (
        journal.phase !== "mutation-started" ||
        journal.auditId !== proof.auditId ||
        journal.planDigest !== proof.planDigest ||
        journal.inventoryDigest !== proof.inventoryDigest ||
        JSON.stringify(journal.action) !== JSON.stringify(input.action) ||
        JSON.stringify(journal.backup) !== JSON.stringify(proof.backup)
      ) {
        throw new Error("Recovery repair journal authority did not match the requested mutation.");
      }
      if (
        audit.status !== "in-progress" ||
        audit.id !== proof.auditId ||
        audit.planDigest !== proof.planDigest ||
        audit.inventoryDigest !== proof.inventoryDigest ||
        JSON.stringify(audit.action) !== JSON.stringify(input.action) ||
        JSON.stringify(audit.backup) !== JSON.stringify(proof.backup) ||
        proof.expectedRecoveryInventoryDigest !== proof.backup.recoveryInventoryDigest
      ) {
        throw new Error("Recovery repair audit authority did not match the requested mutation.");
      }
      await options.backup.verify(proof.backup);
    },
  };
}

async function readPrivateJournal(path: string): Promise<RepairJournal> {
  await requirePrivateFile(path, "Repair journal");
  return RepairJournalSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

async function readPrivateAudit(path: string): Promise<RepairAudit> {
  await requirePrivateFile(path, "Repair audit");
  return RepairAuditSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

async function requirePrivateFile(path: string, label: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o600) {
    throw new Error(`${label} was not a private regular file.`);
  }
}

async function inspectBackup(
  path: string,
  maximumBytes: number,
): Promise<{ contentDigest: string; recoveryInventoryDigest: string }> {
  const metadata = await lstat(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size > maximumBytes ||
    (metadata.mode & 0o777) !== 0o600
  ) {
    throw new Error("Observer recovery backup file was not private and bounded.");
  }
  const database = openSqlDatabase(path, { readOnly: true });
  let recoveryDigest: string;
  try {
    const integrity = database.prepare("PRAGMA integrity_check").get() as
      | { integrity_check: string }
      | undefined;
    if (integrity?.integrity_check !== "ok") {
      throw new Error("Observer recovery backup failed SQLite integrity verification.");
    }
    const schema = database
      .prepare("SELECT value FROM observer_meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;
    if (Number(schema?.value) !== latestSchemaVersion) {
      throw new Error("Observer recovery backup schema did not match this Station build.");
    }
    const snapshot = {
      sessions: correlationStore.listSessions(database).sort(compareIdentity),
      recoveryHandles: sessionRecoveryHandleStore
        .listSessionRecoveryHandles(database, {})
        .sort(compareIdentity),
    };
    recoveryDigest = recoveryInventoryDigest(snapshot);
  } finally {
    database.close();
  }
  return {
    contentDigest: await sha256File(path),
    recoveryInventoryDigest: recoveryDigest,
  };
}

async function requireRegularFile(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Observer database path was not a regular file.");
  }
}

async function requirePrivateDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
    throw new Error("Observer recovery backup directory was not owner-only.");
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function compareIdentity(left: { id: string }, right: { id: string }): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

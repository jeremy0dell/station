import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { type UpdateReapJournal, UpdateReapJournalSchema } from "@station/contracts";
import { createLocalProcessEvidence, replaceTextFile } from "@station/runtime";
import { z } from "zod";

const phaseOrder: readonly UpdateReapJournal["phase"][] = [
  "authorized",
  "recovery-prepared",
  "reap-started",
  "incumbent-host-empty",
  "artifact-applied",
  "hooks-converged",
  "observer-converged",
  "host-converged",
  "persisted-reconciled",
  "sessions-resumed",
  "verified",
  "completed",
];
const lockOwnerSchema = z
  .object({
    schemaVersion: z.literal(1),
    token: z.string().uuid(),
    pid: z.number().int().positive(),
    startToken: z.string().min(1),
    transferring: z.literal(true).optional(),
  })
  .strict();
const lockClaimSchema = z
  .object({
    schemaVersion: z.literal(1),
    token: z.string().uuid(),
    pid: z.number().int().positive(),
    startToken: z.string().min(1),
  })
  .strict();

/**
 * DRIVEN PORT
 *
 * Serializes update recovery and persists its strict private restart journal.
 */
export interface UpdateReapJournalPort {
  findIncomplete(): Promise<UpdateReapJournal | undefined>;
  read(journalId: string): Promise<UpdateReapJournal>;
  write(journal: UpdateReapJournal): Promise<void>;
  withLock<T>(run: (lock: UpdateReapLock) => Promise<T>): Promise<T>;
  takeOverLock<T>(transferToken: string, run: (lock: UpdateReapLock) => Promise<T>): Promise<T>;
}

export interface UpdateReapLock {
  prepareTransfer(): Promise<string>;
  release(): Promise<void>;
}

/** Advances one journal phase without permitting a skipped or reversed transaction boundary. */
export function advanceUpdateReapJournal(
  journal: UpdateReapJournal,
  phase: UpdateReapJournal["phase"],
  now = new Date().toISOString(),
): UpdateReapJournal {
  const current = phaseOrder.indexOf(journal.phase);
  const next = phaseOrder.indexOf(phase);
  if (current < 0 || next !== current + 1) {
    throw new Error(`Update reap journal cannot advance from ${journal.phase} to ${phase}.`);
  }
  return UpdateReapJournalSchema.parse({ ...journal, phase, updatedAt: now });
}

export function updateReapJournalHasReached(
  journal: UpdateReapJournal,
  phase: UpdateReapJournal["phase"],
): boolean {
  return phaseOrder.indexOf(journal.phase) >= phaseOrder.indexOf(phase);
}

/** Rewrites target results without changing the current transaction phase. */
export function updateReapJournalTargets(
  journal: UpdateReapJournal,
  targets: UpdateReapJournal["targets"],
  now = new Date().toISOString(),
): UpdateReapJournal {
  return UpdateReapJournalSchema.parse({ ...journal, targets, updatedAt: now });
}

/**
 * ADAPTER
 *
 * Uses an owner-only state-directory lock and atomic mode-0600 journal replacement. A successor
 * replaces the live owner only with its private transfer token. An exclusive claimant file
 * serializes transfer, stale recovery, and atomic release after exact process revalidation.
 */
export function createFilesystemUpdateReapJournalPort(stateDir: string): UpdateReapJournalPort {
  const root = join(stateDir, "update-reap");
  const journals = join(root, "journals");
  const lockPath = join(root, "lock");
  const processEvidence = createLocalProcessEvidence();

  const readJournal = async (journalId: string): Promise<UpdateReapJournal> => {
    if (!z.string().uuid().safeParse(journalId).success) {
      throw new Error("Update reap journal identity was invalid.");
    }
    const path = join(journals, `${journalId}.json`);
    const metadata = await stat(path);
    if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600) {
      throw new Error("Update reap journal permissions were not private.");
    }
    return UpdateReapJournalSchema.parse(JSON.parse(await readFile(path, "utf8")));
  };

  return {
    async findIncomplete() {
      let names: string[];
      try {
        names = await readdir(journals);
      } catch (error) {
        if (nodeErrorCode(error) === "ENOENT") return undefined;
        throw error;
      }
      const loaded = await Promise.all(
        names
          .filter((name) => /^[0-9a-f-]{36}\.json$/u.test(name))
          .sort()
          .map((name) => readJournal(name.slice(0, -".json".length))),
      );
      const incomplete = loaded.filter((journal) => journal.phase !== "completed");
      if (incomplete.length > 1) {
        throw new Error("Multiple incomplete update reap journals require manual repair.");
      }
      return incomplete[0];
    },
    read: readJournal,
    async write(journal) {
      const parsed = UpdateReapJournalSchema.parse(journal);
      await replaceTextFile({
        path: join(journals, `${parsed.id}.json`),
        contents: `${JSON.stringify(parsed)}\n`,
        mode: 0o600,
        directoryMode: 0o700,
      });
    },
    async withLock(run) {
      await mkdir(root, { recursive: true, mode: 0o700 });
      const current = processEvidence.read(process.pid);
      if (current === undefined)
        throw new Error("Current update process identity was unavailable.");
      const owner = {
        schemaVersion: 1 as const,
        token: randomUUID(),
        pid: current.pid,
        startToken: current.startToken,
      };
      await acquireLock(lockPath, owner, processEvidence);
      let held = true;
      const release = async () => {
        if (!held) return;
        await releaseLock(lockPath, owner, processEvidence);
        held = false;
      };
      const prepareTransfer = async () => {
        if (!held) throw new Error("The update recovery lock is no longer held.");
        await prepareLockTransfer(lockPath, owner);
        return owner.token;
      };
      try {
        return await run({ prepareTransfer, release });
      } finally {
        await release();
      }
    },
    async takeOverLock(transferToken, run) {
      await mkdir(root, { recursive: true, mode: 0o700 });
      const current = processEvidence.read(process.pid);
      if (current === undefined)
        throw new Error("Current update process identity was unavailable.");
      const owner = {
        schemaVersion: 1 as const,
        token: randomUUID(),
        pid: current.pid,
        startToken: current.startToken,
      };
      await transferLock(lockPath, transferToken, owner, processEvidence);
      let held = true;
      const release = async () => {
        if (!held) return;
        await releaseLock(lockPath, owner, processEvidence);
        held = false;
      };
      try {
        return await run({
          prepareTransfer: async () => {
            if (!held) throw new Error("The update recovery lock is no longer held.");
            await prepareLockTransfer(lockPath, owner);
            return owner.token;
          },
          release,
        });
      } finally {
        await release();
      }
    },
  };
}

async function acquireLock(
  lockPath: string,
  owner: z.infer<typeof lockOwnerSchema>,
  evidence: ReturnType<typeof createLocalProcessEvidence>,
): Promise<void> {
  const candidatePath = `${lockPath}.candidate.${owner.token}`;
  await mkdir(candidatePath, { mode: 0o700 });
  try {
    await writeLockOwner(candidatePath, owner);
  } catch (error) {
    await rm(candidatePath, { recursive: true, force: true });
    throw error;
  }
  try {
    await rename(candidatePath, lockPath);
    return;
  } catch (error) {
    if (!new Set(["EEXIST", "ENOTEMPTY"]).has(nodeErrorCode(error) ?? "")) {
      await rm(candidatePath, { recursive: true, force: true });
      throw error;
    }
    await rm(candidatePath, { recursive: true, force: true });
    const existing = await readLockOwner(lockPath);
    const current = lockProcessStatus(evidence, existing.pid, existing.startToken);
    if (current === "exact") {
      throw new Error("Another update recovery transaction owns the update lock.");
    }
    if (current === "unavailable") {
      throw new Error("Update recovery lock owner evidence was unavailable.");
    }
    try {
      const claim = await acquireLockClaim(lockPath, owner, evidence);
      const claimedOwner = await readLockOwner(lockPath);
      const claimedCurrent = lockProcessStatus(evidence, claimedOwner.pid, claimedOwner.startToken);
      if (claimedOwner.token !== existing.token || claimedCurrent !== "stale") {
        throw new Error("The stale update recovery lock changed before it could be reclaimed.");
      }
      await writeLockOwner(lockPath, owner, false);
      await releaseLockClaim(lockPath, claim.token);
    } catch (error) {
      await releaseLockClaim(lockPath, owner.token);
      throw error;
    }
  }
}

async function writeLockOwner(
  directory: string,
  owner: z.infer<typeof lockOwnerSchema>,
  exclusive = true,
): Promise<void> {
  if (exclusive) {
    const handle = await open(join(directory, "owner.json"), "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return;
  }
  await replaceTextFile({
    path: join(directory, "owner.json"),
    contents: `${JSON.stringify(owner)}\n`,
    mode: 0o600,
    directoryMode: 0o700,
  });
}

async function readLockOwner(lockPath: string) {
  return lockOwnerSchema.parse(JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")));
}

async function prepareLockTransfer(
  lockPath: string,
  owner: z.infer<typeof lockOwnerSchema>,
): Promise<void> {
  const existing = await readLockOwner(lockPath);
  if (existing.token !== owner.token) {
    throw new Error("The update recovery lock changed before transfer preparation.");
  }
  await writeLockOwner(lockPath, { ...owner, transferring: true }, false);
  const prepared = await readLockOwner(lockPath);
  if (prepared.token !== owner.token || prepared.transferring !== true) {
    throw new Error("The update recovery lock transfer preparation did not persist.");
  }
}

async function transferLock(
  lockPath: string,
  transferToken: string,
  owner: z.infer<typeof lockOwnerSchema>,
  evidence: ReturnType<typeof createLocalProcessEvidence>,
): Promise<void> {
  const existing = await readLockOwner(lockPath);
  if (existing.token !== transferToken || existing.transferring !== true) {
    throw new Error("The update recovery lock transfer was not authorized by its owner.");
  }
  const claim = await acquireLockClaim(lockPath, owner, evidence);
  try {
    const claimedOwner = await readLockOwner(lockPath);
    if (claimedOwner.token !== transferToken || claimedOwner.transferring !== true) {
      throw new Error("The update recovery lock changed during transfer.");
    }
    await writeLockOwner(lockPath, owner, false);
  } finally {
    await releaseLockClaim(lockPath, claim.token);
  }
}

async function acquireLockClaim(
  lockPath: string,
  claimant: z.infer<typeof lockClaimSchema>,
  evidence: ReturnType<typeof createLocalProcessEvidence>,
): Promise<z.infer<typeof lockClaimSchema>> {
  const claim = lockClaimSchema.parse(claimant);
  const claimPath = join(lockPath, "claim.json");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(claimPath, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(claim)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      return claim;
    } catch (error) {
      if (nodeErrorCode(error) !== "EEXIST") throw error;
      const currentClaim = await readLockClaim(lockPath);
      const current = lockProcessStatus(evidence, currentClaim.pid, currentClaim.startToken);
      if (current === "exact") {
        throw new Error("Another update recovery transaction is changing the update lock.");
      }
      if (current === "unavailable") {
        throw new Error("Update recovery lock claim evidence was unavailable.");
      }
      const stalePath = `${claimPath}.stale.${randomUUID()}`;
      try {
        await rename(claimPath, stalePath);
      } catch (renameError) {
        if (nodeErrorCode(renameError) === "ENOENT") continue;
        throw renameError;
      }
      const movedClaim = await readLockClaimPath(stalePath);
      const moved = lockProcessStatus(evidence, movedClaim.pid, movedClaim.startToken);
      if (moved !== "stale") {
        await rename(stalePath, claimPath).catch(() => undefined);
        throw new Error("The update recovery lock claim changed while it was inspected.");
      }
      await rm(stalePath, { force: true });
    }
  }
  throw new Error("The update recovery lock claim could not be acquired.");
}

async function readLockClaim(lockPath: string) {
  return readLockClaimPath(join(lockPath, "claim.json"));
}

async function readLockClaimPath(path: string) {
  return lockClaimSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

async function releaseLockClaim(lockPath: string, token: string): Promise<void> {
  const claim = await readLockClaim(lockPath).catch(() => undefined);
  if (claim?.token === token) await unlink(join(lockPath, "claim.json")).catch(() => undefined);
}

async function releaseLock(
  lockPath: string,
  owner: z.infer<typeof lockOwnerSchema>,
  evidence: ReturnType<typeof createLocalProcessEvidence>,
): Promise<void> {
  const existing = await readLockOwner(lockPath).catch(() => undefined);
  if (existing?.token !== owner.token) return;
  const claim = await acquireLockClaim(lockPath, owner, evidence);
  let moved = false;
  const releasedPath = `${lockPath}.released.${randomUUID()}`;
  try {
    const claimedOwner = await readLockOwner(lockPath);
    if (claimedOwner.token !== owner.token) return;
    await rename(lockPath, releasedPath);
    moved = true;
  } finally {
    if (!moved) await releaseLockClaim(lockPath, claim.token);
  }
  await rm(releasedPath, { recursive: true, force: true });
}

function nodeErrorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function lockProcessStatus(
  evidence: ReturnType<typeof createLocalProcessEvidence>,
  pid: number,
  startToken: string,
): "exact" | "stale" | "unavailable" {
  const current = evidence.read(pid);
  if (current !== undefined) return current.startToken === startToken ? "exact" : "stale";
  try {
    process.kill(pid, 0);
    return "unavailable";
  } catch (error) {
    return nodeErrorCode(error) === "ESRCH" ? "stale" : "unavailable";
  }
}

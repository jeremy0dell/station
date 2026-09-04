import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { type RepairJournal, RepairJournalSchema } from "@station/contracts";
import { createLocalProcessEvidence, replaceTextFile } from "@station/runtime";
import { z } from "zod";

const phases: readonly RepairJournal["phase"][] = [
  "authorized",
  "backup-verified",
  "mutation-started",
  "mutation-completed",
  "verified",
  "completed",
];
const lockOwnerSchema = z
  .object({
    schemaVersion: z.literal(1),
    token: z.string().uuid(),
    pid: z.number().int().positive(),
    startToken: z.string().min(1),
  })
  .strict();
const lockClaimSchema = lockOwnerSchema;

/** DRIVEN PORT: serializes repair and persists its strict private restart journal. */
export interface RepairJournalPort {
  findIncomplete(): Promise<RepairJournal | undefined>;
  findByAuditId(auditId: string): Promise<RepairJournal | undefined>;
  write(journal: RepairJournal): Promise<void>;
  withLock<T>(run: () => Promise<T>): Promise<T>;
}

export function advanceRepairJournal(
  journal: RepairJournal,
  phase: RepairJournal["phase"],
  now = new Date().toISOString(),
): RepairJournal {
  if (phases.indexOf(phase) !== phases.indexOf(journal.phase) + 1) {
    throw new Error(`Repair journal cannot advance from ${journal.phase} to ${phase}.`);
  }
  return RepairJournalSchema.parse({ ...journal, phase, updatedAt: now });
}

export function repairJournalHasReached(
  journal: RepairJournal,
  phase: RepairJournal["phase"],
): boolean {
  return phases.indexOf(journal.phase) >= phases.indexOf(phase);
}

/**
 * ADAPTER
 *
 * Stores private repair progress and excludes concurrent repair processes under the configured
 * state directory while rejecting unverifiable lock ownership. An exclusive claim serializes stale
 * reclamation, exact-owner replacement, and release.
 */
export function createFilesystemRepairJournalPort(stateDir: string): RepairJournalPort {
  const root = join(stateDir, "repair");
  const journals = join(root, "journals");
  const lockPath = join(root, "lock");
  const evidence = createLocalProcessEvidence();
  const readJournals = async () => {
    let names: string[];
    try {
      names = await readdir(journals);
    } catch (error) {
      if (nodeErrorCode(error) === "ENOENT") return [];
      throw error;
    }
    return Promise.all(
      names
        .filter((name) => /^[0-9a-f-]{36}\.json$/u.test(name))
        .sort()
        .map(async (name) => {
          const path = join(journals, name);
          const metadata = await stat(path);
          if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600) {
            throw new Error("Repair journal permissions were not private.");
          }
          return RepairJournalSchema.parse(JSON.parse(await readFile(path, "utf8")));
        }),
    );
  };
  return {
    async findIncomplete() {
      const loaded = await readJournals();
      const incomplete = loaded.filter((journal) => journal.phase !== "completed");
      if (incomplete.length > 1) {
        throw new Error("Multiple incomplete repair journals require manual recovery.");
      }
      return incomplete[0];
    },
    async findByAuditId(auditId) {
      const matches = (await readJournals()).filter((journal) => journal.auditId === auditId);
      if (matches.length > 1) {
        throw new Error("Multiple repair journals reference the same audit.");
      }
      return matches[0];
    },
    async write(journal) {
      const parsed = RepairJournalSchema.parse(journal);
      await replaceTextFile({
        path: join(journals, `${parsed.id}.json`),
        contents: `${JSON.stringify(parsed)}\n`,
        mode: 0o600,
        directoryMode: 0o700,
      });
    },
    async withLock(run) {
      await mkdir(root, { recursive: true, mode: 0o700 });
      const current = evidence.read(process.pid);
      if (current === undefined)
        throw new Error("Current repair process identity was unavailable.");
      const owner = lockOwnerSchema.parse({
        schemaVersion: 1,
        token: randomUUID(),
        pid: current.pid,
        startToken: current.startToken,
      });
      await acquireRepairLock(lockPath, owner, evidence);
      try {
        return await run();
      } finally {
        await releaseRepairLock(lockPath, owner, evidence);
      }
    },
  };
}

async function acquireRepairLock(
  lockPath: string,
  owner: z.infer<typeof lockOwnerSchema>,
  evidence: ReturnType<typeof createLocalProcessEvidence>,
): Promise<void> {
  const candidatePath = `${lockPath}.candidate.${owner.token}`;
  await mkdir(candidatePath, { mode: 0o700 });
  try {
    await writeLockOwner(candidatePath, owner, true);
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
  }

  const existing = await readLockOwner(lockPath);
  const status = lockProcessStatus(evidence, existing.pid, existing.startToken);
  if (status === "unavailable") {
    throw new Error("Repair lock owner evidence was unavailable.");
  }
  if (status === "exact") {
    throw new Error("Another repair transaction owns the repair lock.");
  }
  const claim = await acquireLockClaim(lockPath, owner, evidence);
  try {
    const claimedOwner = await readLockOwner(lockPath);
    const claimedStatus = lockProcessStatus(evidence, claimedOwner.pid, claimedOwner.startToken);
    if (claimedOwner.token !== existing.token || claimedStatus !== "stale") {
      throw new Error("The stale repair lock changed before it could be reclaimed.");
    }
    await writeLockOwner(lockPath, owner, false);
  } finally {
    await releaseLockClaim(lockPath, claim.token);
  }
}

async function releaseRepairLock(
  lockPath: string,
  owner: z.infer<typeof lockOwnerSchema>,
  evidence: ReturnType<typeof createLocalProcessEvidence>,
): Promise<void> {
  const current = await readLockOwner(lockPath).catch(() => undefined);
  if (current?.token !== owner.token) return;
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

async function writeLockOwner(
  directory: string,
  owner: z.infer<typeof lockOwnerSchema>,
  exclusive: boolean,
): Promise<void> {
  const path = join(directory, "owner.json");
  if (exclusive) {
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return;
  }
  await replaceTextFile({
    path,
    contents: `${JSON.stringify(owner)}\n`,
    mode: 0o600,
    directoryMode: 0o700,
  });
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
      const currentClaim = lockClaimSchema.parse(JSON.parse(await readFile(claimPath, "utf8")));
      const status = lockProcessStatus(evidence, currentClaim.pid, currentClaim.startToken);
      if (status === "exact") {
        throw new Error("Another repair transaction is changing the repair lock.");
      }
      if (status === "unavailable") {
        throw new Error("Repair lock claim evidence was unavailable.");
      }
      const stalePath = `${claimPath}.stale.${randomUUID()}`;
      try {
        await rename(claimPath, stalePath);
      } catch (renameError) {
        if (nodeErrorCode(renameError) === "ENOENT") continue;
        throw renameError;
      }
      const movedClaim = lockClaimSchema.parse(JSON.parse(await readFile(stalePath, "utf8")));
      if (lockProcessStatus(evidence, movedClaim.pid, movedClaim.startToken) !== "stale") {
        await rename(stalePath, claimPath).catch(() => undefined);
        throw new Error("The repair lock claim changed while it was inspected.");
      }
      await rm(stalePath, { force: true });
    }
  }
  throw new Error("The repair lock claim could not be acquired.");
}

async function releaseLockClaim(lockPath: string, token: string): Promise<void> {
  const claim = await readFile(join(lockPath, "claim.json"), "utf8")
    .then((value) => lockClaimSchema.parse(JSON.parse(value)))
    .catch(() => undefined);
  if (claim?.token === token) await unlink(join(lockPath, "claim.json")).catch(() => undefined);
}

async function readLockOwner(path: string): Promise<z.infer<typeof lockOwnerSchema>> {
  const metadata = await stat(join(path, "owner.json"));
  if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600) {
    throw new Error("Repair lock owner permissions were not private.");
  }
  return lockOwnerSchema.parse(JSON.parse(await readFile(join(path, "owner.json"), "utf8")));
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

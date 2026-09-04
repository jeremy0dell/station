import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RepairJournal } from "@station/contracts";
import { describe, expect, it } from "vitest";
import {
  advanceRepairJournal,
  createFilesystemRepairJournalPort,
  repairJournalHasReached,
} from "../../src/repair/journal.js";

const journal: RepairJournal = {
  schemaVersion: 1,
  id: "00000000-0000-4000-8000-000000000001",
  auditId: "00000000-0000-4000-8000-000000000002",
  planDigest: "a".repeat(64),
  inventoryDigest: "b".repeat(64),
  configuredStateScopeDigest: "c".repeat(64),
  action: { kind: "observer-cleanup" },
  phase: "authorized",
  createdAt: "2026-09-04T12:00:00.000Z",
  updatedAt: "2026-09-04T12:00:00.000Z",
};

describe("repair journal", () => {
  it("permits only the next ordered commit boundary", () => {
    const next = advanceRepairJournal(journal, "backup-verified");
    expect(next.phase).toBe("backup-verified");
    expect(repairJournalHasReached(next, "authorized")).toBe(true);
    expect(() => advanceRepairJournal(journal, "mutation-started")).toThrow();
  });

  it("writes and reloads one private journal under its dedicated lock", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "station-repair-journal-"));
    const port = createFilesystemRepairJournalPort(stateDir);
    await port.withLock(() => port.write(journal));
    expect(await port.findIncomplete()).toEqual(journal);
    expect(await port.findByAuditId(journal.auditId)).toEqual(journal);
    const metadata = await stat(join(stateDir, "repair", "journals", `${journal.id}.json`));
    expect(metadata.mode & 0o777).toBe(0o600);
  });

  it("refuses a second live repair transaction", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "station-repair-lock-"));
    const port = createFilesystemRepairJournalPort(stateDir);
    await port.withLock(async () => {
      await expect(port.withLock(async () => undefined)).rejects.toThrow(
        "Another repair transaction owns the repair lock",
      );
    });
  });

  it("admits only one contender when both observe the same stale owner", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "station-repair-lock-race-"));
    const lockPath = join(stateDir, "repair", "lock");
    await mkdir(lockPath, { recursive: true, mode: 0o700 });
    await writeFile(
      join(lockPath, "owner.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        token: "00000000-0000-4000-8000-000000000099",
        pid: process.pid,
        startToken: "stale",
      })}\n`,
      { mode: 0o600 },
    );
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = 0;
    const contenders = [
      createFilesystemRepairJournalPort(stateDir),
      createFilesystemRepairJournalPort(stateDir),
    ].map((port) =>
      port
        .withLock(async () => {
          entered += 1;
          await hold;
        })
        .then(
          () => ({ status: "fulfilled" as const }),
          () => ({ status: "rejected" as const }),
        ),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    const settled = await Promise.all(contenders);
    expect(entered).toBe(1);
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  });
});

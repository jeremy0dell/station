import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UpdateReapJournal } from "@station/contracts";
import { describe, expect, it } from "vitest";
import {
  advanceUpdateReapJournal,
  createFilesystemUpdateReapJournalPort,
  updateReapJournalHasReached,
} from "../../src/update/reapJournal.js";

const journal = {
  schemaVersion: 1,
  id: "00000000-0000-4000-8000-000000000001",
  authorizationDigest: "a".repeat(64),
  phase: "authorized",
  channel: "installer-binary",
  selectedArtifact: { version: "1.2.3" },
  installedScopeDigest: "b".repeat(64),
  host: {
    socketPath: "/state/host.sock",
    inode: "1",
    birthtimeNs: "2",
    buildVersion: "1.2.2",
    buildIdentity: "c".repeat(64),
    process: { pid: 100, startToken: "host-start" },
  },
  targets: [
    {
      terminal: {
        kind: "aux",
        terminalTargetId: "terminal-1",
        ptyId: "pty-1",
        ptyInstanceId: "instance-1",
        projectId: "project-1",
        worktreeId: "worktree-1",
        sessionId: "session-1",
        harnessProvider: "codex",
        pid: 200,
      },
      processGroup: {
        leader: { pid: 200, parentPid: 100, pgid: 200, startToken: "terminal-start" },
        members: [{ pid: 200, parentPid: 100, pgid: 200, startToken: "terminal-start" }],
      },
      recovery: { kind: "non-resumable" },
    },
  ],
  createdAt: "2026-09-04T12:00:00.000Z",
  updatedAt: "2026-09-04T12:00:00.000Z",
} as const satisfies UpdateReapJournal;

describe("update reap journal", () => {
  it("allows only the next ordered phase", () => {
    const next = advanceUpdateReapJournal(journal, "recovery-prepared");
    expect(next.phase).toBe("recovery-prepared");
    expect(updateReapJournalHasReached(next, "authorized")).toBe(true);
    expect(() => advanceUpdateReapJournal(journal, "reap-started")).toThrow();
  });

  it("writes and reloads one private incomplete journal under the lock", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "station-update-reap-journal-"));
    const port = createFilesystemUpdateReapJournalPort(stateDir);
    await port.withLock(async () => port.write(journal));

    expect(await port.findIncomplete()).toEqual(journal);
    const metadata = await stat(join(stateDir, "update-reap", "journals", `${journal.id}.json`));
    expect(metadata.mode & 0o777).toBe(0o600);
  });

  it("refuses a second live update transaction", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "station-update-reap-lock-"));
    const port = createFilesystemUpdateReapJournalPort(stateDir);

    await port.withLock(async () => {
      await expect(port.withLock(async () => undefined)).rejects.toThrow(
        "Another update recovery transaction owns the update lock",
      );
    });
  });

  it("transfers one held lock to a successor without an unlocked interval", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "station-update-reap-transfer-"));
    const port = createFilesystemUpdateReapJournalPort(stateDir);

    await port.withLock(async (parent) => {
      const transferToken = await parent.prepareTransfer();
      await port.takeOverLock(transferToken, async () => {
        await expect(port.withLock(async () => undefined)).rejects.toThrow(
          "Another update recovery transaction owns the update lock",
        );
      });
    });
    await expect(port.withLock(async () => undefined)).resolves.toBeUndefined();
  });

  it("refuses a successor that does not hold the current transfer token", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "station-update-reap-transfer-refusal-"));
    const port = createFilesystemUpdateReapJournalPort(stateDir);

    await port.withLock(async (parent) => {
      await parent.prepareTransfer();
      await expect(
        port.takeOverLock("00000000-0000-4000-8000-000000000099", async () => undefined),
      ).rejects.toThrow("was not authorized by its owner");
    });
  });

  it("releases the owner atomically after a transfer claimant exits", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "station-update-reap-transfer-exit-"));
    const lockPath = join(stateDir, "update-reap", "lock");
    const port = createFilesystemUpdateReapJournalPort(stateDir);

    await port.withLock(async () => {
      await writeFile(
        join(lockPath, "claim.json"),
        `${JSON.stringify({
          schemaVersion: 1,
          token: "00000000-0000-4000-8000-000000000096",
          pid: process.pid,
          startToken: "exited-successor",
        })}\n`,
        { mode: 0o600 },
      );
    });

    await expect(port.withLock(async () => undefined)).resolves.toBeUndefined();
  });

  it("admits only one claimant when successor transfer races stale-owner recovery", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "station-update-reap-transfer-race-"));
    const lockPath = join(stateDir, "update-reap", "lock");
    const transferToken = "00000000-0000-4000-8000-000000000097";
    await mkdir(lockPath, { recursive: true, mode: 0o700 });
    await writeFile(
      join(lockPath, "owner.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        token: transferToken,
        pid: process.pid,
        startToken: "dead-parent",
        transferring: true,
      })}\n`,
      { mode: 0o600 },
    );
    const port = createFilesystemUpdateReapJournalPort(stateDir);
    const entered: string[] = [];
    let recordWinner = () => undefined;
    const winnerEntered = new Promise<void>((resolve) => {
      recordWinner = resolve;
    });
    let releaseWinner = () => undefined;
    const holdWinner = new Promise<void>((resolve) => {
      releaseWinner = resolve;
    });
    const enter = async (name: string) => {
      entered.push(name);
      recordWinner();
      await holdWinner;
    };

    const successor = port.takeOverLock(transferToken, async () => enter("successor"));
    const reclaimer = port.withLock(async () => enter("reclaimer"));
    const firstResult = await Promise.race([
      successor.then(
        () => "fulfilled",
        () => "rejected",
      ),
      reclaimer.then(
        () => "fulfilled",
        () => "rejected",
      ),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 2_000)),
    ]);

    expect(firstResult).toBe("rejected");
    await winnerEntered;
    expect(entered).toHaveLength(1);
    releaseWinner();
    const settled = await Promise.allSettled([successor, reclaimer]);
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((result) => result.status === "rejected")).toHaveLength(1);
  });
});

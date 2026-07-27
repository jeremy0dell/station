import {
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  truncate,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LogRecord } from "@station/contracts";
import {
  createJsonlLogger,
  DEFAULT_RETENTION_POLICY,
  mergeRetentionPolicy,
} from "@station/observability";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalDiagnosticEvidenceSource } from "../../src/diagnostics/localEvidenceSource.js";

const now = "2026-05-20T12:00:00.000Z";
const secretLogValue = "authorization=secret-value";

const statRace = vi.hoisted(() => ({ path: undefined as string | undefined }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    stat: async (...args: Parameters<typeof original.stat>) => {
      if (args[0] === statRace.path) {
        throw new Error("deleted secret spool payload");
      }
      return original.stat(...args);
    },
  };
});

afterEach(() => {
  statRace.path = undefined;
});

describe("local diagnostic evidence source", () => {
  it("translates fixed local-state entries with custom retention limits", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.stateDir, "logs", "observer.jsonl"), "12345");
    await writeFile(join(fixture.stateDir, "observer.sqlite"), "");
    await truncate(join(fixture.stateDir, "observer.sqlite"), 3 * 1024 * 1024);
    await writeFile(join(fixture.diagnosticsDir, "bundle.json"), "bundle");
    await writeFile(join(fixture.spoolDir, "pending.json"), "pending");
    const retention = mergeRetentionPolicy({
      maxTotalMb: 1,
      components: {
        observerMaxMb: 1,
        cliMaxMb: 1,
        tuiMaxMb: 1,
        hookRunnerMaxMb: 1,
        providerMaxMb: 1,
      },
    });

    const evidence = await fixture.source.scanLocalState(retention);

    expect(evidence).toMatchObject({
      diagnosticsDir: fixture.diagnosticsDir,
      socketPath: fixture.socketPath,
      usage: {
        stateDir: fixture.stateDir,
        limitBytes: 1024 * 1024,
        overLimit: true,
      },
    });
    expect(evidence.usage.entries.map((entry) => [entry.kind, entry.path])).toEqual([
      ["logs", join(fixture.stateDir, "logs")],
      ["database", join(fixture.stateDir, "observer.sqlite")],
      ["debug_bundles", fixture.diagnosticsDir],
      ["hook_spool", fixture.spoolDir],
    ]);
    expect(evidence.usage.entries[0]).toMatchObject({
      limitBytes: 5 * 1024 * 1024,
      overLimit: false,
    });
    expect(evidence.usage.entries[1]).toMatchObject({ sizeBytes: 3 * 1024 * 1024 });
  });

  it("preserves configured log order, per-file tails, and the final bound", async () => {
    const fixture = await createFixture();
    await writeLogs(fixture.observerLog, ["observer-1", "observer-2", "observer-3"]);
    await writeLogs(fixture.hookLog, ["hook-1", "hook-2", "hook-3"]);

    const evidence = await fixture.source.readRecentLogs(2);

    expect(evidence.paths).toEqual([fixture.observerLog, fixture.hookLog]);
    expect(evidence.records.map((record) => record.message)).toEqual(["hook-2", "hook-3"]);
  });

  it("treats missing and unreadable local evidence as empty", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-local-evidence-missing-"));
    const source = createLocalDiagnosticEvidenceSource({
      stateDir: join(root, "missing-state"),
      diagnosticsDir: join(root, "missing-diagnostics"),
      logPaths: [join(root, "missing-log.jsonl")],
      hookSpoolDir: join(root, "missing-spool"),
    });

    await expect(source.scanLocalState(DEFAULT_RETENTION_POLICY)).resolves.toMatchObject({
      usage: { totalBytes: 0 },
    });
    await expect(source.readRecentLogs(10)).resolves.toEqual({
      paths: [join(root, "missing-log.jsonl")],
      records: [],
    });
    await expect(source.summarizeHookSpool()).resolves.toEqual({
      path: join(root, "missing-spool"),
      pending: 0,
    });
  });

  it.each([
    ["malformed JSON", `{not-json:${secretLogValue}}`],
    [
      "invalid LogRecord",
      JSON.stringify({
        timestamp: now,
        level: "info",
        component: "observer",
        message: "",
        attributes: { authorization: secretLogValue },
      }),
    ],
  ])("rejects %s without exposing its contents", async (_label, source) => {
    const fixture = await createFixture();
    await writeFile(fixture.observerLog, `${source}\n`);

    const failure = await fixture.source.readRecentLogs(10).catch((error: unknown) => error);

    expect(failure).toEqual({
      tag: "DiagnosticEvidenceError",
      code: "LOCAL_DIAGNOSTIC_EVIDENCE_FAILED",
      message: "Local diagnostic evidence collection failed.",
    });
    expect(JSON.stringify(failure)).not.toContain(secretLogValue);
  });

  it("follows state and configured-log symlinks but ignores spool symlink entries", async () => {
    const fixture = await createFixture();
    const target = join(fixture.stateDir, "target.log");
    await writeLogs(target, ["through-symlink"]);
    await unlink(fixture.observerLog).catch(() => undefined);
    await symlink(target, fixture.observerLog);
    await symlink(target, join(fixture.spoolDir, "linked.json"));
    await writeFile(join(fixture.spoolDir, "regular.json"), "metadata only");

    const state = await fixture.source.scanLocalState(DEFAULT_RETENTION_POLICY);
    const logs = await fixture.source.readRecentLogs(10);
    const spool = await fixture.source.summarizeHookSpool();

    expect(state.usage.entries.find((entry) => entry.kind === "logs")?.fileCount).toBeGreaterThan(
      0,
    );
    expect(logs.records.map((record) => record.message)).toContain("through-symlink");
    expect(spool).toMatchObject({ pending: 1 });
  });

  it("uses only file metadata for sparse and secret-bearing spool records", async () => {
    const fixture = await createFixture();
    const sparseDatabase = join(fixture.stateDir, "observer.sqlite");
    const oldSpool = join(fixture.spoolDir, "old-secret.json");
    const newSpool = join(fixture.spoolDir, "new-secret.json");
    await writeFile(sparseDatabase, "");
    await truncate(sparseDatabase, 64 * 1024 * 1024);
    await writeFile(oldSpool, '{"token":"old-secret"}');
    await writeFile(newSpool, '{"token":"new-secret"}');
    await truncate(newSpool, 32 * 1024 * 1024);
    await utimes(
      oldSpool,
      new Date("2026-05-20T10:00:00.000Z"),
      new Date("2026-05-20T10:00:00.000Z"),
    );
    await utimes(
      newSpool,
      new Date("2026-05-20T11:00:00.000Z"),
      new Date("2026-05-20T11:00:00.000Z"),
    );

    const state = await fixture.source.scanLocalState(DEFAULT_RETENTION_POLICY);
    const spool = await fixture.source.summarizeHookSpool();

    expect(state.usage.entries.find((entry) => entry.kind === "database")).toMatchObject({
      sizeBytes: 64 * 1024 * 1024,
      fileCount: 1,
    });
    expect(spool).toEqual({
      path: fixture.spoolDir,
      pending: 2,
      oldestCreatedAt: "2026-05-20T10:00:00.000Z",
      newestCreatedAt: "2026-05-20T11:00:00.000Z",
    });
    expect(JSON.stringify(spool)).not.toContain("secret");
  });

  it("preserves best-effort semantics when a spool file disappears after readdir", async () => {
    const fixture = await createFixture();
    const racedPath = join(fixture.spoolDir, "raced-secret.json");
    await writeFile(racedPath, '{"token":"must-not-leak"}');
    statRace.path = racedPath;

    const spool = await fixture.source.summarizeHookSpool();

    expect(spool).toEqual({ path: fixture.spoolDir, pending: 0 });
    expect(JSON.stringify(spool)).not.toContain("must-not-leak");
  });

  it("retains logger redaction in collected log records", async () => {
    const fixture = await createFixture();
    const logger = createJsonlLogger({ path: fixture.observerLog, component: "observer" });
    await logger.info("Redacted record.", {
      authorization: "Bearer top-secret-token",
      safe: "visible",
    });

    const evidence = await fixture.source.readRecentLogs(10);

    expect(evidence.records[0]?.attributes).toMatchObject({
      authorization: "[REDACTED]",
      safe: "visible",
    });
    expect(await readFile(fixture.observerLog, "utf8")).not.toContain("top-secret-token");
  });
});

async function createFixture() {
  const stateDir = await mkdtemp(join(tmpdir(), "station-local-evidence-"));
  const diagnosticsDir = join(stateDir, "diagnostics");
  const spoolDir = join(stateDir, "spool", "hooks");
  const logsDir = join(stateDir, "logs");
  const observerLog = join(logsDir, "observer.jsonl");
  const hookLog = join(logsDir, "hooks.jsonl");
  const socketPath = join(stateDir, "run", "observer.sock");
  await Promise.all([
    mkdir(diagnosticsDir, { recursive: true }),
    mkdir(spoolDir, { recursive: true }),
    mkdir(logsDir, { recursive: true }),
  ]);
  return {
    stateDir,
    diagnosticsDir,
    spoolDir,
    observerLog,
    hookLog,
    socketPath,
    source: createLocalDiagnosticEvidenceSource({
      stateDir,
      socketPath,
      diagnosticsDir,
      logPaths: [observerLog, hookLog],
      hookSpoolDir: spoolDir,
    }),
  };
}

async function writeLogs(path: string, messages: readonly string[]): Promise<void> {
  const records: LogRecord[] = messages.map((message) => ({
    timestamp: now,
    level: "info",
    component: "observer",
    message,
  }));
  await writeFile(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

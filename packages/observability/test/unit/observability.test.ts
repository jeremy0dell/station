import { appendFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiagnosticEvidenceIndex, DiagnosticSnapshot } from "@station/contracts";
import { LogRecordSchema } from "@station/contracts";
import {
  createErrorEnvelope,
  createJsonlLogger,
  DEFAULT_RETENTION_POLICY,
  mergeRetentionPolicy,
  readJsonlLog,
  readJsonlReverse,
  redact,
  scanLocalStateUsage,
  toSafeError,
  writeDebugBundle,
} from "@station/observability";
import { describe, expect, it } from "vitest";

const now = "2026-05-20T12:00:00.000Z";

describe("observability helpers", () => {
  it("recursively redacts secret-looking keys and values", () => {
    const result = redact(
      {
        headers: { authorization: "Bearer abcdefghijklmnop" },
        env: { OPENAI_API_KEY: "sk-secret000000000000" },
        output: "TOKEN=super-secret-value",
      },
      new Date(now),
    );

    expect(JSON.stringify(result.value)).not.toContain("sk-secret");
    expect(JSON.stringify(result.value)).not.toContain("abcdefghijklmnop");
    expect(result.report.replacements).toBeGreaterThanOrEqual(3);
  });

  it("writes parseable redacted JSONL logs with trace context", async () => {
    const dir = await mkdtemp(join(tmpdir(), "station-jsonl-"));
    const logger = createJsonlLogger({
      component: "observer",
      path: join(dir, "observer.jsonl"),
      clock: { now: () => new Date(now) },
    });
    await logger.info("Command accepted.", {
      traceId: "trc_1",
      spanId: "spn_1",
      token: "sk-secret000000000000",
    });

    const records = await readJsonlLog(logger.path);
    expect(records).toEqual([
      expect.objectContaining({
        timestamp: now,
        component: "observer",
        message: "Command accepted.",
        attributes: expect.objectContaining({
          traceId: "trc_1",
          token: "[REDACTED]",
        }),
      }),
    ]);
  });

  it("reads newest JSONL records in chronological order without reading the whole file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "station-jsonl-reverse-"));
    const path = join(dir, "observer.jsonl");
    const records = Array.from({ length: 2_000 }, (_, index) => logRecord(index));
    await writeFile(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);

    const result = await readJsonlReverse(path, LogRecordSchema, { maxRecords: 3 });

    expect(result.records.map((record) => record.message)).toEqual([
      "record-1997",
      "record-1998",
      "record-1999",
    ]);
    expect(result.bytesRead).toBeLessThan((await readFile(path)).byteLength);
    expect(result.complete).toBe(false);
    expect(result.invalidLines).toBe(0);
    await expect(readJsonlLog(path, 3)).resolves.toEqual(result.records);
  });

  it("preserves UTF-8 characters split across reverse chunks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "station-jsonl-utf8-"));
    const path = join(dir, "observer.jsonl");
    const longMessage = `${"a".repeat(64 * 1024 - 120)}🧭tail`;
    await writeFile(
      path,
      `${JSON.stringify(logRecord(1, longMessage))}\n${JSON.stringify(logRecord(2))}\n`,
    );

    const result = await readJsonlReverse(path, LogRecordSchema);

    expect(result.records[0]?.message).toBe(longMessage);
    expect(result.complete).toBe(true);
  });

  it("counts malformed complete lines and ignores an unterminated trailing write", async () => {
    const dir = await mkdtemp(join(tmpdir(), "station-jsonl-partial-"));
    const path = join(dir, "observer.jsonl");
    await writeFile(
      path,
      `${JSON.stringify(logRecord(1))}\nnot-json\n${JSON.stringify(logRecord(2))}\n{"partial":`,
    );

    const result = await readJsonlReverse(path, LogRecordSchema);

    expect(result.records.map((record) => record.message)).toEqual(["record-1", "record-2"]);
    expect(result.invalidLines).toBe(1);
    expect(result.complete).toBe(true);
    await expect(readJsonlLog(path)).rejects.toThrow("Invalid JSONL log record.");
  });

  it("enforces a byte ceiling and removes it in exhaustive mode", async () => {
    const dir = await mkdtemp(join(tmpdir(), "station-jsonl-cap-"));
    const path = join(dir, "observer.jsonl");
    const old = logRecord(1, `old-${"x".repeat(80 * 1024)}`);
    const recent = logRecord(2, "recent");
    await writeFile(path, `${JSON.stringify(old)}\n${JSON.stringify(recent)}\n`);

    const bounded = await readJsonlReverse(path, LogRecordSchema, { maxBytes: 64 * 1024 });
    const exhaustive = await readJsonlReverse(path, LogRecordSchema);

    expect(bounded).toMatchObject({ bytesRead: 64 * 1024, complete: false });
    expect(bounded.records.map((record) => record.message)).toEqual(["recent"]);
    expect(exhaustive.records.map((record) => record.message)).toEqual([
      expect.stringMatching(/^old-/u),
      "recent",
    ]);
    expect(exhaustive.complete).toBe(true);
  });

  it("defers records appended after the opened file high-water mark", async () => {
    const dir = await mkdtemp(join(tmpdir(), "station-jsonl-high-water-"));
    const path = join(dir, "observer.jsonl");
    await writeFile(path, `${JSON.stringify(logRecord(1))}\n`);
    let appended: Promise<void> | undefined;
    const appendingSchema = {
      safeParse(value: unknown) {
        appended ??= appendFile(path, `${JSON.stringify(logRecord(2))}\n`);
        return LogRecordSchema.safeParse(value);
      },
    };

    const first = await readJsonlReverse(path, appendingSchema);
    await appended;
    const second = await readJsonlReverse(path, LogRecordSchema);

    expect(first.records.map((record) => record.message)).toEqual(["record-1"]);
    expect(second.records.map((record) => record.message)).toEqual(["record-1", "record-2"]);
  });

  it("returns an empty complete result for a missing JSONL file", async () => {
    const result = await readJsonlReverse("/definitely/missing/station.jsonl", LogRecordSchema);
    expect(result).toEqual({ records: [], bytesRead: 0, complete: true, invalidLines: 0 });
  });

  it("keeps SafeError output safe while storing redacted internal envelopes", () => {
    const externalCommandError = {
      tag: "ExternalCommandError",
      code: "EXTERNAL_COMMAND_FAILED",
      message: "External command failed.",
      command: "wt switch --create feature --api-key [REDACTED]",
      cwd: "/tmp/station/web",
      exitCode: 128,
      stderrSnippet: "fatal: branch already exists sk-secret000000000000",
      diagnosticDetails: [
        {
          type: "external_command",
          provider: "worktrunk",
          operation: "provider.worktrunk.switch",
          command: "wt switch --create feature --api-key [REDACTED]",
          cwd: "/tmp/station/web",
          exitCode: 128,
          stderrSnippet: "fatal: branch already exists sk-secret000000000000",
          durationMs: 12,
        },
      ],
    };
    const safeError = toSafeError(externalCommandError, {
      tag: "ProviderUnavailableError",
      code: "PROVIDER_FAILED",
      message: "Provider failed.",
    });
    const envelope = createErrorEnvelope({
      id: "err_1",
      error: externalCommandError,
      fallback: {
        tag: "ProviderUnavailableError",
        code: "PROVIDER_FAILED",
        message: "Provider failed.",
      },
      traceId: "trc_1",
      spanId: "spn_1",
      createdAt: now,
      raw: {
        token: "sk-secret000000000000",
      },
    });

    expect(envelope.traceId).toBe("trc_1");
    expect(JSON.stringify(safeError)).not.toContain("diagnosticDetails");
    expect(envelope.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "external_command",
          provider: "worktrunk",
          operation: "provider.worktrunk.switch",
          cwd: "/tmp/station/web",
          exitCode: 128,
          durationMs: 12,
        }),
      ]),
    );
    expect(JSON.stringify(envelope)).not.toContain("sk-secret");
    expect(envelope.redacted).toBe(true);
  });

  it("keeps nested provider errors lean while retaining typed envelope evidence", () => {
    const commandError = Object.assign(new Error("External command failed."), {
      tag: "ExternalCommandError",
      code: "EXTERNAL_COMMAND_FAILED",
      command: "wt switch feature",
      diagnosticDetails: [
        {
          type: "external_command",
          provider: "worktrunk",
          operation: "provider.worktrunk.switch",
          command: "wt switch feature",
          stderrSnippet: "OPENAI_TOKEN=secret-value branch already exists",
        },
      ],
    });
    const providerError = Object.assign(new Error("Worktrunk failed to switch worktrees."), {
      tag: "WorktreeProviderError",
      code: "WORKTRUNK_COMMAND_FAILED",
      provider: "worktrunk",
      cause: commandError,
    });

    const safeError = toSafeError(providerError, {
      tag: "WorktreeProviderError",
      code: "WORKTRUNK_COMMAND_FAILED",
      message: "Worktrunk failed to switch worktrees.",
    });
    const envelope = createErrorEnvelope({
      id: "err_nested",
      error: providerError,
      fallback: {
        tag: "WorktreeProviderError",
        code: "WORKTRUNK_COMMAND_FAILED",
        message: "Worktrunk failed to switch worktrees.",
      },
      createdAt: now,
    });

    expect(safeError).toEqual({
      tag: "WorktreeProviderError",
      code: "WORKTRUNK_COMMAND_FAILED",
      message: "Worktrunk failed to switch worktrees.",
      provider: "worktrunk",
    });
    expect(envelope.diagnostics).toEqual([
      expect.objectContaining({
        type: "external_command",
        operation: "provider.worktrunk.switch",
        stderrSnippet: "OPENAI_TOKEN=[REDACTED] branch already exists",
      }),
    ]);
    expect(JSON.stringify(envelope)).not.toContain("secret-value");
  });

  it("merges retention defaults and scans local state usage", async () => {
    const dir = await mkdtemp(join(tmpdir(), "station-retention-"));
    await mkdir(join(dir, "logs"), { recursive: true });
    await writeFile(join(dir, "logs", "observer.jsonl"), "{}\n", "utf8");

    const policy = mergeRetentionPolicy({ maxDays: 7, debugBundles: { maxBundles: 3 } });
    const usage = await scanLocalStateUsage(dir, policy);

    expect(policy.maxDays).toBe(7);
    expect(policy.debugBundles.maxBundles).toBe(3);
    expect(policy.maxTotalMb).toBe(DEFAULT_RETENTION_POLICY.maxTotalMb);
    expect(usage.entries.find((entry) => entry.kind === "logs")?.fileCount).toBe(1);
  });

  it("writes a redacted debug bundle manifest and sections", async () => {
    const dir = await mkdtemp(join(tmpdir(), "station-bundle-writer-"));
    const manifest = await writeDebugBundle({
      diagnosticsDir: dir,
      snapshot: minimalSnapshot(),
      now: new Date(now),
      bundleId: "diag_unit",
    });

    expect(manifest.sections).toContain("manifest.json");
    expect(manifest.sections).toContain("diagnostic-index.json");
    expect(manifest.traceIds).toEqual(["trc_1"]);
    const bundleText = await readFile(join(manifest.bundlePath, "errors.jsonl"), "utf8");
    expect(bundleText).not.toContain("sk-secret");
    const index = JSON.parse(
      await readFile(join(manifest.bundlePath, "diagnostic-index.json"), "utf8"),
    ) as DiagnosticEvidenceIndex;
    expect(index.rootCauses.map((cause) => cause.code)).toContain("COMMAND_FAILED");
  });
});

function logRecord(index: number, message = `record-${index}`) {
  return {
    timestamp: new Date(Date.parse(now) + index).toISOString(),
    level: "info" as const,
    component: "observer" as const,
    message,
  };
}

function minimalSnapshot(): DiagnosticSnapshot {
  return {
    schemaVersion: "0.9.0",
    collectedAt: now,
    observerHealth: {
      schemaVersion: "0.9.0",
      status: "healthy",
      pid: 1234,
      startedAt: now,
      version: "0.0.0",
    },
    snapshot: {
      schemaVersion: "0.9.0",
      generatedAt: now,
      observer: {
        pid: 1234,
        startedAt: now,
        version: "0.0.0",
        healthy: true,
      },
      providerHealth: {},
      projects: [],
      rows: [],
      sessions: [],
      counts: {
        projects: 0,
        sessions: 0,
        worktrees: 0,
        agents: 0,
        working: 0,
        idle: 0,
        attention: 0,
        unknown: 0,
      },
      alerts: [],
    },
    providerHealth: {},
    commands: [
      {
        id: "cmd_1",
        type: "observer.reconcile",
        command: { type: "observer.reconcile", payload: { reason: "unit" } },
        status: "failed",
        createdAt: now,
        traceId: "trc_1",
        spanId: "spn_1",
      },
    ],
    events: [
      {
        type: "command.failed",
        commandId: "cmd_1",
        traceId: "trc_1",
        spanId: "spn_1",
        error: {
          tag: "CommandExecutionError",
          code: "COMMAND_FAILED",
          message: "Command failed.",
        },
      },
    ],
    errors: [
      {
        id: "err_1",
        tag: "CommandExecutionError",
        code: "COMMAND_FAILED",
        message: "provider leaked sk-secret000000000000",
        severity: "error",
        commandId: "cmd_1",
        traceId: "trc_1",
        spanId: "spn_1",
        redacted: false,
        createdAt: now,
      },
    ],
    logs: [],
  };
}

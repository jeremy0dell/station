import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiagnosticEvidenceIndex, DiagnosticSnapshot } from "@station/contracts";
import {
  createErrorEnvelope,
  createJsonlLogger,
  DEFAULT_RETENTION_POLICY,
  mergeRetentionPolicy,
  readJsonlLog,
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

function minimalSnapshot(): DiagnosticSnapshot {
  return {
    schemaVersion: "0.7.0",
    collectedAt: now,
    observerHealth: {
      schemaVersion: "0.7.0",
      status: "healthy",
      pid: 1234,
      startedAt: now,
      version: "0.0.0",
    },
    snapshot: {
      schemaVersion: "0.7.0",
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

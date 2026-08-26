import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { DiagnosticEvidenceIndexSchema, type DiagnosticSnapshot } from "@station/contracts";
import {
  allowlistedCliRunAuditMetadata,
  appendDurableCliInvocationRecord,
  createErrorEnvelope,
  createJsonlLogger,
  createUiLifecycleRecorder,
  DEFAULT_RETENTION_POLICY,
  mergeRetentionPolicy,
  pruneRotatedComponentLogs,
  readBoundedComponentLogs,
  readJsonlLog,
  redact,
  scanLocalStateUsage,
  toSafeError,
  writeDebugBundle,
} from "@station/observability";
import { describe, expect, it } from "vitest";

const now = "2026-05-20T12:00:00.000Z";
const execFileAsync = promisify(execFile);

describe("observability helpers", () => {
  it("durably appends private strict CLI invocation records", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "station-cli-audit-"));
    const record = invocationRecord("start");

    const result = await appendDurableCliInvocationRecord({
      stateDir,
      policy: DEFAULT_RETENTION_POLICY,
      record,
      now: new Date(now),
    });

    expect(result.record).toEqual(record);
    const logDirStat = await lstat(join(stateDir, "logs"));
    const fileStat = await lstat(join(stateDir, "logs", "cli.jsonl"));
    expect(logDirStat.mode & 0o777).toBe(0o700);
    expect(fileStat.mode & 0o777).toBe(0o600);
    expect(await readJsonlLog(join(stateDir, "logs", "cli.jsonl"))).toEqual([record]);
  });

  it("rejects a symlink CLI invocation target", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "station-cli-audit-symlink-"));
    const logDir = join(stateDir, "logs");
    await mkdir(logDir, { mode: 0o700 });
    const target = join(stateDir, "outside.jsonl");
    await writeFile(target, "", "utf8");
    await symlink(target, join(logDir, "cli.jsonl"));

    await expect(
      appendDurableCliInvocationRecord({
        stateDir,
        policy: DEFAULT_RETENTION_POLICY,
        record: invocationRecord("start"),
      }),
    ).rejects.toThrow("not a regular file");
    expect(await readFile(target, "utf8")).toBe("");
  });

  it("uses one append write followed by sync and rejects a partial write", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "station-cli-audit-write-"));
    const events: string[] = [];
    const openFile = async () => ({
      stat: async () => {
        events.push("stat");
        return { isFile: () => true };
      },
      chmod: async () => {
        events.push("chmod");
      },
      write: async (_buffer: Uint8Array, _offset: number, length: number) => {
        events.push("write");
        return { bytesWritten: length };
      },
      sync: async () => {
        events.push("sync");
      },
      close: async () => {
        events.push("close");
      },
    });

    await appendDurableCliInvocationRecord({
      stateDir,
      policy: DEFAULT_RETENTION_POLICY,
      record: invocationRecord("start"),
      openFile,
    });
    expect(events).toEqual(["stat", "chmod", "write", "sync", "close"]);

    events.length = 0;
    await expect(
      appendDurableCliInvocationRecord({
        stateDir: await mkdtemp(join(tmpdir(), "station-cli-audit-partial-")),
        policy: DEFAULT_RETENTION_POLICY,
        record: invocationRecord("start"),
        openFile: async () => {
          const handle = await openFile();
          return {
            ...handle,
            write: async (_buffer: Uint8Array, _offset: number, length: number) => {
              events.push("write");
              return { bytesWritten: length - 1 };
            },
          };
        },
      }),
    ).rejects.toThrow("not durable");
    expect(events).toEqual(["stat", "chmod", "write", "close"]);
  });

  it("rotates CLI logs before the component limit and reads malformed evidence boundedly", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "station-cli-audit-rotate-"));
    const logDir = join(stateDir, "logs");
    await mkdir(logDir, { mode: 0o700 });
    await writeFile(join(logDir, "cli.jsonl"), Buffer.alloc(1024 * 1024, 32));
    const policy = mergeRetentionPolicy({
      maxFileMb: 1,
      components: { cliMaxMb: 1 },
      maxFilesPerComponent: 2,
    });

    const appended = await appendDurableCliInvocationRecord({
      stateDir,
      policy,
      record: invocationRecord("start"),
      now: new Date(now),
    });
    await writeFile(join(logDir, "cli.bad.jsonl"), "{bad-json}\n", "utf8");
    await symlink(join(logDir, "cli.jsonl"), join(logDir, "cli.unreadable.jsonl"));
    const read = await readBoundedComponentLogs({
      stateDir,
      component: "cli",
      maxBytesPerFile: 4096,
    });

    expect(appended.rotated).toBe(true);
    expect((await readdir(logDir)).some((name) => name.startsWith("cli.2026-"))).toBe(true);
    expect(read.records).toContainEqual(invocationRecord("start"));
    expect(read.evidence.malformedLines).toBeGreaterThan(0);
    expect(read.evidence.unreadableFiles).toBe(1);
    expect(read.evidence.truncatedFiles).toBe(1);
  });

  it("counts the active log within per-component retention while pruning only rotated files", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "station-cli-audit-prune-"));
    const logDir = join(stateDir, "logs");
    await mkdir(logDir, { mode: 0o700 });
    const activePath = join(logDir, "cli.jsonl");
    const oldPaths = [join(logDir, "cli.old-1.jsonl"), join(logDir, "cli.old-2.jsonl")];
    await writeFile(activePath, "active\n", "utf8");
    for (const path of oldPaths) {
      await writeFile(path, "rotated\n", "utf8");
      await utimes(
        path,
        new Date("2026-05-20T11:00:00.000Z"),
        new Date("2026-05-20T11:00:00.000Z"),
      );
    }

    const result = await pruneRotatedComponentLogs({
      stateDir,
      component: "cli",
      policy: mergeRetentionPolicy({ maxFilesPerComponent: 2 }),
      now: new Date(now),
    });

    expect(result).toEqual({ deleted: 1, failures: 0 });
    expect(await readFile(activePath, "utf8")).toBe("active\n");
    const remaining = (await readdir(logDir)).filter((name) => name.startsWith("cli.old-"));
    expect(remaining).toHaveLength(1);
    expect((await lstat(join(logDir, remaining[0] ?? "missing"))).mode & 0o777).toBe(0o600);
  });

  it("drops suspicious exact audit identifiers instead of modifying them", () => {
    const metadata = allowlistedCliRunAuditMetadata({
      commandStatus: "succeeded",
      resources: {
        projectId: "web",
        sessionId: "sk-secret000000000000",
      },
      error: {
        tag: "CommandError",
        code: "FAILED",
        message: "private provider failure",
      },
    });

    expect(metadata).toEqual({
      commandStatus: "succeeded",
      resources: { projectId: "web" },
      error: { tag: "CommandError", code: "FAILED" },
    });
    expect(JSON.stringify(metadata)).not.toContain("sk-secret");
    expect(JSON.stringify(metadata)).not.toContain("private provider failure");
  });

  it("keeps mixed Node and Bun durable appends line-isolated", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "station-cli-audit-concurrency-"));
    const moduleUrl = pathToFileURL(
      join(process.cwd(), "packages", "observability", "dist", "index.js"),
    ).href;
    const script = `
        import { appendDurableCliInvocationRecord, DEFAULT_RETENTION_POLICY } from ${JSON.stringify(moduleUrl)};
        const writer = Number(process.env.STATION_TEST_AUDIT_WRITER);
        for (let index = 0; index < 10; index += 1) {
          const suffix = String(writer * 100 + index).padStart(12, "0");
          const invocationId = "11111111-1111-4111-8111-" + suffix;
          const cliInvocation = {
            kind: "start",
            invocationId,
            startedAt: ${JSON.stringify(now)},
            build: { status: "available", version: "0.7.0", compiled: false, buildIdentity: "${"a".repeat(64)}" },
            intentPath: [],
            arguments: { argumentCount: 0, positionalCount: 0, recognizedOptions: [], stdinRequested: false },
            effect: "none",
            sink: { source: "configured", configResolution: "explicit" },
            callerClaims: { tmux: false, tmuxPane: false }
          };
          const record = {
            timestamp: ${JSON.stringify(now)}, level: "info", component: "cli",
            message: "cli.invocation.start", invocationId, cliInvocation
          };
          await appendDurableCliInvocationRecord({ stateDir: process.env.STATION_TEST_AUDIT_STATE, policy: DEFAULT_RETENTION_POLICY, record });
        }
      `;
    const childEnv = (writer: string) => ({
      ...process.env,
      STATION_TEST_AUDIT_STATE: stateDir,
      STATION_TEST_AUDIT_WRITER: writer,
    });

    await Promise.all([
      execFileAsync(process.execPath, ["--input-type=module", "--eval", script], {
        env: childEnv("1"),
      }),
      execFileAsync("bun", ["--eval", script], { env: childEnv("2") }),
    ]);

    const read = await readBoundedComponentLogs({ stateDir, component: "cli" });
    expect(read.evidence.malformedLines).toBe(0);
    expect(read.records).toHaveLength(20);
    expect(new Set(read.records.map((record) => record.invocationId)).size).toBe(20);
  }, 20_000);

  it("recursively redacts secret-looking keys and values", () => {
    const result = redact(
      {
        headers: { authorization: "Bearer abcdefghijklmnop" },
        env: { OPENAI_API_KEY: "sk-secret000000000000" },
        placement: { authorityId: "placement-authority" },
        output: "TOKEN=super-secret-value",
      },
      new Date(now),
    );

    expect(JSON.stringify(result.value)).not.toContain("sk-secret");
    expect(JSON.stringify(result.value)).not.toContain("abcdefghijklmnop");
    expect(JSON.stringify(result.value)).not.toContain("placement-authority");
    expect(result.report.redactedFields).toContain("placement.authorityId");
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

  it("serializes and flushes source-ordered UI lifecycle records", async () => {
    const dir = await mkdtemp(join(tmpdir(), "station-ui-lifecycle-log-"));
    const logger = createJsonlLogger({
      component: "cli",
      path: join(dir, "cli.jsonl"),
      clock: { now: () => new Date(now) },
    });
    const lifecycle = createUiLifecycleRecorder({
      logger,
      component: "cli",
      sourceId: "launcher-test",
      pid: 100,
      clock: { now: () => new Date(now) },
    });
    const uiRunId = "ui_11111111-1111-4111-8111-111111111111";

    await Promise.all([
      lifecycle.record(
        { kind: "renderer.spawned", uiRunId, rendererPid: 101, entry: "station" },
        "info",
      ),
      lifecycle.record(
        {
          kind: "renderer.exited",
          uiRunId,
          rendererPid: 101,
          exitCode: null,
          signal: "SIGTERM",
        },
        "warn",
      ),
    ]);
    await lifecycle.flush();

    const records = await readJsonlLog(logger.path);
    expect(records.map((record) => record.lifecycle?.kind)).toEqual([
      "renderer.spawned",
      "renderer.exited",
    ]);
    expect(records.map((record) => record.lifecycle?.source.sequence)).toEqual([0, 1]);
    expect(records.map((record) => record.level)).toEqual(["info", "warn"]);
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
    let rawIndex: unknown;
    try {
      rawIndex = JSON.parse(
        await readFile(join(manifest.bundlePath, "diagnostic-index.json"), "utf8"),
      );
    } catch (error) {
      throw new Error("The debug bundle diagnostic index was not valid JSON.", { cause: error });
    }
    const index = DiagnosticEvidenceIndexSchema.parse(rawIndex);
    expect(index.rootCauses.map((cause) => cause.code)).toContain("COMMAND_FAILED");
  });
});

function minimalSnapshot(): DiagnosticSnapshot {
  return {
    schemaVersion: "0.11.0",
    collectedAt: now,
    observerHealth: {
      schemaVersion: "0.11.0",
      status: "healthy",
      pid: 1234,
      startedAt: now,
      version: "0.0.0",
    },
    snapshot: {
      schemaVersion: "0.11.0",
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
      sessionGroups: [],
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

function invocationRecord(kind: "start" | "outcome") {
  const invocationId = "11111111-1111-4111-8111-111111111111";
  const cliInvocation =
    kind === "start"
      ? {
          kind,
          invocationId,
          startedAt: now,
          build: {
            status: "available" as const,
            version: "0.7.0",
            compiled: false,
            buildIdentity: "a".repeat(64),
          },
          intentPath: ["version"],
          arguments: {
            argumentCount: 1,
            positionalCount: 0,
            recognizedOptions: ["--version"],
            stdinRequested: false,
          },
          effect: "none" as const,
          sink: { source: "configured" as const, configResolution: "explicit" as const },
          callerClaims: { tmux: false, tmuxPane: false },
        }
      : {
          kind,
          invocationId,
          finishedAt: now,
          durationMs: 10,
          status: "version" as const,
          exitCode: 0,
          resolvedPath: [],
        };
  return {
    timestamp: now,
    level: "info" as const,
    component: "cli" as const,
    message: kind === "start" ? "cli.invocation.start" : "cli.invocation.outcome",
    invocationId,
    cliInvocation,
  };
}

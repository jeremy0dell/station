import { mkdir, mkdtemp, open, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { runCli } from "@station/cli";
import type { DoctorReport, LogRecord } from "@station/contracts";
import { LogRecordSchema } from "@station/contracts";
import { readJsonlReverse } from "@station/observability";
import { describe, expect, it, vi } from "vitest";
import { createTempState, writeConfigToml } from "../../../support/temp-projects";
import { classifyDiagnosticEvidenceIndex } from "../../oracles/diagnosticOracle";

const now = "2026-05-20T12:00:00.000Z";
const buildVersion = `0.7.0+station.${"a".repeat(64)}`;
const maxSearchBytes = 8 * 1024 * 1024;
const timed = process.env.STATION_AGENT_DEBUG_PERF === "1";

type MatrixRow = {
  id: `A${number}`;
  calls: number;
  correctness: "pass";
  elapsedMedianMs: number;
  elapsedP95Ms: number;
  bytes: number;
  lines: number;
  approximateTokens: number;
  bytesRead: number;
};

describe("agent debugging acceptance matrix", () => {
  it(
    "passes A1-A10 and emits one machine-readable row per item",
    async () => {
      const fixture = await createTempState();
      const configPath = await writeConfigToml(fixture.root, fixture.config);
      const health = {
        schemaVersion: "0.9.0",
        status: "healthy" as const,
        pid: 1234,
        startedAt: now,
        version: buildVersion,
        socketPath: fixture.socketPath,
        uptimeMs: 42_000,
        hookSpoolDepth: 7,
        providerHealth: {},
      };

      const a1 = await measure(async () =>
        runCli(["--config", configPath, "observer", "status"], {
          observerDeps: { clientFactory: () => ({ health: async () => health }) as never },
        }),
      );
      expect(a1.value).toMatchObject({
        code: 0,
        output: {
          status: "running",
          socketPath: fixture.socketPath,
          health: {
            status: "healthy",
            pid: 1234,
            startedAt: now,
            version: buildVersion,
            uptimeMs: 42_000,
          },
        },
      });
      expect(a1.value.output).not.toHaveProperty("health.providerHealth");
      emit(assertRow("A1", 1, a1.value.output, a1.samples, 0, { bytes: 1_500, lines: 40 }));

      const actionableReport = doctorReport(fixture.stateDir, "degraded");
      actionableReport.checks.push({
        name: "provider-current",
        status: "warn",
        message: "Provider failed.",
        error: {
          tag: "ProviderError",
          code: "PROVIDER_CURRENT",
          message: "Provider failed with current evidence.",
          traceId: "trc_current",
          commandId: "cmd_current",
          diagnosticId: "diag_current",
        },
      });
      actionableReport.recentErrors.push({
        tag: "HistoricalError",
        code: "HISTORICAL_ONLY",
        message: "Historical error.",
      });
      actionableReport.logs.recent = Array.from({ length: 20 }, (_, index) => ({
        timestamp: new Date(Date.parse(now) + index).toISOString(),
        level: "info",
        component: "observer",
        message: `full-only-${index}-${"x".repeat(200)}`,
      }));
      const doctorRpc = vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return actionableReport;
      });
      const doctorDeps = {
        buildVersion,
        clientFactory: () =>
          ({
            health: async () => health,
            runDoctor: doctorRpc,
          }) as never,
      };
      const a2 = await measure(async () =>
        runCli(["--config", configPath, "doctor"], { observerDeps: doctorDeps }),
      );
      const a2Full = await measure(async () =>
        runCli(["--config", configPath, "doctor", "--full"], { observerDeps: doctorDeps }),
      );
      expect(a2.value.output).toMatchObject({
        findings: [
          expect.objectContaining({
            severity: "warn",
            message: "Provider failed with current evidence.",
            code: "PROVIDER_CURRENT",
            traceId: "trc_current",
            commandId: "cmd_current",
            diagnosticId: "diag_current",
          }),
        ],
        counts: { historicalErrors: 1 },
      });
      expect(JSON.stringify(a2.value.output)).not.toContain("HISTORICAL_ONLY");
      expect(doctorRpc).toHaveBeenCalledTimes(a2.samples.length + a2Full.samples.length + 2);
      const a2Metrics = outputMetrics(a2.value.output);
      const a2FullMetrics = outputMetrics(a2Full.value.output);
      expect(a2Metrics.bytes).toBeLessThanOrEqual(Math.floor(a2FullMetrics.bytes * 0.25));
      if (timed) {
        expect(median(a2.samples)).toBeLessThanOrEqual(median(a2Full.samples) * 1.1);
      }
      emit(assertRow("A2", 1, a2.value.output, a2.samples, 0, { bytes: 4_096, lines: 80 }));

      await mkdir(join(fixture.stateDir, "logs"), { recursive: true });
      await writeFile(
        join(fixture.stateDir, "logs", "observer.jsonl"),
        `${JSON.stringify(failureRecord("RECENT_ROOT_CAUSE", "cmd_recent", "trc_recent"))}\n`,
      );
      const a3 = await measure(async () =>
        runCli(["--config", configPath, "debug", "trace", "--latest-failure"]),
      );
      expect(a3.value).toMatchObject({
        code: 0,
        output: {
          command: { id: "cmd_recent", traceId: "trc_recent" },
          rootCauseCodes: ["RECENT_ROOT_CAUSE"],
          suggestedCommands: [],
        },
      });
      emit(
        assertRow("A3", 1, a3.value.output, a3.samples, a3.value.output.search.bytesRead, {
          bytes: 2_048,
          lines: 60,
        }),
      );

      const recentWarnings = Array.from({ length: 7 }, (_, index) => ({
        timestamp: new Date(Date.parse(now) + index).toISOString(),
        level: "warn",
        component: "observer",
        message: `warning-${index}`,
        attributes: {
          error: { code: `WARNING_${index}`, message: `warning-${index}` },
        },
      }));
      await writeFile(
        join(fixture.stateDir, "logs", "observer.jsonl"),
        `${recentWarnings.map((record) => JSON.stringify(record)).join("\n")}\n`,
      );
      const a4 = await measure(async () => runCli(["--config", configPath, "debug", "logs"]));
      expect(a4.value.output.records).toHaveLength(5);
      expect(a4.value.output.records.at(-1)).toMatchObject({
        message: "warning-6",
        error: { code: "WARNING_6" },
      });
      emit(
        assertRow("A4", 1, a4.value.output, a4.samples, a4.value.output.search.bytesRead, {
          bytes: 4_096,
          lines: 100,
        }),
      );

      const oldRecord = {
        timestamp: "2026-05-20T10:00:00.000Z",
        level: "warn",
        component: "observer",
        message: "old-query-marker",
      };
      const paddingRecord = {
        timestamp: now,
        level: "info",
        component: "observer",
        message: "x".repeat(maxSearchBytes + 1024),
      };
      await writeFile(
        join(fixture.stateDir, "logs", "observer.jsonl"),
        `${JSON.stringify(oldRecord)}\n${JSON.stringify(paddingRecord)}\n`,
      );
      const a5First = await measure(async () =>
        runCli(["--config", configPath, "debug", "logs", "old-query-marker"]),
      );
      expect(a5First.value).toMatchObject({
        code: 1,
        output: {
          matched: 0,
          search: { complete: false },
          retryCommand: "stn debug logs old-query-marker --full",
        },
      });
      const a5Second = await runCli([
        "--config",
        configPath,
        "debug",
        "logs",
        "old-query-marker",
        "--full",
      ]);
      expect(a5Second).toMatchObject({
        code: 0,
        output: { records: [{ message: "old-query-marker" }] },
      });
      expect(a5First.value.output.search.bytesRead).toBeLessThanOrEqual(maxSearchBytes * 3);
      emit(
        assertRow(
          "A5",
          2,
          a5First.value.output,
          a5First.samples,
          a5First.value.output.search.bytesRead,
          { bytes: 2_048 },
        ),
      );

      const healthyReport = doctorReport(fixture.stateDir, "healthy");
      const a6 = await measure(async () =>
        runCli(["--config", configPath, "doctor"], {
          observerDeps: {
            buildVersion,
            clientFactory: () =>
              ({ health: async () => health, runDoctor: async () => healthyReport }) as never,
          },
        }),
      );
      expect(a6.value.output).toMatchObject({
        status: "healthy",
        findings: [],
        detailsCommand: "stn doctor --full",
      });
      expect(a6.value.output).not.toHaveProperty("snapshot");
      emit(assertRow("A6", 1, a6.value.output, a6.samples, 0, { bytes: 1_500 }));

      const invalidConfigPath = join(
        await mkdtemp(join(tmpdir(), "station-agent-invalid-")),
        "config.toml",
      );
      await writeFile(
        invalidConfigPath,
        "schema_version = 1\nprojects = []\n[defaults]\nterminal = 42\n",
      );
      const spawnObserver = vi.fn(async () => {
        throw new Error("invalid config must not start the observer");
      });
      const a7 = await measure(async () =>
        runCli(["--config", invalidConfigPath, "doctor"], {
          observerDeps: { spawnObserver },
        }),
      );
      expect(a7.value).toMatchObject({
        code: 1,
        output: {
          findings: [
            expect.objectContaining({
              code: "CONFIG_VALIDATION_FAILED",
              diagnosticId: "config-load",
            }),
          ],
        },
      });
      expect(spawnObserver).not.toHaveBeenCalled();
      emit(assertRow("A7", 1, a7.value.output, a7.samples, 0, { bytes: 2_048 }));

      const scenarioDir = new URL(".", import.meta.url);
      const scenarioFiles = (await readdir(scenarioDir))
        .filter((file) => file.endsWith(".json"))
        .sort();
      const classifications = await Promise.all(
        scenarioFiles.map(async (file) => {
          const scenario = JSON.parse(await readFile(new URL(file, scenarioDir), "utf8")) as {
            name: string;
            expectedRootCause: string;
            evidenceIndex: unknown;
          };
          return {
            name: scenario.name,
            expected: scenario.expectedRootCause,
            actual: classifyDiagnosticEvidenceIndex(scenario.evidenceIndex).rootCause,
          };
        }),
      );
      expect(classifications).toHaveLength(7);
      expect(classifications.every((result) => result.actual === result.expected)).toBe(true);
      emit(assertRow("A8", 1, classifications, [0], 0));

      const perfRoot = await mkdtemp(join(tmpdir(), "station-agent-debug-perf-"));
      const logPaths = [
        { path: join(perfRoot, "observer.jsonl"), bytes: timed ? 64 : 12 },
        { path: join(perfRoot, "cli.jsonl"), bytes: timed ? 16 : 1 },
        { path: join(perfRoot, "tui.jsonl"), bytes: timed ? 16 : 1 },
      ];
      for (const [index, entry] of logPaths.entries()) {
        await writeSizedLog(entry.path, entry.bytes * 1024 * 1024, index === 0);
      }
      const benchmark = await benchmarkReaders(logPaths.map((entry) => entry.path));
      expect(benchmark.newRecords).toEqual(benchmark.legacyRecords);
      expect(benchmark.bytesRead).toBeLessThanOrEqual(maxSearchBytes * 3);
      if (timed) {
        expect(median(benchmark.newSamples)).toBeLessThanOrEqual(
          median(benchmark.legacySamples) * 0.35,
        );
        expect(p95(benchmark.newSamples)).toBeLessThanOrEqual(p95(benchmark.legacySamples) * 0.5);
      }
      emit(
        assertRow(
          "A9",
          0,
          { records: benchmark.newRecords },
          benchmark.newSamples,
          benchmark.bytesRead,
        ),
      );

      const defaultSuggestions = [
        ...a3.value.output.suggestedCommands,
        ...(a5First.value.output.retryCommand === undefined
          ? []
          : [a5First.value.output.retryCommand]),
      ];
      expect(defaultSuggestions).not.toEqual(
        expect.arrayContaining([
          expect.stringMatching(
            /\b(?:bundle|doctor|reconcile|dispatch|install|remove|stop|start)\b/u,
          ),
        ]),
      );
      expect(defaultSuggestions.filter((command) => command.includes("--full"))).toEqual([
        "stn debug logs old-query-marker --full",
      ]);
      emit(assertRow("A10", 0, { commands: defaultSuggestions }, [0], 0));
    },
    timed ? 180_000 : 60_000,
  );
});

async function measure<T>(run: () => Promise<T>): Promise<{ value: T; samples: number[] }> {
  const warm = await run();
  if (!timed) {
    const started = performance.now();
    return { value: await run(), samples: [performance.now() - started] };
  }
  const samples: number[] = [];
  let value = warm;
  for (let index = 0; index < 7; index += 1) {
    const started = performance.now();
    value = await run();
    samples.push(performance.now() - started);
  }
  return { value, samples };
}

function assertRow(
  id: MatrixRow["id"],
  calls: number,
  output: unknown,
  elapsed: readonly number[],
  bytesRead: number,
  limits: { bytes?: number; lines?: number } = {},
): MatrixRow {
  const metrics = outputMetrics(output);
  if (limits.bytes !== undefined)
    expect(metrics.bytes, `${id} bytes`).toBeLessThanOrEqual(limits.bytes);
  if (limits.lines !== undefined)
    expect(metrics.lines, `${id} lines`).toBeLessThanOrEqual(limits.lines);
  const elapsedMedianMs = median(elapsed);
  const elapsedP95Ms = p95(elapsed);
  if (timed) {
    const threshold: readonly [number, number] | undefined =
      id === "A1"
        ? [300, 450]
        : id === "A2" || id === "A6"
          ? [750, 750]
          : id === "A3" || id === "A4"
            ? [400, 550]
            : undefined;
    if (threshold !== undefined) {
      expect(elapsedMedianMs, `${id} median`).toBeLessThanOrEqual(threshold[0]);
      expect(elapsedP95Ms, `${id} p95`).toBeLessThanOrEqual(threshold[1]);
    }
  }
  return {
    id,
    calls,
    correctness: "pass",
    elapsedMedianMs: round(elapsedMedianMs),
    elapsedP95Ms: round(elapsedP95Ms),
    bytes: metrics.bytes,
    lines: metrics.lines,
    approximateTokens: Math.ceil(metrics.bytes / 4),
    bytesRead,
  };
}

function emit(row: MatrixRow): void {
  console.log(JSON.stringify(row));
}

function outputMetrics(output: unknown): { bytes: number; lines: number } {
  const rendered = `${JSON.stringify(output, null, 2)}\n`;
  return { bytes: Buffer.byteLength(rendered), lines: rendered.split("\n").length - 1 };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function p95(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function failureRecord(code: string, commandId: string, traceId: string): LogRecord {
  return LogRecordSchema.parse({
    timestamp: now,
    level: "error",
    component: "observer",
    message: "Command failed.",
    traceId,
    commandId,
    attributes: {
      commandId,
      traceId,
      error: { tag: "CommandError", code, message: "Command failed." },
    },
  });
}

function doctorReport(stateDir: string, status: DoctorReport["status"]): DoctorReport {
  return {
    schemaVersion: "0.9.0",
    generatedAt: now,
    status,
    checks: [{ name: "observer", status: "ok", message: "Observer is healthy." }],
    observer: {
      schemaVersion: "0.9.0",
      status: "healthy",
      pid: 1234,
      startedAt: now,
      version: buildVersion,
    },
    config: { projectCount: 0, diagnostics: [] },
    providers: {},
    snapshot: {
      schemaVersion: "0.9.0",
      generatedAt: now,
      observer: { pid: 1234, startedAt: now, version: buildVersion, healthy: true },
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
    logs: { paths: [], recent: [] },
    localState: {
      stateDir,
      totalBytes: 0,
      limitBytes: 262_144_000,
      overLimit: false,
      entries: [],
    },
    retention: {
      maxDays: 14,
      maxTotalMb: 250,
      maxFileMb: 25,
      maxFilesPerComponent: 4,
      components: {
        observerMaxMb: 64,
        cliMaxMb: 16,
        tuiMaxMb: 16,
        hookRunnerMaxMb: 16,
        providerMaxMb: 32,
      },
      sqlite: {
        eventsMaxDays: 14,
        commandsMaxDays: 30,
        errorsMaxDays: 30,
        providerObservationsMaxDays: 14,
      },
      debugBundles: { maxBundles: 20, maxDays: 14 },
      hookSpool: { deliveredDeleteImmediately: true, failedMaxDays: 7, failedMaxItems: 1000 },
    },
    recentErrors: [],
    debugBundle: { available: true, diagnosticsDir: join(stateDir, "diagnostics") },
  };
}

async function writeSizedLog(path: string, targetBytes: number, includeRecentFailure: boolean) {
  const file = await open(path, "w");
  const recent = includeRecentFailure
    ? Buffer.from(
        `${JSON.stringify(failureRecord("PERF_RECENT_FAILURE", "cmd_perf", "trc_perf"))}\n`,
      )
    : Buffer.alloc(0);
  const old = includeRecentFailure
    ? Buffer.from(
        `${JSON.stringify({
          timestamp: "2026-05-20T10:00:00.000Z",
          level: "warn",
          component: "observer",
          message: "perf-old-query-marker",
        })}\n`,
      )
    : Buffer.alloc(0);
  const template = Buffer.from(
    `${JSON.stringify({
      timestamp: now,
      level: "info",
      component: "observer",
      message: "x".repeat(900),
    })}\n`,
  );
  const block = Buffer.concat(Array.from({ length: 1024 }, () => template));
  let written = 0;
  try {
    if (old.length > 0) {
      await file.write(old);
      written += old.length;
    }
    const minimumFinalLine = exactPaddingLine(256).length;
    while (targetBytes - written - recent.length > block.length + minimumFinalLine) {
      await file.write(block);
      written += block.length;
    }
    while (targetBytes - written - recent.length > template.length + minimumFinalLine) {
      await file.write(template);
      written += template.length;
    }
    const finalBytes = targetBytes - written - recent.length;
    const final = exactPaddingLine(finalBytes);
    await file.write(final);
    if (recent.length > 0) await file.write(recent);
  } finally {
    await file.close();
  }
  expect((await readFile(path)).byteLength).toBe(targetBytes);
}

function exactPaddingLine(bytes: number): Buffer {
  const empty = `${JSON.stringify({
    timestamp: now,
    level: "info",
    component: "observer",
    message: "",
  })}\n`;
  const overhead = Buffer.byteLength(empty);
  if (bytes < overhead) throw new Error(`Cannot fill ${bytes} bytes with a valid JSONL record.`);
  return Buffer.from(
    `${JSON.stringify({
      timestamp: now,
      level: "info",
      component: "observer",
      message: "x".repeat(bytes - overhead),
    })}\n`,
  );
}

async function benchmarkReaders(paths: readonly string[]) {
  const legacy = async () => legacySearch(paths, "PERF_RECENT_FAILURE");
  const current = async () => boundedSearch(paths, "PERF_RECENT_FAILURE");
  await legacy();
  await current();
  const legacySamples: number[] = [];
  const newSamples: number[] = [];
  let legacyRecords: LogRecord[] = [];
  let newResult = { records: [] as LogRecord[], bytesRead: 0 };
  const iterations = timed ? 7 : 1;
  for (let index = 0; index < iterations; index += 1) {
    if (index % 2 === 0) {
      ({ value: legacyRecords, elapsed: legacySamples[index] } = await timedCall(legacy));
      ({ value: newResult, elapsed: newSamples[index] } = await timedCall(current));
    } else {
      ({ value: newResult, elapsed: newSamples[index] } = await timedCall(current));
      ({ value: legacyRecords, elapsed: legacySamples[index] } = await timedCall(legacy));
    }
  }
  return {
    legacyRecords,
    newRecords: newResult.records,
    bytesRead: newResult.bytesRead,
    legacySamples,
    newSamples,
  };
}

async function timedCall<T>(run: () => Promise<T>): Promise<{ value: T; elapsed: number }> {
  const started = performance.now();
  const value = await run();
  return { value, elapsed: performance.now() - started };
}

async function boundedSearch(paths: readonly string[], query: string) {
  const searches = await Promise.all(
    paths.map((path) =>
      readJsonlReverse(path, LogRecordSchema, {
        maxBytes: maxSearchBytes,
        maxRecords: 5,
        matches: (record) => JSON.stringify(record).includes(query),
      }),
    ),
  );
  const results = searches.flatMap((result) => result.records);
  return {
    records: results
      .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp))
      .slice(-5),
    bytesRead: searches.reduce((total, result) => total + result.bytesRead, 0),
  };
}

async function legacySearch(paths: readonly string[], query: string): Promise<LogRecord[]> {
  const records: LogRecord[] = [];
  for (const path of paths) {
    const source = await readFile(path, "utf8");
    for (const line of source.split("\n")) {
      if (line.trim().length === 0) continue;
      const parsed = LogRecordSchema.safeParse(JSON.parse(line));
      if (parsed.success && JSON.stringify(parsed.data).includes(query)) records.push(parsed.data);
    }
  }
  return records
    .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp))
    .slice(-5);
}

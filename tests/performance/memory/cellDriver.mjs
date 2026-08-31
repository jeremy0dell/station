#!/usr/bin/env node
import { spawn } from "node:child_process";
import { once } from "node:events";
import { closeSync, createWriteStream, mkdirSync, openSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { createObserverClient } from "../../../packages/protocol/dist/index.js";
import { captureProcessEvidence, startProcessMetricSampler } from "./processEvidence.mjs";

const stationRequire = createRequire(new URL("../../../station/package.json", import.meta.url));

const ProcessSpecSchema = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()),
    cwd: z.string().min(1).refine(isAbsolute, "Expected an absolute process cwd."),
    env: z.record(z.string(), z.string()).optional(),
    tty: z.boolean().optional(),
    label: z.string().min(1),
  })
  .strict();

const CellManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    cellId: z.string().min(1),
    role: z.enum(["observer", "dashboard", "native", "host"]),
    configPath: z.string().min(1).refine(isAbsolute),
    socketPath: z.string().min(1).refine(isAbsolute),
    stateDir: z.string().min(1).refine(isAbsolute),
    schedulePath: z.string().min(1).refine(isAbsolute),
    evidenceDir: z.string().min(1).refine(isAbsolute),
    eventsPath: z.string().min(1).refine(isAbsolute),
    targetSamplePath: z.string().min(1).refine(isAbsolute),
    observerSamplePath: z.string().min(1).refine(isAbsolute).optional(),
    renderProfilePath: z.string().min(1).refine(isAbsolute).optional(),
    clearUserTiming: z.boolean().optional(),
    warmupMs: z.number().int().nonnegative(),
    cooldownMs: z.number().int().nonnegative(),
    timeScale: z.number().finite().positive(),
    target: ProcessSpecSchema,
    observer: ProcessSpecSchema.optional(),
    stalledSubscription: z.boolean().optional(),
  })
  .strict();

const BASE_ENV_KEYS = [
  "STATION_CONFIG_PATH",
  "STATION_OBSERVER_SOCKET_PATH",
  "STATION_HOST_SOCKET_PATH",
  "STATION_LAYOUT_PATH",
  "STATION_MEMORY_SAMPLE_PATH",
  "STATION_MEMORY_CLEAR_USER_TIMING",
  "STATION_RENDER_PROFILE_PATH",
  "STATION_PROFILE_TARGET",
  "STATION_PROFILE",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
];

/** Runs one fully isolated fixture cell and records bounded lifecycle/evidence metadata. */
export async function runProfileCell(rawManifest) {
  const manifest = CellManifestSchema.parse(rawManifest);
  const schedule = JSON.parse(await readFile(manifest.schedulePath, "utf8"));
  if (!Array.isArray(schedule) || schedule.length === 0) {
    throw new Error("Profile cell schedule must be a non-empty array.");
  }
  mkdirSync(manifest.evidenceDir, { recursive: true });
  mkdirSync(join(manifest.evidenceDir, "logs"), { recursive: true });
  const eventWriter = createWriteStream(manifest.eventsPath, { flags: "a" });
  const processes = [];
  const samplers = [];
  const metrics = {
    reports: 0,
    acceptedReports: 0,
    rejectedReports: 0,
    dedupedReports: 0,
    reconciles: 0,
    reconcileErrors: 0,
    terminalOutputBytes: 0,
  };
  let observerClient;
  let stalledIterator;
  const evidence = [];
  const startedAt = Date.now();

  try {
    if (manifest.observer !== undefined) {
      const observerProcess = await spawnProfileProcess(manifest.observer, manifest, "observer");
      processes.push(observerProcess);
      if (manifest.observerSamplePath !== undefined) {
        samplers.push(
          startProcessMetricSampler({
            pid: observerProcess.pid,
            path: manifest.observerSamplePath,
          }),
        );
      }
      observerClient = createObserverClient({ socketPath: manifest.socketPath });
      await waitForObserver(observerClient);
    }

    const targetProcess = await spawnProfileProcess(manifest.target, manifest, "target");
    processes.push(targetProcess);
    samplers.push(
      startProcessMetricSampler({ pid: targetProcess.pid, path: manifest.targetSamplePath }),
    );
    if (observerClient === undefined && manifest.role !== "host") {
      observerClient = createObserverClient({ socketPath: manifest.socketPath });
      await waitForObserver(observerClient);
    }
    await delay(manifest.warmupMs);
    if (observerClient !== undefined) {
      const snapshot = await observerClient.getSnapshot();
      const worktreeIdsByPath = new Map(snapshot.rows.map((row) => [row.path, row.id]));
      if (manifest.stalledSubscription === true) {
        const subscription = observerClient.subscribe();
        stalledIterator = subscription[Symbol.asyncIterator]();
        await Promise.race([stalledIterator.next(), delay(250)]);
      }
      await replaySchedule({
        client: observerClient,
        schedule,
        worktreeIdsByPath,
        timeScale: manifest.timeScale,
        metrics,
        writeEvent: (event) => writeEventRecord(eventWriter, event),
      });
    }
    await delay(manifest.cooldownMs);

    for (const process of processes) {
      evidence.push(
        await captureProcessEvidence({
          pid: process.pid,
          outputDir: manifest.evidenceDir,
          label: `${manifest.cellId}-${process.label}`,
        }),
      );
    }
  } finally {
    if (stalledIterator !== undefined) {
      await stalledIterator.return?.().catch(() => undefined);
    }
    if (manifest.observer !== undefined && observerClient !== undefined) {
      await Promise.race([observerClient.stop().catch(() => undefined), delay(3_000)]);
    }
    for (const process of processes.slice().reverse()) {
      await process.terminate();
    }
    await Promise.all(samplers.map((sampler) => sampler.flush().catch(() => undefined)));
    for (const sampler of samplers) sampler.dispose();
    eventWriter.end();
    await once(eventWriter, "close").catch(() => undefined);
  }

  const durationMs = Date.now() - startedAt;
  const durationSeconds = Math.max(durationMs, 1) / 1_000;
  const result = {
    schemaVersion: 1,
    cellId: manifest.cellId,
    role: manifest.role,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs,
    pids: processes.map((process) => ({ label: process.label, pid: process.pid })),
    metrics: {
      ...metrics,
      terminalOutputBytes: processes.reduce(
        (total, process) => total + (process.outputBytes ?? 0),
        0,
      ),
    },
    rates: {
      reportsPerSecond: metrics.reports / durationSeconds,
      reconcilesPerSecond: metrics.reconciles / durationSeconds,
    },
    evidence,
    targetSamplePath: manifest.targetSamplePath,
    ...(manifest.observerSamplePath === undefined
      ? {}
      : { observerSamplePath: manifest.observerSamplePath }),
    ...(manifest.renderProfilePath === undefined
      ? {}
      : { renderProfilePath: manifest.renderProfilePath }),
  };
  await writeFile(
    join(manifest.evidenceDir, "cell-result.json"),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  return result;
}

async function replaySchedule(input) {
  const firstAt = Date.parse(input.schedule[0].report.observedAt);
  if (!Number.isFinite(firstAt))
    throw new Error("Profile schedule starts with an invalid timestamp.");
  let currentBatch = -1;
  const startedReplayAt = Date.now();
  for (const entry of input.schedule) {
    const observedAt = Date.parse(entry.report.observedAt);
    const dueMs = Math.max(0, (observedAt - firstAt) * input.timeScale);
    await delayUntil(startedReplayAt, dueMs);
    const report = mapReportToSnapshot(entry.report, input.worktreeIdsByPath);
    const receipt = await input.client.reportHarnessEvent(report);
    input.metrics.reports += 1;
    if (receipt.status === "accepted") {
      input.metrics.acceptedReports += 1;
      if (receipt.deduped === true) input.metrics.dedupedReports += 1;
    } else {
      input.metrics.rejectedReports += 1;
    }
    input.writeEvent({
      event: "report",
      reportId: report.reportId,
      batch: entry.batch,
      receiptStatus: receipt.status,
      deduped: receipt.deduped === true,
      at: new Date().toISOString(),
    });
    if (entry.batch !== currentBatch) {
      if (currentBatch !== -1) {
        await reconcileBatch(input, currentBatch);
      }
      currentBatch = entry.batch;
    }
  }
  if (currentBatch !== -1) await reconcileBatch(input, currentBatch);
}

async function reconcileBatch(input, batch) {
  try {
    const receipt = await input.client.reconcile(`memory-profile:batch-${batch}`);
    input.metrics.reconciles += 1;
    input.writeEvent({
      event: "reconcile",
      batch,
      rows: receipt.snapshot.rows.length,
      at: new Date().toISOString(),
    });
  } catch (error) {
    input.metrics.reconcileErrors += 1;
    input.writeEvent({
      event: "reconcile-error",
      batch,
      message: error instanceof Error ? error.message : String(error),
      at: new Date().toISOString(),
    });
  }
}

function mapReportToSnapshot(report, worktreeIdsByPath) {
  const correlation = report.correlation;
  if (correlation?.cwd === undefined) return report;
  const worktreeId = worktreeIdsByPath.get(correlation.cwd);
  if (worktreeId === undefined) {
    throw new Error(`Profile report cwd is absent from the initial snapshot: ${correlation.cwd}`);
  }
  const { sessionId: _sessionId, ...withoutSession } = correlation;
  return {
    ...report,
    correlation: {
      ...withoutSession,
      worktreeId,
    },
  };
}

async function spawnProfileProcess(spec, manifest, label) {
  const env = isolatedEnvironment(spec.env, manifest, label);
  const logPath = join(manifest.evidenceDir, "logs", `${manifest.cellId}-${label}.log`);
  mkdirSync(join(manifest.evidenceDir, "logs"), { recursive: true });
  if (spec.tty === true) {
    let pty;
    try {
      pty = stationRequire("node-pty");
    } catch (error) {
      throw new Error("TTY profile cells require the installed node-pty dependency.", {
        cause: error,
      });
    }
    const child = pty.spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env,
      name: "xterm-256color",
      cols: 160,
      rows: 48,
    });
    const exited = new Promise((resolve) => child.onExit(resolve));
    let outputBytes = 0;
    const stream = createWriteStream(logPath, { flags: "a" });
    const dataSubscription = child.onData((data) => {
      outputBytes += Buffer.byteLength(data);
      if (outputBytes <= 4096) stream.write(`[terminal output ${outputBytes} bytes]\n`);
    });
    return {
      pid: child.pid,
      label: spec.label,
      get outputBytes() {
        return outputBytes;
      },
      async terminate() {
        dataSubscription?.dispose?.();
        stream.end();
        try {
          child.kill("SIGTERM");
        } catch {
          // The owner will still verify and reap the process group.
        }
        await Promise.race([exited, delay(3_000)]);
      },
    };
  }

  const stdout = openSync(logPath, "a");
  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env,
    stdio: ["ignore", stdout, stdout],
  });
  if (child.pid === undefined) {
    closeSync(stdout);
    throw new Error(`Could not obtain ${label} profile process identity.`);
  }
  return {
    pid: child.pid,
    label: spec.label,
    async terminate() {
      if (!child.killed) child.kill("SIGTERM");
      await Promise.race([once(child, "exit"), delay(3_000)]);
      closeSync(stdout);
    },
  };
}

function isolatedEnvironment(overrides, manifest, label) {
  const env = { ...process.env };
  for (const key of BASE_ENV_KEYS) delete env[key];
  env.STATION_CONFIG_PATH = manifest.configPath;
  env.STATION_OBSERVER_SOCKET_PATH = manifest.socketPath;
  env.STATION_HOST_SOCKET_PATH = join(manifest.stateDir, "run", "station-host.sock");
  env.STATION_LAYOUT_PATH = join(manifest.stateDir, "layout.json");
  if (manifest.clearUserTiming === true) {
    env.STATION_MEMORY_CLEAR_USER_TIMING = "1";
  }
  if (label === "target") {
    env.STATION_MEMORY_SAMPLE_PATH = manifest.targetSamplePath;
    if (manifest.renderProfilePath !== undefined) {
      env.STATION_RENDER_PROFILE_PATH = manifest.renderProfilePath;
      env.STATION_PROFILE = "1";
    }
  } else if (manifest.observerSamplePath !== undefined) {
    env.STATION_MEMORY_SAMPLE_PATH = manifest.observerSamplePath;
  }
  Object.assign(env, overrides ?? {});
  return env;
}

async function waitForObserver(client) {
  const deadline = Date.now() + 20_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const health = await client.health();
      if (health.status === "healthy" || health.status === "degraded") return health;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(
    `Profile Observer did not become ready: ${lastError instanceof Error ? lastError.message : "timeout"}`,
  );
}

function writeEventRecord(stream, record) {
  stream.write(`${JSON.stringify({ schemaVersion: 1, ...record })}\n`);
}

function delayUntil(startedAt, dueMs) {
  const remaining = startedAt + dueMs - Date.now();
  return remaining > 0 ? delay(remaining) : Promise.resolve();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseManifestArg(argv) {
  if (argv.length !== 2 || argv[0] !== "--manifest" || !isAbsolute(argv[1])) {
    throw new Error("Usage: cellDriver.mjs --manifest <absolute-json-path>");
  }
  return argv[1];
}

if (import.meta.main) {
  try {
    const manifestPath = parseManifestArg(process.argv.slice(2));
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const result = await runProfileCell(manifest);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

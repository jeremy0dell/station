import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { z } from "zod";

const JscHeapStatsSchema = z
  .object({
    heapSize: z.number().finite().nonnegative().optional(),
    heapCapacity: z.number().finite().nonnegative().optional(),
    extraMemorySize: z.number().finite().nonnegative().optional(),
    objectCount: z.number().finite().nonnegative().optional(),
    protectedObjectCount: z.number().finite().nonnegative().optional(),
  })
  .strip();

/**
 * Starts opt-in process/JSC/User Timing sampling for one disposable profile run.
 * The returned owner must be disposed so its interval, signal listener, and file
 * session are closed before the profiled process exits.
 */
export async function startProcessSampler(options = {}) {
  const path = options.path ?? process.env.STATION_MEMORY_SAMPLE_PATH;
  if (typeof path !== "string" || !isAbsolute(path)) {
    throw new Error("Memory sampler requires an absolute output path.");
  }
  const intervalMs = options.intervalMs ?? 5_000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    throw new Error("Memory sampler interval must be a positive safe integer.");
  }
  const clearUserTiming =
    options.clearUserTiming ?? readBooleanFlag(process.env.STATION_MEMORY_CLEAR_USER_TIMING);

  mkdirSync(dirname(path), { recursive: true });
  const jsc = await loadJsc();
  const v8 = process.versions.bun === undefined ? await import("node:v8") : undefined;
  const startedAt = performance.now();
  let disposed = false;
  let sequence = 0;
  let sampling;

  appendLine(path, {
    schemaVersion: 1,
    event: "session-start",
    at: new Date().toISOString(),
    pid: process.pid,
    runtime: process.versions.bun === undefined ? "node" : "bun",
  });

  const snapshot = async (phase = "sample") => {
    if (disposed) return undefined;
    const record = {
      schemaVersion: 1,
      event: "sample",
      sequence: sequence++,
      phase,
      at: new Date().toISOString(),
      elapsedMs: Math.round(performance.now() - startedAt),
      pid: process.pid,
      memory: process.memoryUsage(),
      userTiming: userTimingCounts(),
    };
    if (clearUserTiming) record.userTimingCleared = true;
    if (jsc !== undefined) {
      const stats = readJscStats(jsc);
      if (stats !== undefined) record.jsc = stats;
    }
    if (v8 !== undefined) record.v8 = v8.getHeapStatistics();
    appendLine(path, record);
    if (clearUserTiming) {
      performance.clearMarks();
      performance.clearMeasures();
    }
    return record;
  };

  await snapshot("initial");
  sampling = setInterval(() => {
    void snapshot();
  }, intervalMs);

  const onSnapshotSignal = () => {
    void snapshot("signal");
  };
  const signalSnapshots =
    options.signalSnapshots ?? process.env.STATION_MEMORY_SAMPLER_SIGNALS === "1";
  if (signalSnapshots && process.platform !== "win32") {
    process.on("SIGUSR2", onSnapshotSignal);
  }

  return {
    snapshot,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      clearInterval(sampling);
      if (signalSnapshots && process.platform !== "win32") {
        process.off("SIGUSR2", onSnapshotSignal);
      }
      appendLine(path, {
        schemaVersion: 1,
        event: "session-end",
        at: new Date().toISOString(),
        pid: process.pid,
        samples: sequence,
      });
    },
  };
}

async function loadJsc() {
  if (process.versions.bun === undefined) return undefined;
  try {
    return await import("bun:jsc");
  } catch {
    return undefined;
  }
}

function readJscStats(jsc) {
  try {
    const parsed = JscHeapStatsSchema.safeParse(jsc.heapStats());
    if (!parsed.success) return undefined;
    const stats = {};
    for (const key of [
      "heapSize",
      "heapCapacity",
      "extraMemorySize",
      "objectCount",
      "protectedObjectCount",
    ]) {
      const value = parsed.data[key];
      if (value !== undefined) stats[key] = value;
    }
    return Object.keys(stats).length === 0 ? undefined : stats;
  } catch {
    return undefined;
  }
}

function userTimingCounts() {
  return {
    marks: performance.getEntriesByType("mark").length,
    measures: performance.getEntriesByType("measure").length,
  };
}

function readBooleanFlag(value) {
  if (value === undefined || value === "" || value === "0" || value === "false") return false;
  if (value === "1" || value === "true") return true;
  throw new Error(
    `Unsupported STATION_MEMORY_CLEAR_USER_TIMING=${value}. Expected "1"/"true" or "0"/"false".`,
  );
}

function appendLine(path, record) {
  appendFileSync(path, `${JSON.stringify(record)}\n`);
}

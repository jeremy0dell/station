import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import type { ProfilerOnRenderCallback } from "react";
import { z } from "zod";

const rendererStatsSchema = z
  .object({
    fps: z.number().finite().optional(),
    frameCount: z.number().int().nonnegative().optional(),
    avgFrameTime: z.number().finite().nonnegative().optional(),
    minFrameTime: z.number().finite().nonnegative().optional(),
    maxFrameTime: z.number().finite().nonnegative().optional(),
    frameTimes: z.array(z.number().finite().nonnegative()).max(4_096).optional(),
    nativeStats: z.record(z.string(), z.number().finite()).optional(),
  });

export type RenderProfilerSession = {
  onRender: ProfilerOnRenderCallback;
  sampleNow(): void;
  dispose(): void;
};

export type RenderStatsReader = {
  getStats(): unknown;
};

/**
 * A 1/0/true/false flag in the readShellAutoCloseOverlay style: opt in to writing
 * a React commit log. Unset/empty stays off (the default) — and when off, main.tsx
 * renders the tree bare, so the production render path is untouched.
 */
export function readRenderProfileEnabled(value: string | undefined): boolean {
  if (value === undefined || value === "" || value === "0" || value === "false") {
    return false;
  }
  if (value === "1" || value === "true") {
    return true;
  }
  throw new Error(
    `Unsupported STATION_PROFILE=${value}. Expected "1"/"true" or "0"/"false".`,
  );
}

/** Resolves an explicit absolute render-profile destination, preserving the caller's fallback. */
export function resolveRenderProfilePath(value: string | undefined, fallback: string): string {
  if (!isAbsolute(fallback)) {
    throw new Error(`Render profile fallback must be absolute: ${fallback}`);
  }
  if (value === undefined || value === "") {
    return fallback;
  }
  if (!isAbsolute(value)) {
    throw new Error(`STATION_RENDER_PROFILE_PATH must be absolute: ${value}`);
  }
  return value;
}

/**
 * Append one JSON record per React commit. Terminal content bypasses React, so
 * these structural commits are infrequent enough for sync writes.
 */
export function createRenderProfiler(path: string): ProfilerOnRenderCallback {
  mkdirSync(dirname(path), { recursive: true });
  appendLine(path, { event: "session-start", at: new Date().toISOString(), pid: process.pid });
  return (id, phase, actualDuration, baseDuration, _startTime, commitTime) => {
    appendLine(path, {
      event: "commit",
      id,
      phase,
      actualMs: round(actualDuration),
      baseMs: round(baseDuration),
      atMs: round(commitTime),
    });
  };
}

/**
 * Owns opt-in React commit and bounded OpenTUI statistics sampling for one renderer.
 * The interval is diagnostic-only and must be disposed with the renderer lifecycle.
 */
export function createRenderProfilerSession(
  path: string,
  renderer: RenderStatsReader,
  options: { sampleIntervalMs?: number } = {},
): RenderProfilerSession {
  const sampleIntervalMs = options.sampleIntervalMs ?? 5_000;
  if (!Number.isSafeInteger(sampleIntervalMs) || sampleIntervalMs < 0) {
    throw new Error("Render profiler sample interval must be a non-negative safe integer.");
  }
  const onRender = createRenderProfiler(path);
  let disposed = false;
  const interval =
    sampleIntervalMs > 0 ? setInterval(() => sampleNow(), sampleIntervalMs) : undefined;

  function sampleNow(): void {
    if (disposed) return;
    try {
      appendLine(path, {
        event: "renderer-sample",
        at: new Date().toISOString(),
        ...statsRecord(renderer.getStats()),
      });
    } catch (error) {
      appendLine(path, {
        event: "renderer-sample-error",
        at: new Date().toISOString(),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  sampleNow();
  return {
    onRender,
    sampleNow,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (interval !== undefined) clearInterval(interval);
      appendLine(path, { event: "session-end", at: new Date().toISOString(), pid: process.pid });
    },
  };
}

function statsRecord(value: unknown): Record<string, unknown> {
  const parsed = rendererStatsSchema.safeParse(value);
  if (!parsed.success) {
    return { stats: "unsupported" };
  }
  const { frameTimes, nativeStats, ...numeric } = parsed.data;
  const record: Record<string, unknown> = numeric;
  if (frameTimes !== undefined) {
    record.frameTimesCount = frameTimes.length;
    record.frameTimeSumMs = round(frameTimes.reduce((sum, value) => sum + value, 0));
  }
  if (nativeStats !== undefined) {
    record.nativeStats = nativeStats;
  }
  return record;
}

function appendLine(path: string, record: object): void {
  appendFileSync(path, `${JSON.stringify({ schemaVersion: 1, ...record })}\n`);
}

function round(ms: number): number {
  return Math.round(ms * 100) / 100;
}

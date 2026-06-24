import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ProfilerOnRenderCallback } from "react";

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

/**
 * Append one JSON record per React commit. Terminal content bypasses React, so
 * these structural commits are infrequent enough for sync writes.
 */
export function createRenderProfiler(path: string): ProfilerOnRenderCallback {
  mkdirSync(dirname(path), { recursive: true });
  appendLine(path, { event: "session-start", at: new Date().toISOString(), pid: process.pid });
  return (id, phase, actualDuration, baseDuration, _startTime, commitTime) => {
    appendLine(path, {
      id,
      phase,
      actualMs: round(actualDuration),
      baseMs: round(baseDuration),
      atMs: round(commitTime),
    });
  };
}

function appendLine(path: string, record: object): void {
  appendFileSync(path, `${JSON.stringify(record)}\n`);
}

function round(ms: number): number {
  return Math.round(ms * 100) / 100;
}

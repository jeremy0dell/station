import type { ChildProcess } from "node:child_process";
import type { StationConfig } from "@station/config";
import type { ObserverHealth, SafeError } from "@station/contracts";
import type { JsonlLogger } from "@station/observability";
import type { createObserverClient } from "@station/protocol";
import type { RuntimeClock } from "@station/runtime";
import type { ObserverPaths } from "../paths.js";

// Shared types keep the facade and leaf modules connected without introducing runtime import cycles.
export type ObserverStatus =
  | {
      status: "running";
      paths: ObserverPaths;
      health: ObserverHealth;
    }
  | {
      status: "stopped" | "stale" | "unhealthy";
      paths: ObserverPaths;
      error?: SafeError;
    };

export type ObserverProcessDeps = {
  clientFactory?: (socketPath: string) => ReturnType<typeof createObserverClient>;
  spawnObserver?: (input: SpawnObserverInput) => ChildProcessLike | Promise<ChildProcessLike>;
  clock?: RuntimeClock;
  sleep?: (ms: number) => Promise<void>;
  logger?: JsonlLogger;
};

export type SpawnObserverInput = {
  paths: ObserverPaths;
  configPath?: string;
};

export type ChildProcessExit = {
  type: "exit";
  code: number | null;
  signal: NodeJS.Signals | null;
};

export type ChildProcessSpawnError = {
  type: "spawn_error";
  error: Error;
};

export type ChildExitResult = ChildProcessExit | ChildProcessSpawnError;

export type ChildProcessLike = Pick<ChildProcess, "pid" | "unref"> & {
  kill?: ChildProcess["kill"];
  exited?: Promise<ChildExitResult>;
  disposeExitWait?: () => void;
  readBootLogTail?: () => Promise<string | undefined>;
  disposeBootLog?: () => Promise<void>;
};

export type ObserverProcessOptions = {
  config?: StationConfig;
  configPath?: string;
  paths?: ObserverPaths;
  timeoutMs?: number;
  onStartupProgress?: (message: string) => void;
};

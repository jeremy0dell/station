import type { ChildProcess } from "node:child_process";
import type { StationConfig } from "@station/config";
import type { ObserverHealth, SafeError } from "@station/contracts";
import type { JsonlLogger } from "@station/observability";
import type {
  CreateObserverClientOptions,
  createObserverClient,
  probeUnixSocket,
} from "@station/protocol";
import type { RuntimeClock } from "@station/runtime";
import type { ObserverPaths } from "../paths.js";
import type { ExecutableArgv } from "../selfExec.js";

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

export type ExactObserverActivationPhase = "inspection" | "stop" | "start" | "verification";

export type ExactObserverIncumbentDisposition = "none" | "preserved" | "stopped" | "unknown";

/**
 * Result of converging one configured socket to the caller's exact immutable build.
 * Failures identify the phase and the last proven state of the Observer present at admission.
 */
export type ExactObserverBuildStatus =
  | {
      status: "running";
      paths: ObserverPaths;
      health: ObserverHealth;
      lifecycle: "reused" | "started" | "replaced";
    }
  | {
      status: "unhealthy";
      paths: ObserverPaths;
      error: SafeError;
      phase: ExactObserverActivationPhase;
      incumbentDisposition: ExactObserverIncumbentDisposition;
    };

export type ObserverProcessDeps = {
  /** Requested Observer build selector; production defaults to this executable's immutable selector. */
  buildVersion?: string;
  clientFactory?: (
    socketPath: string,
    options?: Pick<
      CreateObserverClientOptions,
      "acceptPreviousLifecycleSchema" | "expectedObserverIdentity" | "timeoutMs"
    >,
  ) => ReturnType<typeof createObserverClient>;
  /** Test/composition seam for bounded Unix-socket ownership inspection. */
  probeSocket?: typeof probeUnixSocket;
  spawnObserver?: (input: SpawnObserverInput) => ChildProcessLike | Promise<ChildProcessLike>;
  clock?: RuntimeClock;
  sleep?: (ms: number) => Promise<void>;
  logger?: JsonlLogger;
};

export type SpawnObserverInput = {
  paths: ObserverPaths;
  configPath?: string;
  /** Finalized executable and fixed prefix arguments for the Observer child. */
  observerCommand?: ExecutableArgv;
  /** Preserve any listening incumbent instead of invoking generic automatic handoff. */
  incumbentPolicy?: "preserve";
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
  /** Absolute startup budget shared by callers that perform admission before spawning. */
  startupDeadlineMs?: number;
  observerCommand?: ExecutableArgv;
  onStartupProgress?: (message: string) => void;
};

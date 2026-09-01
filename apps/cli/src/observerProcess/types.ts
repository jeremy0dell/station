import type { ChildProcess } from "node:child_process";
import type { StationConfig } from "@station/config";
import type {
  ObserverHealth,
  ObserverStartupEvidence,
  ObserverStartupFailureReport,
  SafeError,
} from "@station/contracts";
import type { JsonlLogger } from "@station/observability";
import type {
  CreateObserverClientOptions,
  createObserverClient,
  probeUnixSocket,
} from "@station/protocol";
import type { RuntimeBoundaryResult, RuntimeClock } from "@station/runtime";
import type { ObserverPaths } from "../paths.js";
import type { ExecutableArgv } from "../selfExec.js";
import type { RepairLocalObserverEvidence } from "./evidenceRepair.js";

// Shared types keep the facade and leaf modules connected without introducing runtime import cycles.
export type ObserverStatus =
  | {
      status: "running";
      paths: ObserverPaths;
      health: ObserverHealth;
      /** The incumbent answered with the previous lifecycle schema during restart. */
      previousLifecycleSchema?: true;
      /** Render the restart result for a predecessor that only understands the previous schema. */
      restartResultSchema?: "0.11.0";
    }
  | {
      status: "stopped" | "stale" | "unhealthy";
      paths: ObserverPaths;
      error?: SafeError;
      /** Deepest typed child failure retained separately from the lifecycle classification. */
      cause?: SafeError;
      /** Bounded, redacted evidence from this startup attempt. */
      startupEvidence?: ObserverStartupEvidence;
    };

export type ExactObserverActivationPhase = "inspection" | "stop" | "start" | "verification";

export type ExactObserverIncumbentDisposition = "none" | "preserved" | "stopped" | "unknown";

/**
 * Named current-only result contract for converging one configured socket to the caller's exact build.
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
      /** Underlying typed lifecycle failure without changing the exact-activation code. */
      cause?: SafeError;
      /** Bounded, redacted evidence from the attempted successor startup. */
      startupEvidence?: ObserverStartupEvidence;
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
      | "acceptPreviousLifecycleSchema"
      | "expectedObserverIdentity"
      | "onPreviousLifecycleSchema"
      | "timeoutMs"
    >,
  ) => ReturnType<typeof createObserverClient>;
  /** Test/composition seam for bounded Unix-socket ownership inspection. */
  probeSocket?: typeof probeUnixSocket;
  spawnObserver?: (input: SpawnObserverInput) => ChildProcessLike | Promise<ChildProcessLike>;
  clock?: RuntimeClock;
  sleep?: (ms: number) => Promise<void>;
  logger?: JsonlLogger;
  /** Test/composition seam for claim-serialized stale lifecycle evidence repair. */
  repairStaleEvidence?: RepairLocalObserverEvidence;
};

export type SpawnObserverInput = {
  paths: ObserverPaths;
  /** Remaining absolute startup budget finalized immediately before child spawn. */
  startupTimeoutMs: number;
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
  /** Strict report fully consumed from the inherited pipe before exit resolution. */
  report?: ObserverStartupFailureReport;
};

export type ChildProcessSpawnError = {
  type: "spawn_error";
  error: Error;
  /** Strict report fully consumed from the inherited pipe before exit resolution. */
  report?: ObserverStartupFailureReport;
};

export type ChildExitResult = ChildProcessExit | ChildProcessSpawnError;

export type ChildProcessLike = Pick<ChildProcess, "pid" | "unref"> & {
  kill?: ChildProcess["kill"];
  exited?: Promise<ChildExitResult>;
  disposeExitWait?: () => void;
  disposeFailureReport?: () => void;
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

/** Timed child-start result with causal and bounded evidence kept outside the outer SafeError. */
export type ObserverStartupProcessResult = RuntimeBoundaryResult<ObserverHealth> & {
  cause?: SafeError;
  startupEvidence?: ObserverStartupEvidence;
};

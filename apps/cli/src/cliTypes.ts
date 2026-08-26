import type { LoadedStationConfig, ObserverPaths } from "@station/config";
import type {
  CliRunAuditMetadata,
  LogRecord,
  ProviderHookArtifactOwner,
  RetentionPolicy,
} from "@station/contracts";
import type {
  DurableCliInvocationAppendResult,
  PartialRetentionPolicy,
} from "@station/observability";
import type { HostCommandDeps } from "./commands/host/index.js";
import type { NotifyCommandDeps } from "./commands/notify.js";
import type { ObserveCommandDeps } from "./commands/observe/index.js";
import type { PopupCommandDeps } from "./commands/popup.js";
import type { SessionCommandDeps } from "./commands/session/options.js";
import type { SetupCommandDeps } from "./commands/setup/types.js";
import type { TuiCommandDeps } from "./commands/tui.js";
import type { UpdateCommandDeps } from "./commands/update.js";
import type { CliEnv } from "./env.js";
import type { ObserverProcessDeps } from "./observerProcess.js";

export type CliRunResult = {
  code: number;
  output?: unknown;
  outputFormat?: "json" | "text";
  audit?: CliRunAuditMetadata;
};

export type CliInvocationAuditDeps = {
  randomUUID?: () => string;
  clock?: { now(): Date };
  loadConfig?: (configPath?: string) => Promise<LoadedStationConfig>;
  resolveObserverPaths?: (config: LoadedStationConfig["config"] | undefined) => ObserverPaths;
  mergeRetentionPolicy?: (input?: PartialRetentionPolicy) => RetentionPolicy;
  appendRecord?: (options: {
    stateDir: string;
    policy: RetentionPolicy;
    record: LogRecord;
    now?: Date;
  }) => Promise<DurableCliInvocationAppendResult>;
  stdoutWrite?: (value: string) => void;
  stderrWrite?: (value: string) => void;
  exit?: (code: number) => void;
  setExitCode?: (code: number) => void;
};

export type CliRunOptions = {
  stdin?: string;
  env?: CliEnv;
  observerDeps?: ObserverProcessDeps;
  sessionDeps?: SessionCommandDeps;
  hostDeps?: HostCommandDeps;
  popupDeps?: PopupCommandDeps;
  tuiDeps?: TuiCommandDeps;
  notifyDeps?: NotifyCommandDeps;
  observeDeps?: ObserveCommandDeps;
  setupDeps?: SetupCommandDeps;
  updateDeps?: UpdateCommandDeps;
  invocationAuditDeps?: CliInvocationAuditDeps;
  providerHookIngressLauncher?: string;
  providerHookArtifactOwner?: ProviderHookArtifactOwner;
};

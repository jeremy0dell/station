import { spawn } from "node:child_process";
import type { StationConfig } from "@station/config";
import { TUI_STARTUP_RECONCILE_REASON } from "@station/contracts";
import { createObserverClient } from "@station/protocol";
import {
  isCompiledBinary,
  safeErrorFromUnknown,
  stationObserverBuildVersion,
  systemClock,
} from "@station/runtime";
import { dismissTmuxPopup, resolveTmuxPopupFocusTarget } from "@station/tmux";
import { parsePositiveIntegerOption } from "../args.js";
import type { CliEnv } from "../env.js";
import {
  logObserverLifecycleFailure,
  type ObserverProcessDeps,
  type ObserverStatus,
  startObserver,
} from "../observerProcess.js";
import { type ObserverPaths, resolveObserverPaths } from "../paths.js";
import { type SelfExecRuntime, selfExecArgv } from "../selfExec.js";
import {
  isStationUiInstalled,
  resolveStationWorkspaceDir,
  stationUiInstallHint,
} from "../stationWorkspace.js";
import { attachTuiRendererControl, type TuiRendererControlAdapters } from "./tuiRendererControl.js";

export type { TuiRendererControlAdapters } from "./tuiRendererControl.js";

/** The renderer subprocess exited with this code (the CLI's `tui` result). */
export type TuiRunResult = {
  status: "exited";
  code: number;
};

/** Which Bun entry the renderer child runs: the native workspace or the read-only dashboard. */
export type RendererEntry = "station" | "dashboard";

/** Inputs for the Bun renderer child: env merged over the CLI's own, plus which entry to run. */
export type RendererSpawnOptions = {
  env: Record<string, string>;
  entry: RendererEntry;
};

export type TuiCommandDeps = {
  observer?: ObserverProcessDeps;
  /** Supplies the caller selector once before Observer startup; tests can model build drift. */
  buildVersion?: () => string;
  spawnRenderer?: (options: RendererSpawnOptions) => Promise<TuiRunResult>;
  spawnProcess?: typeof spawn;
  stationUiInstalled?: () => Promise<boolean>;
  selfExecRuntime?: SelfExecRuntime;
  popupControl?: TuiRendererControlAdapters;
  env?: CliEnv;
};

export type TuiCommandOptions = {
  config?: StationConfig;
  configPath?: string;
  timeoutMs?: number;
};

export type TuiCommandResult =
  | TuiRunResult
  | {
      status: "unavailable";
      code: 1;
      paths: ObserverPaths;
      observer: ObserverStatus;
    };

/**
 * COMPOSITION ROOT
 *
 * Owns Observer startup, renderer process selection, and persistent popup control wiring.
 */
export async function runTuiCommand(
  args: string[],
  options: TuiCommandOptions = {},
  deps: TuiCommandDeps = {},
): Promise<TuiCommandResult> {
  const parsed = parseTuiArgs(args, options.timeoutMs);
  if (parsed.devFakeDashboard) {
    // The Bun renderer carries its own mock source; the --fake-* counts are
    // accepted for back-compat but the mock uses its baseline scenario.
    // --dev-fake-dashboard previews the read-only dashboard with mock data.
    return runRenderer(
      deps,
      buildRendererEnv(parsed, { STATION_SOURCE: "mock" }),
      "dashboard",
      parsed.persistentPopup,
      options.config?.terminal?.tmux?.command,
    );
  }

  const paths = resolveObserverPaths(options.config);
  const clientBuildVersion =
    deps.buildVersion?.() ?? deps.observer?.buildVersion ?? stationObserverBuildVersion();
  const observerDeps: ObserverProcessDeps = {
    ...deps.observer,
    buildVersion: clientBuildVersion,
  };
  const observer = await startObserver(
    {
      ...options,
      paths,
      onStartupProgress: (message) => process.stderr.write(`${message}\n`),
      ...(parsed.timeoutMs === undefined ? {} : { timeoutMs: parsed.timeoutMs }),
    },
    observerDeps,
  );
  if (observer.status !== "running") {
    return {
      status: "unavailable",
      code: 1,
      paths,
      observer,
    };
  }
  const observerBuildVersion = observer.health.version;
  if (observerBuildVersion === undefined) {
    throw new Error("The running Observer did not report a build version.");
  }

  const startupReconcile: {
    paths: ObserverPaths;
    expectedBuildVersion: string;
    deps?: ObserverProcessDeps;
    timeoutMs?: number;
  } = {
    paths: observer.paths,
    expectedBuildVersion: observerBuildVersion,
  };
  if (deps.observer !== undefined) {
    startupReconcile.deps = observerDeps;
  }
  if (parsed.timeoutMs !== undefined) {
    startupReconcile.timeoutMs = parsed.timeoutMs;
  }
  // Deferred and unawaited: the renderer resyncs from the observer's in-memory
  // snapshot immediately, and the observer.reconciled event from this reconcile
  // refreshes the live view when the scan lands.
  scheduleReconcileBeforeTui(startupReconcile);
  // Bare terminal launches the native Station workspace (its own panes); inside a
  // tmux popup we keep the read-only dashboard, since tmux owns the panes there.
  return runRenderer(
    deps,
    buildRendererEnv(parsed, {
      STATION_CLIENT_BUILD_VERSION: clientBuildVersion,
      STATION_OBSERVER_SOCKET_PATH: observer.paths.socketPath,
      STATION_OBSERVER_BUILD_VERSION: observerBuildVersion,
    }),
    parsed.popupMode ? "dashboard" : "station",
    parsed.persistentPopup,
    options.config?.terminal?.tmux?.command,
  );
}

// Transient popups inherit their startup focus origin; persistent popups resolve
// the current origin through the parent-owned control channel on every focus.
function buildRendererEnv(
  parsed: ParsedTuiArgs,
  base: Record<string, string>,
): Record<string, string> {
  const env = { ...base };
  if (parsed.popupMode) {
    env.STATION_TUI_POPUP = "1";
  }
  if (parsed.persistentPopup) {
    env.STATION_TUI_PERSISTENT = "1";
  }
  return env;
}

function runRenderer(
  deps: TuiCommandDeps,
  env: Record<string, string>,
  entry: RendererEntry,
  persistentPopup: boolean,
  popupCommand: string | undefined,
): Promise<TuiRunResult> {
  return (
    deps.spawnRenderer?.({ env, entry }) ??
    spawnRenderer({ env, entry }, deps, persistentPopup, popupCommand)
  );
}

async function spawnRenderer(
  { env, entry }: RendererSpawnOptions,
  deps: TuiCommandDeps,
  persistentPopup: boolean,
  popupCommand: string | undefined,
): Promise<TuiRunResult> {
  const childEnv = { ...process.env, ...env, STATION_QUIET_PRELAUNCH: "1" };
  const override = process.env.STATION_DASHBOARD_COMMAND;
  const compiled = deps.selfExecRuntime?.compiled ?? isCompiledBinary();
  // The installation preflight applies to the source Bun workspace, not a compiled self-exec.
  if (
    override === undefined &&
    !compiled &&
    !(await (deps.stationUiInstalled ?? isStationUiInstalled)())
  ) {
    process.stderr.write(`${stationUiInstallHint} Or run stn doctor.\n`);
    return { status: "exited", code: 1 };
  }
  if (override === undefined) {
    process.stderr.write(`Launching STATION ${entry === "dashboard" ? "dashboard" : "TUI"}…\n`);
  }
  const spawnProcess = deps.spawnProcess ?? spawn;
  const workspaceDir = resolveStationWorkspaceDir();
  const sourcePersistentDashboard =
    override === undefined && !compiled && persistentPopup && entry === "dashboard";
  if (sourcePersistentDashboard) {
    const linkResult = await runStationLink(spawnProcess, workspaceDir, childEnv);
    if (linkResult.code !== 0) return linkResult;
  }
  const developmentArgv = ["bun", "run", "--silent", "--cwd", workspaceDir, entry] as const;
  const rendererArgv = sourcePersistentDashboard
    ? (["bun", "src/dashboardRenderer/main.tsx"] as const)
    : selfExecArgv(
        entry === "dashboard" ? "dashboard" : "tui",
        developmentArgv,
        deps.selfExecRuntime,
      );
  const [command, ...args] = rendererArgv;
  const child =
    override !== undefined
      ? spawnProcess(override, {
          shell: true,
          stdio: persistentPopup ? ["inherit", "inherit", "inherit", "ipc"] : "inherit",
          env: childEnv,
        })
      : spawnProcess(command, args, {
          stdio: persistentPopup ? ["inherit", "inherit", "inherit", "ipc"] : "inherit",
          env: childEnv,
          ...(sourcePersistentDashboard ? { cwd: workspaceDir } : {}),
        });
  const control = persistentPopup
    ? attachTuiRendererControl(
        child,
        deps.popupControl ?? defaultPopupControl(deps.env, popupCommand),
      )
    : undefined;
  return new Promise<TuiRunResult>((resolve) => {
    child.once("error", () => {
      control?.dispose();
      resolve({ status: "exited", code: 1 });
    });
    child.once("exit", (code) => {
      control?.dispose();
      resolve({ status: "exited", code: code ?? 0 });
    });
  });
}

async function runStationLink(
  spawnProcess: typeof spawn,
  workspaceDir: string,
  env: NodeJS.ProcessEnv,
): Promise<TuiRunResult> {
  const child = spawnProcess("bun", ["run", "--silent", "--cwd", workspaceDir, "link:station"], {
    stdio: "inherit",
    env,
  });
  return new Promise<TuiRunResult>((resolve) => {
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      resolve({ status: "exited", code });
    };
    child.once("error", () => finish(1));
    child.once("exit", (code) => finish(code ?? 1));
  });
}

function defaultPopupControl(
  env: CliEnv | undefined,
  command: string | undefined,
): TuiRendererControlAdapters {
  const popupEnv = { ...(env ?? process.env) };
  // The startup client is a delivery hint; runtime requests must follow the current popup claim.
  delete popupEnv.STATION_FOCUS_CLIENT_ID;
  const popupOptions = {
    env: popupEnv,
    command: resolvePopupTmuxCommand(command, popupEnv),
  };
  return {
    dismissPopup: () => dismissTmuxPopup(popupOptions),
    resolveFocusTarget: () => resolveTmuxPopupFocusTarget(popupOptions),
  };
}

export function resolvePopupTmuxCommand(
  configuredCommand: string | undefined,
  env: CliEnv = process.env,
): string {
  return configuredCommand ?? env.STATION_TMUX_BIN ?? "tmux";
}

function scheduleReconcileBeforeTui(input: {
  paths: ObserverPaths;
  expectedBuildVersion: string;
  deps?: ObserverProcessDeps;
  timeoutMs?: number;
}): void {
  const timer = setTimeout(() => {
    // The renderer owns the terminal by the time a deferred reconcile can fail, so
    // the failure goes to cli.jsonl instead of stderr (which would corrupt the alt screen).
    void reconcileBeforeTui(input).catch((error) =>
      logObserverLifecycleFailure({
        paths: input.paths,
        operation: "tui.startup-reconcile",
        trace: {},
        error: safeErrorFromUnknown(error, {
          tag: "ReconcileCommandError",
          code: "RECONCILE_RPC_FAILED",
          message: "TUI startup reconcile could not contact the observer.",
        }),
        deps: input.deps ?? {},
        clock: systemClock,
      }),
    );
  }, 250);
  if (typeof timer === "object" && "unref" in timer && typeof timer.unref === "function") {
    timer.unref();
  }
}

async function reconcileBeforeTui(input: {
  paths: ObserverPaths;
  expectedBuildVersion: string;
  deps?: ObserverProcessDeps;
  timeoutMs?: number;
}): Promise<void> {
  const client =
    input.deps?.clientFactory?.(input.paths.socketPath) ??
    createObserverClient({
      socketPath: input.paths.socketPath,
      timeoutMs: input.timeoutMs ?? 30_000,
      expectedBuildVersion: input.expectedBuildVersion,
    });
  await client.reconcile(TUI_STARTUP_RECONCILE_REASON);
}

type ParsedTuiArgs = {
  devFakeDashboard: boolean;
  fakeProjects: number;
  fakeWorktreesPerProject: number;
  popupMode: boolean;
  persistentPopup: boolean;
  timeoutMs?: number;
};

function parseTuiArgs(args: string[], timeoutMs: number | undefined): ParsedTuiArgs {
  const parsed = takeTimeoutOption(args, timeoutMs);
  const fakeProjects = takePositiveIntegerFlag(parsed.args, "--fake-projects");
  const fakeWorktreesPerProject = takePositiveIntegerFlag(
    fakeProjects.args,
    "--fake-worktrees-per-project",
  );
  const remainingArgs = fakeWorktreesPerProject.args;
  const knownFlags = new Set(["--popup", "--persistent", "--dev-fake-dashboard"]);
  const unknown = remainingArgs.find((arg) => !knownFlags.has(arg));
  if (unknown !== undefined) {
    throw new Error(`Unknown tui option: ${unknown}`);
  }
  const devFakeDashboard = remainingArgs.includes("--dev-fake-dashboard");
  if (!devFakeDashboard && fakeProjects.value !== undefined) {
    throw new Error("--fake-projects requires --dev-fake-dashboard.");
  }
  if (!devFakeDashboard && fakeWorktreesPerProject.value !== undefined) {
    throw new Error("--fake-worktrees-per-project requires --dev-fake-dashboard.");
  }
  const popupMode = remainingArgs.includes("--popup");
  const persistentPopup = remainingArgs.includes("--persistent");
  if (persistentPopup && !popupMode) {
    throw new Error("--persistent requires --popup.");
  }

  const result: ParsedTuiArgs = {
    devFakeDashboard,
    fakeProjects: fakeProjects.value ?? 4,
    fakeWorktreesPerProject: fakeWorktreesPerProject.value ?? 24,
    popupMode,
    persistentPopup,
  };
  if (parsed.timeoutMs !== undefined) result.timeoutMs = parsed.timeoutMs;
  return result;
}

function takeTimeoutOption(
  args: string[],
  fallback: number | undefined,
): { args: string[]; timeoutMs?: number } {
  const index = args.indexOf("--timeout-ms");
  if (index === -1) {
    return fallback === undefined ? { args } : { args, timeoutMs: fallback };
  }
  const value = args[index + 1];
  if (value === undefined) {
    throw new Error("--timeout-ms requires a value.");
  }
  return {
    args: [...args.slice(0, index), ...args.slice(index + 2)],
    timeoutMs: parsePositiveIntegerOption(value, "--timeout-ms"),
  };
}

function takePositiveIntegerFlag(args: string[], flag: string): { args: string[]; value?: number } {
  const index = args.indexOf(flag);
  if (index === -1) {
    return { args };
  }
  const value = args[index + 1];
  if (value === undefined) {
    throw new Error(`${flag} requires a value.`);
  }
  return {
    args: [...args.slice(0, index), ...args.slice(index + 2)],
    value: parsePositiveIntegerOption(value, flag),
  };
}

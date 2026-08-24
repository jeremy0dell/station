import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:os";
import { dirname } from "node:path";
import type { StationConfig, TmuxConfig } from "@station/config";
import {
  TUI_STARTUP_RECONCILE_REASON,
  type UiRendererEntry,
  type UiRunId,
} from "@station/contracts";
import { componentLogPath, createJsonlLogger } from "@station/observability";
import { createObserverClient } from "@station/protocol";
import {
  isCompiledBinary,
  type RuntimeSafeError,
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
import { selectUpdateChannel, type UpdateChannelProbe } from "../update/channelDetection.js";
import { requireMatchingStationUiObserverBuild } from "./stationUiBuildAdmission.js";
import { attachTuiRendererControl, type TuiRendererControlAdapters } from "./tuiRendererControl.js";
import { createTuiRendererLifecycleWitness } from "./tuiRendererLifecycle.js";

export type { TuiRendererControlAdapters } from "./tuiRendererControl.js";

/** The renderer subprocess exited with this code (the CLI's `tui` result). */
export type TuiRunResult = {
  status: "exited";
  /** CLI process status; signal exits are never projected as success. */
  code: number;
  /** Exact renderer outcome retained when the production launcher owns the child. */
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
};

/** Inputs for the Bun renderer child: env merged over the CLI's own, plus which entry to run. */
export type RendererSpawnOptions = {
  env: Record<string, string>;
  entry: UiRendererEntry;
  /** Launcher-minted identity passed to the production renderer environment. */
  uiRunId: UiRunId;
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
  updateProbes?: readonly UpdateChannelProbe[];
  writeUpdateNotice?: (notice: string) => void;
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

const nestedTuiDisabledError = {
  tag: "TuiCommandError",
  code: "NESTED_TUI_DISABLED",
  message: "Nested Station is disabled.",
  hint: "Press Ctrl-O to open Station, or use `stn tui --allow-nested` for testing.",
} satisfies RuntimeSafeError;

/**
 * COMPOSITION ROOT
 *
 * Owns one launcher-minted UI run identity per renderer child, Observer startup and
 * exact-selector admission before renderer and reconcile effects, resolved-config
 * propagation, exact child outcome evidence, renderer selection, popup control wiring,
 * background read-only update planning, and post-cleanup normal-exit notices. Unfinished
 * discovery is aborted without joining renderer shutdown.
 */
export async function runTuiCommand(
  args: string[],
  options: TuiCommandOptions = {},
  deps: TuiCommandDeps = {},
): Promise<TuiCommandResult> {
  const parsed = parseTuiArgs(args, options.timeoutMs);
  const env = deps.env ?? process.env;
  const stationPaneMarker =
    env.TMUX !== undefined && env.TMUX_PANE !== undefined
      ? JSON.stringify([env.TMUX, env.TMUX_PANE])
      : "1";
  // Only the incoming launcher marker exempts popup mode; buildRendererEnv stamps the child later for routing.
  const popupLauncherChild = parsed.popupMode && env.STATION_TUI_POPUP === "1";
  if (
    env.STATION_PANE === stationPaneMarker &&
    !parsed.allowNested &&
    !parsed.devFakeDashboard &&
    !popupLauncherChild
  ) {
    throw nestedTuiDisabledError;
  }
  const paths = resolveObserverPaths(options.config);
  if (parsed.devFakeDashboard) {
    // The Bun renderer carries its own mock source; the --fake-* counts are
    // accepted for back-compat but the mock uses its baseline scenario.
    // --dev-fake-dashboard previews the observer-backed pane-free dashboard with mock data.
    return runRenderer(
      deps,
      buildRendererEnv(parsed, { STATION_SOURCE: "mock" }, options.configPath),
      "dashboard",
      parsed.persistentPopup,
      options.config?.terminal?.tmux,
      paths.stateDir,
    );
  }

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
  requireMatchingStationUiObserverBuild(clientBuildVersion, observerBuildVersion);

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
  // Bare terminal launches native Station with its own panes; a tmux popup uses the
  // observer-backed command-capable dashboard without native Station panes.
  const renderer = runRenderer(
    deps,
    buildRendererEnv(
      parsed,
      {
        STATION_CLIENT_BUILD_VERSION: clientBuildVersion,
        STATION_OBSERVER_SOCKET_PATH: observer.paths.socketPath,
        STATION_OBSERVER_BUILD_VERSION: observerBuildVersion,
      },
      options.configPath,
    ),
    parsed.popupMode ? "dashboard" : "station",
    parsed.persistentPopup,
    options.config?.terminal?.tmux,
    paths.stateDir,
  );
  if (parsed.popupMode || deps.updateProbes === undefined) {
    return renderer;
  }

  let targetVersion: string | undefined;
  const discoveryAbort = new AbortController();
  void selectUpdateChannel({
    probes: deps.updateProbes,
    options: { signal: discoveryAbort.signal },
  })
    .then(({ plan }) => {
      if (plan.status === "update-available" && plan.targetVersion !== plan.currentVersion) {
        targetVersion = plan.targetVersion;
      }
    })
    .catch(() => undefined);

  const result = await renderer;
  discoveryAbort.abort();
  if (result.code === 0 && result.signal == null && targetVersion !== undefined) {
    deps.writeUpdateNotice?.(`Station ${targetVersion} is available — run \`stn update\`\n`);
  }
  return result;
}

// Transient popups inherit their startup focus origin; persistent popups resolve
// the current origin through the parent-owned control channel on every focus.
function buildRendererEnv(
  parsed: ParsedTuiArgs,
  base: Record<string, string>,
  resolvedConfigPath: string | undefined,
): Record<string, string> {
  const env = { ...base };
  if (resolvedConfigPath !== undefined) {
    // The CLI-selected file is authoritative over any inherited renderer environment.
    env.STATION_CONFIG_PATH = resolvedConfigPath;
  }
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
  entry: UiRendererEntry,
  persistentPopup: boolean,
  popupConfig: TmuxConfig | undefined,
  stateDir: string,
): Promise<TuiRunResult> {
  const uiRunId = `ui_${randomUUID()}`;
  const spawnOptions: RendererSpawnOptions = { env, entry, uiRunId };
  return (
    deps.spawnRenderer?.(spawnOptions) ??
    spawnRenderer(spawnOptions, deps, persistentPopup, popupConfig, stateDir)
  );
}

async function spawnRenderer(
  { env, entry, uiRunId }: RendererSpawnOptions,
  deps: TuiCommandDeps,
  persistentPopup: boolean,
  popupConfig: TmuxConfig | undefined,
  stateDir: string,
): Promise<TuiRunResult> {
  const childEnv = {
    ...process.env,
    ...env,
    STATION_QUIET_PRELAUNCH: "1",
    STATION_UI_RUN_ID: uiRunId,
  };
  const lifecycleLogger = createJsonlLogger({
    component: "cli",
    path: componentLogPath(stateDir, "cli"),
  });
  const lifecycle = createTuiRendererLifecycleWitness({
    logger: lifecycleLogger,
    uiRunId,
    entry,
  });
  const recordSpawnFailure = async (error: RuntimeSafeError): Promise<void> => {
    await lifecycle.spawnFailed(error);
    await lifecycle.flush();
  };
  const override = process.env.STATION_DASHBOARD_COMMAND;
  const compiled = deps.selfExecRuntime?.compiled ?? isCompiledBinary();
  // The installation preflight applies to the source Bun workspace, not a compiled self-exec.
  if (
    override === undefined &&
    !compiled &&
    !(await (deps.stationUiInstalled ?? isStationUiInstalled)())
  ) {
    process.stderr.write(`${stationUiInstallHint} Or run stn doctor.\n`);
    await recordSpawnFailure({
      tag: "TuiCommandError",
      code: "TUI_RENDERER_NOT_INSTALLED",
      message: "The Station renderer dependencies are unavailable.",
    });
    return { status: "exited", code: 1 };
  }
  if (override === undefined) {
    process.stderr.write(`Launching STATION ${entry === "dashboard" ? "dashboard" : "TUI"}…\n`);
  }
  const spawnProcess = deps.spawnProcess ?? spawn;
  const workspaceDir = resolveStationWorkspaceDir();
  const popupRenderer = env.STATION_TUI_POPUP === "1";
  const sourcePersistentDashboard =
    override === undefined && !compiled && persistentPopup && entry === "dashboard";
  if (sourcePersistentDashboard) {
    const buildResult = await ensureStationBuild(spawnProcess, workspaceDir, childEnv);
    if (buildResult.code !== 0) {
      await recordSpawnFailure({
        tag: "TuiCommandError",
        code: "TUI_RENDERER_PRELAUNCH_FAILED",
        message: "The Station renderer prelaunch step failed.",
      });
      return buildResult;
    }
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
  let child: ReturnType<typeof spawnProcess>;
  try {
    child =
      override !== undefined
        ? spawnProcess(override, {
            shell: true,
            stdio: popupRenderer ? ["inherit", "inherit", "inherit", "ipc"] : "inherit",
            env: childEnv,
          })
        : spawnProcess(command, args, {
            stdio: popupRenderer ? ["inherit", "inherit", "inherit", "ipc"] : "inherit",
            env: childEnv,
            ...(sourcePersistentDashboard ? { cwd: workspaceDir } : {}),
          });
  } catch (error) {
    await recordSpawnFailure(
      safeErrorFromUnknown(error, {
        tag: "TuiCommandError",
        code: "TUI_RENDERER_SPAWN_FAILED",
        message: "The Station renderer could not be spawned.",
      }),
    );
    return { status: "exited", code: 1 };
  }
  const control = popupRenderer
    ? attachTuiRendererControl(
        child,
        deps.popupControl ?? defaultPopupControl(deps.env, popupConfig),
      )
    : undefined;
  return new Promise<TuiRunResult>((resolve) => {
    let settled = false;
    const rendererPid = child.pid;
    const spawned = rendererPid === undefined ? Promise.resolve() : lifecycle.spawned(rendererPid);
    const finish = async (result: TuiRunResult): Promise<void> => {
      if (settled) {
        return;
      }
      settled = true;
      control?.dispose();
      await lifecycle.flush();
      resolve(result);
    };
    child.once("error", (error) => {
      if (rendererPid !== undefined || settled) {
        return;
      }
      void (async () => {
        await recordSpawnFailure(
          safeErrorFromUnknown(error, {
            tag: "TuiCommandError",
            code: "TUI_RENDERER_SPAWN_FAILED",
            message: "The Station renderer could not be spawned.",
          }),
        );
        await finish({ status: "exited", code: 1 });
      })();
    });
    child.once("exit", (exitCode, signal) => {
      if (rendererPid === undefined || settled) {
        return;
      }
      void (async () => {
        await spawned;
        await lifecycle.exited({
          rendererPid,
          exitCode,
          signal,
        });
        const result: TuiRunResult = {
          status: "exited",
          code: rendererProcessCode(exitCode, signal),
        };
        if (exitCode === null) {
          result.exitCode = null;
        }
        if (signal !== null) {
          result.signal = signal;
        }
        await finish(result);
      })();
    });
  });
}

function rendererProcessCode(exitCode: number | null, signal: NodeJS.Signals | null): number {
  if (exitCode !== null) {
    return exitCode;
  }
  if (signal === null) {
    return 1;
  }
  const signalNumber = constants.signals[signal];
  return signalNumber === undefined ? 1 : 128 + signalNumber;
}

async function ensureStationBuild(
  spawnProcess: typeof spawn,
  workspaceDir: string,
  env: NodeJS.ProcessEnv,
): Promise<TuiRunResult> {
  const child = spawnProcess(
    "bun",
    ["run", "--silent", "--cwd", dirname(workspaceDir), "build:ensure"],
    { stdio: "inherit", env },
  );
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
  config: TmuxConfig | undefined,
): TuiRendererControlAdapters {
  const popupEnv = { ...(env ?? process.env) };
  if ((config?.popupScope ?? "server") === "server") {
    // A server-scoped renderer follows the current claim rather than its startup client.
    delete popupEnv.STATION_FOCUS_CLIENT_ID;
  }
  const popupOptions = {
    env: popupEnv,
    command: resolvePopupTmuxCommand(config?.command, popupEnv),
    ...(config === undefined ? {} : { config }),
  };
  return {
    dismissPopup: () => dismissTmuxPopup(popupOptions),
    openShell: async (cwd) => {
      const target = await resolveTmuxPopupFocusTarget(popupOptions);
      if (target === undefined) return { opened: false };
      const shell = await target.openShell(cwd);
      if (!shell.opened) return shell;
      const dismissed = await target.dismissExact();
      return { opened: dismissed.dismissed };
    },
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
  allowNested: boolean;
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
  const knownFlags = new Set(["--allow-nested", "--popup", "--persistent", "--dev-fake-dashboard"]);
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
    allowNested: remainingArgs.includes("--allow-nested"),
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

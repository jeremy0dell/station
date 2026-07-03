import { spawn } from "node:child_process";
import type { StationConfig } from "@station/config";
import { createObserverClient } from "@station/protocol";
import { parsePositiveIntegerOption } from "../args.js";
import type { CliEnv } from "../env.js";
import {
  type ObserverProcessDeps,
  type ObserverStatus,
  startObserver,
} from "../observerProcess.js";
import { type ObserverPaths, resolveObserverPaths } from "../paths.js";
import {
  isStationUiInstalled,
  resolveStationWorkspaceDir,
  stationUiInstallHint,
} from "../stationWorkspace.js";

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
  spawnRenderer?: (options: RendererSpawnOptions) => Promise<TuiRunResult>;
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
    return runRenderer(deps, buildRendererEnv(parsed, { STATION_SOURCE: "mock" }), "dashboard");
  }

  const paths = resolveObserverPaths(options.config);
  const observer = await startObserver(
    {
      ...options,
      paths,
      ...(parsed.timeoutMs === undefined ? {} : { timeoutMs: parsed.timeoutMs }),
    },
    deps.observer,
  );
  if (observer.status !== "running") {
    return {
      status: "unavailable",
      code: 1,
      paths,
      observer,
    };
  }

  const startupReconcile: {
    paths: ObserverPaths;
    deps?: ObserverProcessDeps;
    timeoutMs?: number;
  } = {
    paths: observer.paths,
  };
  if (deps.observer !== undefined) {
    startupReconcile.deps = deps.observer;
  }
  if (parsed.timeoutMs !== undefined) {
    startupReconcile.timeoutMs = parsed.timeoutMs;
  }
  if (parsed.popupMode) {
    scheduleReconcileBeforeTui(startupReconcile);
  } else {
    await reconcileBeforeTui(startupReconcile);
  }
  // Bare terminal launches the native Station workspace (its own panes); inside a
  // tmux popup we keep the read-only dashboard, since tmux owns the panes there.
  return runRenderer(
    deps,
    buildRendererEnv(parsed, { STATION_OBSERVER_SOCKET_PATH: observer.paths.socketPath }),
    parsed.popupMode ? "dashboard" : "station",
  );
}

// Popup mode is signalled to the renderer via env. Any tmux focus origin
// (STATION_FOCUS_PROVIDER / STATION_FOCUS_CLIENT_ID set by the tmux popup launcher) is
// inherited through process.env; the tmux provider resolves the originating
// client itself, so this command stays provider-agnostic.
function buildRendererEnv(
  parsed: ParsedTuiArgs,
  base: Record<string, string>,
): Record<string, string> {
  const env = { ...base };
  if (parsed.popupMode) {
    env.STATION_TUI_POPUP = "1";
  }
  return env;
}

function runRenderer(
  deps: TuiCommandDeps,
  env: Record<string, string>,
  entry: RendererEntry,
): Promise<TuiRunResult> {
  return (deps.spawnRenderer ?? spawnRenderer)({ env, entry });
}

async function spawnRenderer({ env, entry }: RendererSpawnOptions): Promise<TuiRunResult> {
  const childEnv = { ...process.env, ...env, STATION_QUIET_PRELAUNCH: "1" };
  const override = process.env.STATION_DASHBOARD_COMMAND;
  // Bare stn shells into `bun run` against the station/ lane; if it was never
  // bun-installed the child dies with a raw "@opentui not found", so pre-flight the
  // lane and surface the same remediation doctor gives (STATION_UI_NOT_INSTALLED).
  if (override === undefined && !(await isStationUiInstalled())) {
    process.stderr.write(`${stationUiInstallHint} Or run stn doctor.\n`);
    return { status: "exited", code: 1 };
  }
  if (override === undefined) {
    process.stderr.write(`Launching STATION ${entry === "dashboard" ? "dashboard" : "TUI"}…\n`);
  }
  const child =
    override !== undefined
      ? spawn(override, { shell: true, stdio: "inherit", env: childEnv })
      : spawn("bun", ["run", "--silent", "--cwd", resolveStationWorkspaceDir(), entry], {
          stdio: "inherit",
          env: childEnv,
        });
  return new Promise<TuiRunResult>((resolve) => {
    child.once("error", () => resolve({ status: "exited", code: 1 }));
    child.once("exit", (code) => resolve({ status: "exited", code: code ?? 0 }));
  });
}

function scheduleReconcileBeforeTui(input: {
  paths: ObserverPaths;
  deps?: ObserverProcessDeps;
  timeoutMs?: number;
}): void {
  const timer = setTimeout(() => {
    void reconcileBeforeTui(input).catch(() => undefined);
  }, 250);
  if (typeof timer === "object" && "unref" in timer && typeof timer.unref === "function") {
    timer.unref();
  }
}

async function reconcileBeforeTui(input: {
  paths: ObserverPaths;
  deps?: ObserverProcessDeps;
  timeoutMs?: number;
}): Promise<void> {
  const client =
    input.deps?.clientFactory?.(input.paths.socketPath) ??
    createObserverClient({
      socketPath: input.paths.socketPath,
      timeoutMs: input.timeoutMs ?? 30_000,
    });
  await client.reconcile("tui-startup");
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

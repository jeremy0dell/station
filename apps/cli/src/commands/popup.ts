import type { StationConfig } from "@station/config";
import {
  POPUP_OPEN_RECONCILE_REASON,
  type TerminalPopupLauncher,
  type TerminalPopupResult,
} from "@station/contracts";
import { createObserverClient } from "@station/protocol";
import { stationObserverBuildVersion } from "@station/runtime";
import type { CliEnv } from "../env.js";
import {
  type ObserverProcessDeps,
  type ObserverStatus,
  startObserver,
} from "../observerProcess.js";
import { type ObserverPaths, resolveObserverPaths } from "../paths.js";
import { requireMatchingStationUiObserverBuild } from "./stationUiBuildAdmission.js";

export type PopupCommandDeps = {
  observer?: ObserverProcessDeps;
  env?: CliEnv;
  popup?: TerminalPopupLauncher;
};

export type PopupCommandOptions = {
  config?: StationConfig;
  configPath?: string;
  timeoutMs?: number;
  observer?: ObserverProcessDeps;
};

export type PopupCommandUnavailableResult = {
  status: "unavailable";
  code: 1;
  paths: ObserverPaths;
  observer: ObserverStatus;
};

/**
 * COMPOSITION ROOT
 *
 * Owns Observer startup, exact-selector UI admission, and popup reconcile before
 * invoking the selected terminal popup capability.
 */
export async function runPopupCommand(
  args: string[],
  options: PopupCommandOptions,
  deps: PopupCommandDeps & { popup: TerminalPopupLauncher },
): Promise<TerminalPopupResult | PopupCommandUnavailableResult> {
  if (args.length > 0) {
    throw new Error(`Unknown popup option: ${args[0] ?? ""}`);
  }

  const observer = await prepareObserverForPopup(options, options.observer ?? deps.observer);
  if (observer !== undefined) {
    return observer;
  }
  return deps.popup.open();
}

async function prepareObserverForPopup(
  options: Pick<PopupCommandOptions, "config" | "configPath" | "timeoutMs">,
  deps: ObserverProcessDeps = {},
): Promise<PopupCommandUnavailableResult | undefined> {
  if (options.config === undefined) {
    return undefined;
  }
  const paths = resolveObserverPaths(options.config);
  const clientBuildVersion = deps.buildVersion ?? stationObserverBuildVersion();
  const observerDeps: ObserverProcessDeps = {
    ...deps,
    buildVersion: clientBuildVersion,
  };
  const observer = await startObserver(
    {
      config: options.config,
      paths,
      onStartupProgress: (message) => process.stderr.write(`${message}\n`),
      ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
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

  const client =
    observerDeps.clientFactory?.(observer.paths.socketPath) ??
    createObserverClient({
      socketPath: observer.paths.socketPath,
      timeoutMs: options.timeoutMs ?? 30_000,
      expectedBuildVersion: observerBuildVersion,
    });
  void client.reconcile(POPUP_OPEN_RECONCILE_REASON).catch(() => undefined);
  return undefined;
}

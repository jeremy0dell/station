import type { StationConfig } from "@station/config";
import { POPUP_OPEN_RECONCILE_REASON } from "@station/contracts";
import { createObserverClient } from "@station/protocol";
import { openTmuxPopup, type TmuxPopupOptions, type TmuxPopupResult } from "@station/tmux";
import {
  type ObserverProcessDeps,
  type ObserverStatus,
  startObserver,
} from "../observerProcess.js";
import { type ObserverPaths, resolveObserverPaths } from "../paths.js";

export type PopupCommandDeps = Partial<
  Pick<
    TmuxPopupOptions,
    | "checkoutRoot"
    | "enterWorkbench"
    | "env"
    | "preferRegisteredDevPopup"
    | "registeredDevPopupRoot"
    | "runner"
    | "tuiCommand"
    | "uiSessionName"
  >
> & {
  observer?: ObserverProcessDeps;
  openTmuxPopup?: (options: TmuxPopupOptions) => Promise<TmuxPopupResult>;
};

export type PopupCommandOptions = {
  config?: StationConfig;
  configPath?: string;
  firstRun?: boolean;
  checkoutRoot?: TmuxPopupOptions["checkoutRoot"];
  timeoutMs?: number;
  runner?: TmuxPopupOptions["runner"];
  enterWorkbench?: TmuxPopupOptions["enterWorkbench"];
  env?: TmuxPopupOptions["env"];
  observer?: ObserverProcessDeps;
  preferRegisteredDevPopup?: TmuxPopupOptions["preferRegisteredDevPopup"];
  registeredDevPopupRoot?: TmuxPopupOptions["registeredDevPopupRoot"];
  tuiCommand?: TmuxPopupOptions["tuiCommand"];
  uiSessionName?: TmuxPopupOptions["uiSessionName"];
};

export type PopupCommandUnavailableResult = {
  status: "unavailable";
  code: 1;
  paths: ObserverPaths;
  observer: ObserverStatus;
};

export async function runPopupCommand(
  args: string[],
  options: PopupCommandOptions = {},
  deps: PopupCommandDeps = {},
): Promise<TmuxPopupResult | PopupCommandUnavailableResult> {
  if (args.length > 0) {
    throw new Error(`Unknown popup option: ${args[0] ?? ""}`);
  }

  const hasFirstRunConfig = options.firstRun === true && options.config?.projects.length === 0;
  // A config-less launch has no project terminal to validate; the popup route itself selects tmux.
  if (
    !hasFirstRunConfig &&
    options.config?.defaults.terminal !== undefined &&
    options.config.defaults.terminal !== "tmux"
  ) {
    throw new Error(`Popup is only implemented for tmux, not ${options.config.defaults.terminal}.`);
  }

  const runner = options.runner ?? deps.runner;
  const checkoutRoot = options.checkoutRoot ?? deps.checkoutRoot;
  const enterWorkbench = options.enterWorkbench ?? deps.enterWorkbench ?? false;
  const env = options.env ?? deps.env;
  const preferRegisteredDevPopup =
    options.preferRegisteredDevPopup ?? deps.preferRegisteredDevPopup;
  const registeredDevPopupRoot = options.registeredDevPopupRoot ?? deps.registeredDevPopupRoot;
  const tuiCommand = options.tuiCommand ?? deps.tuiCommand;
  const uiSessionName = options.uiSessionName ?? deps.uiSessionName;
  const observer = await prepareObserverForPopup(options, options.observer ?? deps.observer);
  if (observer !== undefined) {
    return observer;
  }
  const openPopup = deps.openTmuxPopup ?? openTmuxPopup;
  return openPopup({
    ...(options.config?.terminal?.tmux === undefined
      ? {}
      : { config: options.config.terminal.tmux }),
    enterWorkbench,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(checkoutRoot === undefined ? {} : { checkoutRoot }),
    ...(env === undefined ? {} : { env }),
    ...(preferRegisteredDevPopup === undefined ? {} : { preferRegisteredDevPopup }),
    ...(registeredDevPopupRoot === undefined ? {} : { registeredDevPopupRoot }),
    ...(runner === undefined ? {} : { runner }),
    ...(tuiCommand === undefined ? {} : { tuiCommand }),
    ...(uiSessionName === undefined ? {} : { uiSessionName }),
  });
}

async function prepareObserverForPopup(
  options: Pick<PopupCommandOptions, "config" | "configPath" | "timeoutMs">,
  deps: ObserverProcessDeps = {},
): Promise<PopupCommandUnavailableResult | undefined> {
  if (options.config === undefined) {
    return undefined;
  }
  const paths = resolveObserverPaths(options.config);
  const observer = await startObserver(
    {
      config: options.config,
      paths,
      onStartupProgress: (message) => process.stderr.write(`${message}\n`),
      ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    },
    deps,
  );
  if (observer.status !== "running") {
    return {
      status: "unavailable",
      code: 1,
      paths,
      observer,
    };
  }

  const client =
    deps.clientFactory?.(observer.paths.socketPath) ??
    createObserverClient({
      socketPath: observer.paths.socketPath,
      timeoutMs: options.timeoutMs ?? 30_000,
      ...(observer.health.version === undefined
        ? {}
        : { expectedBuildVersion: observer.health.version }),
    });
  void client.reconcile(POPUP_OPEN_RECONCILE_REASON).catch(() => undefined);
  return undefined;
}

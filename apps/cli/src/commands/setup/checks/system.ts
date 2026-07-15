import { constants as fsConstants } from "node:fs";
import { access as nodeAccess } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { resolveObserverPaths } from "@station/config";
import { type ExternalCommandRunner, isCompiledBinary } from "@station/runtime";
import { buildManagedFastPopupRunShellCommand } from "@station/tmux";
import type { CliEnv } from "../../../env.js";
import { isStationUiInstalled } from "../../../stationWorkspace.js";
import type { SetupDependencyFact, SetupFacts, SetupMode, SetupStationUiFact } from "../model.js";
import { checkBrewDependency } from "./brew.js";
import { checkSetupBun } from "./bun.js";
import {
  type CheckSetupConfigOptions,
  checkSetupConfig,
  type SetupFileSystemReader,
  setupConfigPath,
} from "./config.js";
import { checkSetupDiffnav } from "./diffnav.js";
import { setupEnv } from "./env.js";
import { type CheckGitOptions, checkSetupGit } from "./git.js";
import { checkSetupGitDelta } from "./gitDelta.js";
import { type CheckHarnessesOptions, checkSetupHarnesses } from "./harnesses.js";
import { checkSetupLaunchers, setupLauncherExecutable } from "./launchers.js";
import { checkSetupStateDir, type SetupStateDirFileSystem } from "./stateDir.js";
import { checkSetupTmux } from "./tmux.js";
import { checkSetupTmuxBinding } from "./tmuxBinding.js";
import { checkSetupWorktrunk, checkSetupWorktrunkAutomation } from "./worktrunk.js";
import { type CheckXcodeOptions, checkSetupXcode } from "./xcode.js";

export type SetupDependencyCheckOptions = {
  runner?: ExternalCommandRunner;
  env?: CliEnv;
  access?: (path: string) => Promise<void>;
};

export type CollectSetupFactsOptions = {
  mode: SetupMode;
  configPath?: string;
  cwd?: string;
  homeDir?: string;
  env?: CliEnv;
  runner?: ExternalCommandRunner;
  access?: (path: string) => Promise<void>;
  fs?: SetupFileSystemReader;
  now?: () => Date;
  noBrew?: boolean;
  // Injectable so tests drive the station/ Bun-lane probe deterministically instead
  // of touching this checkout's real node_modules.
  stationUiInstalled?: () => Promise<boolean>;
  // Defaults to process.platform; injectable so machine-state tests can drive the
  // macOS Command Line Tools check on any host.
  platform?: NodeJS.Platform;
  compiled?: boolean;
  tmuxPopupOwnerRoot?: string;
  stateDirExecute?: (path: string) => Promise<void>;
  stateDirFs?: SetupStateDirFileSystem;
};

export async function collectSetupFacts(options: CollectSetupFactsOptions): Promise<SetupFacts> {
  const env = setupEnv(options.env);
  const cwd = options.cwd ?? process.cwd();
  const homeDir = options.homeDir ?? env.HOME ?? homedir();
  const generatedAt = (options.now ?? (() => new Date()))().toISOString();
  const compiled = options.compiled ?? isCompiledBinary();
  const commandInput: {
    runner?: ExternalCommandRunner;
    env: CliEnv;
    cwd: string;
    homeDir: string;
  } = { env, cwd, homeDir };
  if (options.runner !== undefined) commandInput.runner = options.runner;
  const commandOptions = commandCheckOptions(commandInput);
  const dependencyInput: {
    runner?: ExternalCommandRunner;
    env: CliEnv;
    access?: (path: string) => Promise<void>;
  } = { env };
  if (options.runner !== undefined) dependencyInput.runner = options.runner;
  if (options.access !== undefined) dependencyInput.access = options.access;
  const dependencyOptions = dependencyCheckOptions(dependencyInput);
  const git = await checkSetupGit(commandOptions);
  const gitRoot = git.status === "ok" ? git.root : undefined;
  const setupConfigInput: {
    options: CollectSetupFactsOptions;
    cwd: string;
    env: CliEnv;
    gitRoot?: string;
  } = { options, cwd, env };
  if (gitRoot !== undefined) setupConfigInput.gitRoot = gitRoot;
  const configPathOptions = setupConfigOptions(setupConfigInput);
  const configPath = setupConfigPath(configPathOptions);
  const xcodeOptions: CheckXcodeOptions = { ...commandOptions };
  if (options.platform !== undefined) xcodeOptions.platform = options.platform;
  const [worktrunk, tmux, bun, diffnav, gitDelta, brew, xcode, harnesses, config, launchers] =
    await Promise.all([
      checkSetupWorktrunk(dependencyOptions),
      checkSetupTmux(dependencyOptions),
      compiled
        ? Promise.resolve({ status: "ok" as const, command: "bun" })
        : checkSetupBun(dependencyOptions),
      checkSetupDiffnav(dependencyOptions),
      checkSetupGitDelta(dependencyOptions),
      checkBrewDependency({
        ...commandOptions,
        ...(options.noBrew === undefined ? {} : { noBrew: options.noBrew }),
      }),
      compiled
        ? Promise.resolve({ status: "ok" as const, applicable: false })
        : checkSetupXcode(xcodeOptions),
      checkSetupHarnesses(commandOptions),
      checkSetupConfig({ ...configPathOptions, configPath }),
      checkSetupLaunchers(dependencyOptions),
    ]);
  const worktrunkAutomation = await checkSetupWorktrunkAutomation({
    worktrunk,
    configReady: config.status === "valid",
    ...(config.status === "valid" && config.worktrunkUseLifecycleHooks !== undefined
      ? { useLifecycleHooks: config.worktrunkUseLifecycleHooks }
      : {}),
    ...(options.runner === undefined ? {} : { runner: options.runner }),
  });
  const launcherCommand =
    options.tmuxPopupOwnerRoot === undefined
      ? setupLauncherExecutable(launchers.tmuxPopup)
      : join(options.tmuxPopupOwnerRoot, "stn-tmux-popup");
  const resolvedLaunchers =
    options.tmuxPopupOwnerRoot === undefined
      ? launchers
      : {
          ...launchers,
          tmuxPopup: (await canExecute(launcherCommand, options.access))
            ? {
                status: "ok" as const,
                source: "installed" as const,
                command: launchers.tmuxPopup.command,
                resolvedPath: launcherCommand,
                checkoutPath: launchers.tmuxPopup.checkoutPath,
              }
            : {
                status: "missing" as const,
                source: "missing" as const,
                command: launchers.tmuxPopup.command,
                checkoutPath: launchers.tmuxPopup.checkoutPath,
                message: `The installed stn-tmux-popup alias is missing or not executable at ${launcherCommand}.`,
              },
        };
  const tmuxBindingOptions: Parameters<typeof checkSetupTmuxBinding>[0] = {
    homeDir,
    env,
    ...(options.fs === undefined ? {} : { fs: options.fs }),
    launcherCommand,
    ...(options.runner === undefined ? {} : { runner: options.runner }),
    tmuxCommand: tmux.resolvedPath ?? tmux.command,
  };
  const resolvedTmuxCommand =
    tmux.resolvedPath ?? (isAbsolute(tmux.command) ? tmux.command : undefined);
  if (options.tmuxPopupOwnerRoot !== undefined && resolvedTmuxCommand !== undefined) {
    tmuxBindingOptions.runShellCommand = buildManagedFastPopupRunShellCommand({
      installedRoot: options.tmuxPopupOwnerRoot,
      fallbackAlias: launcherCommand,
      tmuxCommand: resolvedTmuxCommand,
    });
  }
  const tmuxBinding = await checkSetupTmuxBinding(tmuxBindingOptions);
  const stationUi = compiled
    ? ({ status: "skipped" } as const)
    : await resolveStationUiFact({
        env,
        bunStatus: bun.status,
        uiInstalled: options.stationUiInstalled ?? isStationUiInstalled,
      });
  const stateDirPath =
    config.status === "valid"
      ? config.observerStateDir
      : resolveObserverPaths(undefined, homeDir).stateDir;
  const stateDir = await checkSetupStateDir({
    path: stateDirPath,
    executable: compiled,
    ...(options.stateDirExecute === undefined ? {} : { execute: options.stateDirExecute }),
    ...(options.stateDirFs === undefined ? {} : { fs: options.stateDirFs }),
  });

  return {
    generatedAt,
    mode: options.mode,
    configPath,
    homeDir,
    compiled,
    stateDir,
    worktrunk,
    worktrunkAutomation,
    tmux,
    bun,
    stationUi,
    diffnav,
    gitDelta,
    brew,
    xcode,
    launchers: resolvedLaunchers,
    git,
    harnesses,
    config,
    tmuxBinding,
  };
}

async function canExecute(
  path: string,
  injectedAccess: ((path: string) => Promise<void>) | undefined,
): Promise<boolean> {
  try {
    if (injectedAccess === undefined) {
      await nodeAccess(path, fsConstants.X_OK);
    } else {
      await injectedAccess(path);
    }
    return true;
  } catch {
    return false;
  }
}

// Mirrors doctor's rendererRuntimeCheck: the station/ Bun lane only matters when Bun
// runs the renderer, so a renderer override or a missing Bun (covered by its own
// required row) makes the lane irrelevant. Otherwise its install state is the signal.
async function resolveStationUiFact(input: {
  env: CliEnv;
  bunStatus: SetupDependencyFact["status"];
  uiInstalled: () => Promise<boolean>;
}): Promise<SetupStationUiFact> {
  if (input.env.STATION_DASHBOARD_COMMAND !== undefined) return { status: "skipped" };
  if (input.bunStatus !== "ok") return { status: "skipped" };
  return (await input.uiInstalled()) ? { status: "installed" } : { status: "missing" };
}

function setupConfigOptions(input: {
  options: CollectSetupFactsOptions;
  cwd: string;
  env: CliEnv;
  gitRoot?: string;
}): CheckSetupConfigOptions {
  const options: CheckSetupConfigOptions = {
    cwd: input.cwd,
    env: input.env,
  };
  if (input.options.configPath !== undefined) options.configPath = input.options.configPath;
  if (input.options.homeDir !== undefined) options.homeDir = input.options.homeDir;
  if (input.gitRoot !== undefined) options.gitRoot = input.gitRoot;
  if (input.options.fs !== undefined) options.fs = input.options.fs;
  return options;
}

function commandCheckOptions(input: {
  runner?: ExternalCommandRunner;
  env: CliEnv;
  cwd: string;
  homeDir?: string;
}): CheckGitOptions & CheckHarnessesOptions {
  const options: CheckGitOptions & CheckHarnessesOptions = {
    env: input.env,
    cwd: input.cwd,
  };
  if (input.runner !== undefined) options.runner = input.runner;
  if (input.homeDir !== undefined) options.homeDir = input.homeDir;
  return options;
}

function dependencyCheckOptions(input: {
  runner?: ExternalCommandRunner;
  env: CliEnv;
  access?: (path: string) => Promise<void>;
}): SetupDependencyCheckOptions {
  const options: SetupDependencyCheckOptions = {
    env: input.env,
  };
  if (input.runner !== undefined) options.runner = input.runner;
  if (input.access !== undefined) options.access = input.access;
  return options;
}

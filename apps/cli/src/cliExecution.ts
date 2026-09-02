import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type LoadedStationConfig, loadConfig } from "@station/config";
import { stationBuildInfo } from "@station/runtime";
import { captureNativeCallerClaims } from "@station/terminal";
import { captureTmuxCallerClaims } from "@station/tmux";
import { CliInputError, parseRequiredOptionValue } from "./args.js";
import type { CliRunOptions, CliRunResult } from "./cliTypes.js";
import {
  handleCliCommandConfigError,
  isTopLevelCliCommand,
  renderCliCommandHelpTopic,
  resolveCliCommandRoute,
  runCliCommandRoute,
} from "./commandRegistry.js";
import type { CliEnv } from "./env.js";
import { renderCliHelpFromArgs } from "./help.js";
import { probeHarnessHooksStatus } from "./observerProviders.js";

export type ParsedGlobalOptions = { args: string[]; configPath?: string };

export type PreparedCliConfig = {
  loaded?: LoadedStationConfig;
  error?: unknown;
};

const MODULE_PATH = fileURLToPath(import.meta.url);
// Self-exec uses the source entry during development and the compiled entry in distribution.
const CLI_ENTRY_PATH = join(dirname(MODULE_PATH), `main${extname(MODULE_PATH)}`);

/**
 * ADAPTER
 *
 * Translates CLI arguments and loaded configuration into registered command execution, exposing
 * only a non-rendered command-correlation seam to the process owner. Direct calls never persist
 * process diagnostics.
 */
export async function runCli(
  argv: readonly string[] = process.argv.slice(2),
  options: CliRunOptions = {},
): Promise<CliRunResult> {
  return runParsedCli(parseGlobalOptions(argv), options);
}

export async function runParsedCli(
  parsed: ParsedGlobalOptions,
  options: CliRunOptions,
  preparedConfig?: PreparedCliConfig,
): Promise<CliRunResult> {
  const commandOptions = withCliComposition(options);
  const { args, configPath } = parsed;
  const help = renderCliHelpFromArgs(args);
  if (help !== undefined) {
    return { code: 0, output: help.text, outputFormat: "text" };
  }
  if (args.length === 1 && args[0] === "--version") {
    return {
      code: 0,
      output: options.updateDeps?.currentBuildInfo?.version ?? stationBuildInfo().version,
      outputFormat: "text",
    };
  }

  const command = args[0] ?? resolveDefaultCliCommand(defaultCommandEnv(commandOptions));
  const commandArgs = args[0] === undefined ? [] : args.slice(1);
  const route = resolveCliCommandRoute(command, commandArgs);
  if (route === undefined) {
    throw new Error(`Unknown command: ${command ?? ""}`);
  }

  let loaded: LoadedStationConfig | undefined;
  try {
    if (route.requiresConfig) {
      if (preparedConfig?.error !== undefined) throw preparedConfig.error;
      loaded =
        preparedConfig?.loaded ??
        (configPath === undefined ? await loadConfig() : await loadConfig(configPath));
    }
  } catch (error) {
    const handled = await handleCliCommandConfigError(route, error, {
      path: route.path,
      args: route.args,
      allArgs: args,
      cliEntryPath: CLI_ENTRY_PATH,
      renderHelpTopic: renderCliCommandHelpTopic,
      ...(configPath === undefined ? {} : { configPath }),
      options: commandOptions,
    });
    if (handled !== undefined) return handled;
    throw error;
  }

  return runCliCommandRoute(route, {
    path: route.path,
    args: route.args,
    allArgs: args,
    cliEntryPath: CLI_ENTRY_PATH,
    renderHelpTopic: renderCliCommandHelpTopic,
    ...(configPath === undefined ? {} : { configPath }),
    ...(loaded?.config === undefined ? {} : { config: loaded.config }),
    ...(loaded?.configPath === undefined ? {} : { resolvedConfigPath: loaded.configPath }),
    options: commandOptions,
  });
}

export function parseGlobalOptions(argv: readonly string[]): ParsedGlobalOptions {
  const args: string[] = [];
  let configPath: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--config") {
      const value = parseRequiredOptionValue(argv[index + 1], "--config");
      if (value.startsWith("--") || isTopLevelCliCommand(value)) {
        throw new CliInputError("CLI_CONFIG_VALUE_REQUIRED", "--config requires a value.");
      }
      configPath = value;
      index += 1;
      continue;
    }
    if (arg !== undefined) args.push(arg);
  }

  return {
    args,
    ...(configPath === undefined ? {} : { configPath }),
  };
}

export function defaultCommandEnv(options: CliRunOptions): CliEnv {
  return options.env ?? options.popupDeps?.env ?? options.tuiDeps?.env ?? process.env;
}

export function resolveDefaultCliCommand(env: CliEnv): "popup" | "tui" {
  return env.TMUX === undefined || env.TMUX.length === 0 ? "tui" : "popup";
}

function withCliComposition(options: CliRunOptions): CliRunOptions {
  const setupDeps = { ...options.setupDeps };
  const sessionDeps = { ...options.sessionDeps };
  if (options.providerHookIngressLauncher !== undefined) {
    setupDeps.providerHookIngressLauncher = options.providerHookIngressLauncher;
  }
  if (options.providerHookArtifactOwner !== undefined) {
    setupDeps.providerHookArtifactOwner = options.providerHookArtifactOwner;
  }
  setupDeps.probeHarnessHooksStatus ??= (harnessId, configPath) =>
    probeHarnessHooksStatus(harnessId, configPath, {
      ...(options.providerHookIngressLauncher === undefined
        ? {}
        : { ingressLauncher: options.providerHookIngressLauncher }),
      ...(options.providerHookArtifactOwner === undefined
        ? {}
        : { artifactOwner: options.providerHookArtifactOwner }),
    });
  sessionDeps.captureCallerClaims ??= (environment) => ({
    ...captureTmuxCallerClaims(environment),
    ...captureNativeCallerClaims(environment),
  });
  return {
    ...options,
    sessionDeps,
    setupDeps,
  };
}

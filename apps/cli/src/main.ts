#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { type LoadedStationConfig, loadConfig, resolveObserverPaths } from "@station/config";
import { ObserverLifecycleFailureSchema } from "@station/contracts";
import {
  isSafeError,
  providerHookArtifactOwner,
  type RuntimeSafeError,
  stationBuildInfo,
} from "@station/runtime";
import { captureTmuxCallerClaims } from "@station/tmux";
import { CliInputError, parseRequiredOptionValue } from "./args.js";
import {
  type CliProcessDiagnostics,
  createCliProcessDiagnostics,
} from "./cliProcessDiagnostics.js";
import type { CliRunOptions, CliRunResult } from "./cliTypes.js";
import {
  handleCliCommandConfigError,
  isTopLevelCliCommand,
  renderCliCommandHelpTopic,
  resolveCliCommandRoute,
  runCliCommandRoute,
} from "./commandRegistry.js";
import type { CliEnv } from "./env.js";
import { isCliHelpFlag, renderCliHelpFromArgs } from "./help.js";
import { probeHarnessHooksStatus } from "./observerProviders.js";
import { escapeTerminalBytes, formatCliJson, formatCliOutput } from "./terminalOutput.js";
import { resolveDefaultIngressLauncher } from "./worktrunkHookExpectation.js";

export type { CliRunOptions, CliRunResult } from "./cliTypes.js";

/**
 * ADAPTER
 *
 * Translates CLI arguments and loaded configuration into registered command execution, exposing
 * only a non-rendered command-correlation seam to the process owner. Direct calls never persist
 * process diagnostics.
 */
export async function runCli(
  argv = process.argv.slice(2),
  options: CliRunOptions = {},
): Promise<CliRunResult> {
  return runParsedCli(parseGlobalOptions(argv), options);
}

type ParsedGlobalOptions = { args: string[]; configPath?: string };

type PreparedCliConfig = {
  loaded?: LoadedStationConfig;
  error?: unknown;
};

async function runParsedCli(
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
  const command = args[0] ?? defaultCommand(defaultCommandEnv(commandOptions));
  const commandArgs = args[0] === undefined ? [] : args.slice(1);
  const route = resolveCliCommandRoute(command, commandArgs);
  if (route === undefined) {
    throw new Error(`Unknown command: ${command ?? ""}`);
  }
  let loaded: Awaited<ReturnType<typeof loadConfig>> | undefined;
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
      cliEntryPath: fileURLToPath(import.meta.url),
      renderHelpTopic: renderCliCommandHelpTopic,
      ...(configPath === undefined ? {} : { configPath }),
      options: commandOptions,
    });
    if (handled !== undefined) {
      return handled;
    }
    throw error;
  }
  return runCliCommandRoute(route, {
    path: route.path,
    args: route.args,
    allArgs: args,
    cliEntryPath: fileURLToPath(import.meta.url),
    renderHelpTopic: renderCliCommandHelpTopic,
    ...(configPath === undefined ? {} : { configPath }),
    ...(loaded?.config === undefined ? {} : { config: loaded.config }),
    ...(loaded?.configPath === undefined ? {} : { resolvedConfigPath: loaded.configPath }),
    options: commandOptions,
  });
}

function defaultCommand(env: CliEnv): "popup" | "tui" {
  return env.TMUX === undefined || env.TMUX.length === 0 ? "tui" : "popup";
}

function defaultCommandEnv(options: CliRunOptions): CliEnv {
  return options.env ?? options.popupDeps?.env ?? options.tuiDeps?.env ?? process.env;
}

/**
 * ADAPTER
 *
 * Owns optional process tracing and best-effort failure finalization around registered CLI
 * execution. Diagnostic writes never gate command side effects, replace output, alter exit status,
 * or emit degradation warnings.
 */
export async function runCliMain(
  argv: readonly string[] = process.argv.slice(2),
  options: CliRunOptions = {},
): Promise<void> {
  const processDeps = options.cliProcessDeps ?? {};
  const clock = processDeps.clock ?? { now: () => new Date() };
  const startedAt = safeNow(clock);
  const invocationId = safeInvocationId(processDeps.randomUUID);
  const stdoutWrite = processDeps.stdoutWrite ?? ((value: string) => process.stdout.write(value));
  const stderrWrite = processDeps.stderrWrite ?? ((value: string) => process.stderr.write(value));
  const exit = processDeps.exit ?? ((code: number) => process.exit(code));
  const setExitCode =
    processDeps.setExitCode ??
    ((code: number) => {
      process.exitCode = code;
    });

  let parsed: ParsedGlobalOptions | undefined;
  let parseError: unknown;
  try {
    parsed = parseGlobalOptions([...argv]);
  } catch (error) {
    parseError = error;
  }

  const processEnv = defaultCommandEnv(options);
  const helpRequested = parsed?.args.some(isCliHelpFlag) === true;
  const versionRequested = parsed?.args.length === 1 && parsed.args[0] === "--version";
  const command = parsed === undefined ? undefined : (parsed.args[0] ?? defaultCommand(processEnv));
  const commandArgs =
    parsed === undefined || parsed.args[0] === undefined ? [] : parsed.args.slice(1);
  const route = command === undefined ? undefined : resolveCliCommandRoute(command, commandArgs);
  const routePath = canonicalProcessRoute(
    parsed,
    route?.resolvedPath,
    helpRequested,
    versionRequested,
  );
  const requiresConfig =
    parseError === undefined &&
    !helpRequested &&
    !versionRequested &&
    route?.requiresConfig === true;
  const preparedConfig = requiresConfig
    ? await prepareCliConfig(parsed, processDeps.loadConfig)
    : ({} satisfies PreparedCliConfig);

  let currentBuildInfo: ReturnType<typeof stationBuildInfo> | undefined;
  let buildError: unknown;
  try {
    currentBuildInfo =
      options.updateDeps?.currentBuildInfo ?? (options.updateDeps?.buildInfo ?? stationBuildInfo)();
  } catch (error) {
    buildError = error;
  }

  const diagnostics = prepareProcessDiagnostics({
    options,
    preparedConfig,
    invocationId,
    startedAt,
    routePath,
    argumentCount: parsed?.args.length ?? argv.length,
    hasStdin: parsed?.args.includes("--stdin") ?? argv.includes("--stdin"),
    processEnv,
    ...(currentBuildInfo === undefined ? {} : { buildVersion: currentBuildInfo.version }),
  });
  diagnostics.start();

  const suppressOutput = parsed === undefined ? false : shouldSuppressCliProcessOutput(parsed.args);
  let correlation: CliRunResult["correlation"];
  try {
    if (parseError !== undefined) throw parseError;
    if (parsed === undefined) {
      throw new CliInputError("CLI_GLOBAL_PARSE_FAILED", "Global CLI parsing failed.");
    }
    if (buildError !== undefined) throw buildError;
    if (currentBuildInfo === undefined)
      throw new Error("Station build information is unavailable.");

    const processOptions = withProcessComposition(options, currentBuildInfo);
    const result = await runParsedCli(parsed, processOptions, preparedConfig);
    correlation = result.correlation;
    if (!suppressOutput && result.output !== undefined) {
      stdoutWrite(formatCliOutput(result));
    }
    if (suppressOutput) {
      if (result.code !== 0 && result.output !== undefined) {
        stderrWrite(formatCliOutput(result));
      }
      await diagnostics.outcome({
        exitCode: result.code,
        ...(result.correlation === undefined ? {} : { correlation: result.correlation }),
        ...(preparedConfig.error === undefined ? {} : { error: preparedConfig.error }),
      });
      exit(result.code);
      return;
    }
    await diagnostics.outcome({
      exitCode: result.code,
      ...(result.correlation === undefined ? {} : { correlation: result.correlation }),
      ...(preparedConfig.error === undefined ? {} : { error: preparedConfig.error }),
    });
    setExitCode(result.code);
  } catch (error) {
    try {
      stderrWrite(`${formatCliError(error)}\n`);
    } catch {
      // Output failure must still retain the original command failure and exit status.
    }
    await diagnostics.outcome({
      exitCode: 1,
      ...(correlation === undefined ? {} : { correlation }),
      error,
      ...(ObserverLifecycleFailureSchema.safeParse(error).success
        ? { observerStartupFailure: true }
        : {}),
    });
    setExitCode(1);
  }
}

function prepareProcessDiagnostics(input: {
  options: CliRunOptions;
  preparedConfig: PreparedCliConfig;
  invocationId: string;
  startedAt: Date;
  routePath: readonly string[];
  argumentCount: number;
  hasStdin: boolean;
  processEnv: CliEnv;
  buildVersion?: string;
}): CliProcessDiagnostics {
  const deps = input.options.cliProcessDeps ?? {};
  try {
    const paths = (deps.resolveObserverPaths ?? resolveObserverPaths)(
      input.preparedConfig.loaded?.config,
    );
    return createCliProcessDiagnostics(
      {
        stateDir: paths.stateDir,
        tracing: input.processEnv.STATION_CLI_TRACE === "1",
        invocationId: input.invocationId,
        startedAt: input.startedAt,
        route: input.routePath,
        argumentCount: input.argumentCount,
        hasStdin: input.hasStdin,
        callerClaims: {
          tmux: nonEmptyEnvironmentValue(input.processEnv.TMUX),
          tmuxPane: nonEmptyEnvironmentValue(input.processEnv.TMUX_PANE),
        },
        ...(input.buildVersion === undefined ? {} : { buildVersion: input.buildVersion }),
      },
      deps,
    );
  } catch {
    return NOOP_PROCESS_DIAGNOSTICS;
  }
}

const NOOP_PROCESS_DIAGNOSTICS: CliProcessDiagnostics = {
  start: () => undefined,
  outcome: async () => undefined,
};

async function prepareCliConfig(
  parsed: ParsedGlobalOptions | undefined,
  loader: NonNullable<CliRunOptions["cliProcessDeps"]>["loadConfig"],
): Promise<PreparedCliConfig> {
  if (parsed === undefined) {
    return { error: new CliInputError("CLI_GLOBAL_PARSE_FAILED", "Global CLI parsing failed.") };
  }
  const load =
    loader ??
    (async (configPath?: string) =>
      configPath === undefined ? loadConfig() : loadConfig(configPath));
  try {
    return { loaded: await load(parsed.configPath) };
  } catch (error) {
    return { error };
  }
}

function canonicalProcessRoute(
  parsed: ParsedGlobalOptions | undefined,
  resolvedPath: readonly string[] | undefined,
  helpRequested: boolean,
  versionRequested: boolean,
): readonly string[] {
  if (versionRequested) return ["version"];
  if (helpRequested) {
    return resolvedPath ?? [parsed?.args.includes("--man") === true ? "man" : "help"];
  }
  return resolvedPath ?? [];
}

function safeNow(clock: { now(): Date }): Date {
  try {
    return clock.now();
  } catch {
    return new Date();
  }
}

function safeInvocationId(create: (() => string) | undefined): string {
  try {
    return (create ?? randomUUID)();
  } catch {
    return randomUUID();
  }
}

function nonEmptyEnvironmentValue(value: string | undefined): boolean {
  return value !== undefined && value.length > 0;
}

function withProcessComposition(
  options: CliRunOptions,
  currentBuildInfo: ReturnType<typeof stationBuildInfo>,
): CliRunOptions {
  const providerHookIngressLauncher =
    options.providerHookIngressLauncher ?? resolveDefaultIngressLauncher();
  return {
    ...options,
    updateDeps: { ...options.updateDeps, currentBuildInfo },
    providerHookIngressLauncher,
    providerHookArtifactOwner:
      options.providerHookArtifactOwner ??
      providerHookArtifactOwner(providerHookIngressLauncher, currentBuildInfo),
  };
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
  sessionDeps.captureCallerClaims ??= captureTmuxCallerClaims;
  return {
    ...options,
    sessionDeps,
    setupDeps,
  };
}

if (import.meta.main) {
  void runCliMain();
}

export function shouldSuppressCliProcessOutput(invoked: readonly string[]): boolean {
  if (invoked.some(isCliHelpFlag)) {
    return false;
  }
  const command = invoked[0];
  return command === undefined || command === "tui" || command === "popup" || command === "observe";
}

function formatCliError(error: unknown): string {
  if (isSafeError(error)) {
    return formatSafeError(error);
  }
  if (error instanceof Error) {
    return escapeTerminalBytes(error.message);
  }
  if (typeof error === "object" && error !== null) {
    try {
      return formatCliJson(error);
    } catch {
      return escapeTerminalBytes(String(error));
    }
  }
  return escapeTerminalBytes(String(error));
}

function formatSafeError(error: RuntimeSafeError): string {
  const lines = [`${escapeTerminalBytes(error.message)} (${escapeTerminalBytes(error.code)})`];
  if (error.hint !== undefined) {
    lines.push(`Hint: ${escapeTerminalBytes(error.hint)}`);
  }
  if (error.diagnosticId !== undefined) {
    lines.push(`Diagnostic: ${escapeTerminalBytes(error.diagnosticId)}`);
  }
  if (error.commandId !== undefined) {
    lines.push(`Command: ${escapeTerminalBytes(error.commandId)}`);
  }
  if (error.traceId !== undefined) {
    lines.push(`Trace: ${escapeTerminalBytes(error.traceId)}`);
  }
  return lines.join("\n");
}

function parseGlobalOptions(argv: string[]): { args: string[]; configPath?: string } {
  const args: string[] = [];
  let configPath: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--config") {
      const value = parseRequiredOptionValue(argv[index + 1], "--config");
      if (value.startsWith("--") || isTopLevelCommand(value)) {
        throw new CliInputError("CLI_CONFIG_VALUE_REQUIRED", "--config requires a value.");
      }
      configPath = value;
      index += 1;
      continue;
    }
    if (arg !== undefined) {
      args.push(arg);
    }
  }

  return {
    args,
    ...(configPath === undefined ? {} : { configPath }),
  };
}

function isTopLevelCommand(value: string): boolean {
  return isTopLevelCliCommand(value);
}

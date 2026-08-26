#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  ConfigError,
  type LoadedStationConfig,
  loadConfig,
  resolveObserverPaths,
} from "@station/config";
import { CliInvocationIdSchema, type CliRunAuditMetadata } from "@station/contracts";
import {
  allowlistedCliRunAuditMetadata,
  appendDurableCliInvocationRecord,
  mergeRetentionPolicy,
} from "@station/observability";
import {
  isSafeError,
  providerHookArtifactOwner,
  type RuntimeSafeError,
  stationBuildInfo,
} from "@station/runtime";
import { captureTmuxCallerClaims } from "@station/tmux";
import { CliInputError, isCliInputError, parseRequiredOptionValue } from "./args.js";
import type { CliInvocationAuditDeps, CliRunOptions, CliRunResult } from "./cliTypes.js";
import {
  handleCliCommandConfigError,
  isTopLevelCliCommand,
  renderCliCommandHelpTopic,
  resolveCliCommandRoute,
  runCliCommandRoute,
} from "./commandRegistry.js";
import type { CliEnv } from "./env.js";
import { isCliHelpFlag, renderCliHelpFromArgs } from "./help.js";
import {
  auditSinkEvidence,
  buildCliInvocationArgumentShape,
  CLI_INVOCATION_AUDIT_WARNING,
  CLI_INVOCATION_MUTATION_BLOCKED_WARNING,
  CLI_INVOCATION_OUTCOME_UNCERTAIN_WARNING,
  classifyCliInvocationEffect,
  cliInvocationBuildEvidence,
  cliInvocationErrorSummary,
  createCliInvocationAuditLifecycle,
  projectCurrentSessionAuditMetadata,
  terminalStatusForResult,
} from "./invocationAudit.js";
import { probeHarnessHooksStatus } from "./observerProviders.js";
import { escapeTerminalBytes, formatCliJson, formatCliOutput } from "./terminalOutput.js";
import { resolveDefaultIngressLauncher } from "./worktrunkHookExpectation.js";

export type { CliRunOptions, CliRunResult } from "./cliTypes.js";

/**
 * ADAPTER
 *
 * Translates CLI arguments and loaded configuration into registered command execution with
 * allowlisted pre-render audit metadata. Durable invocation persistence belongs to `runCliMain`.
 */
export async function runCli(
  argv = process.argv.slice(2),
  options: CliRunOptions = {},
): Promise<CliRunResult> {
  const parsed = parseGlobalOptions(argv);
  return runParsedCli(parsed, options);
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
  const result = await runCliCommandRoute(route, {
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
  if (result.audit === undefined && route.resolvedPath.join(" ") === "session current") {
    const audit = projectCurrentSessionAuditMetadata(result.output);
    if (audit !== undefined) return { ...result, audit };
  }
  return result;
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
 * Owns one invocation identity from process entry through durable start-before-mutation ordering,
 * command output, and exactly one outcome attempt. Read and recovery routes remain usable with a
 * visible warning when the audit sink is unavailable.
 */
export async function runCliMain(
  argv: readonly string[] = process.argv.slice(2),
  options: CliRunOptions = {},
): Promise<void> {
  const invocationId = CliInvocationIdSchema.parse(
    (options.invocationAuditDeps?.randomUUID ?? randomUUID)(),
  );
  const startedAt = (options.invocationAuditDeps?.clock ?? { now: () => new Date() }).now();
  const auditDeps = options.invocationAuditDeps ?? {};
  const clock = auditDeps.clock ?? { now: () => new Date() };
  const stdoutWrite = auditDeps.stdoutWrite ?? ((value: string) => process.stdout.write(value));
  const stderrWrite = auditDeps.stderrWrite ?? ((value: string) => process.stderr.write(value));
  const exit = auditDeps.exit ?? ((code: number) => process.exit(code));
  const setExitCode =
    auditDeps.setExitCode ??
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
  const command = parsed === undefined ? undefined : (parsed.args[0] ?? defaultCommand(processEnv));
  const commandArgs =
    parsed === undefined || parsed.args[0] === undefined ? [] : parsed.args.slice(1);
  const route = command === undefined ? undefined : resolveCliCommandRoute(command, commandArgs);
  const helpRequested = parsed?.args.some(isCliHelpFlag) === true;
  const versionRequested = parsed?.args.length === 1 && parsed.args[0] === "--version";
  const resolvedPath = versionRequested
    ? ["version"]
    : helpRequested && route === undefined
      ? [parsed?.args.includes("--man") === true ? "man" : "help"]
      : (route?.resolvedPath ?? []);
  const effect =
    parseError !== undefined || helpRequested || versionRequested || route === undefined
      ? "none"
      : classifyCliInvocationEffect(resolvedPath, route.args);

  const preparedConfig = await prepareCliConfig(parsed, auditDeps.loadConfig);
  const configured = preparedConfig.loaded !== undefined;
  const resolvePaths = auditDeps.resolveObserverPaths ?? resolveObserverPaths;
  const paths = resolvePaths(preparedConfig.loaded?.config);
  const policy = (auditDeps.mergeRetentionPolicy ?? mergeRetentionPolicy)(
    preparedConfig.loaded?.config.observability?.retention,
  );
  const configError = preparedConfig.error;
  const sink = auditSinkEvidence({
    explicitConfig: parsed?.configPath !== undefined,
    configured,
    missingDefaultConfig:
      parsed?.configPath === undefined &&
      configError instanceof ConfigError &&
      configError.code === "CONFIG_FILE_NOT_FOUND",
  });

  let currentBuildInfo: ReturnType<typeof stationBuildInfo> | undefined;
  let buildError: unknown;
  try {
    currentBuildInfo =
      options.updateDeps?.currentBuildInfo ?? (options.updateDeps?.buildInfo ?? stationBuildInfo)();
  } catch (error) {
    buildError = error;
  }

  const lifecycle = createCliInvocationAuditLifecycle({
    invocationId,
    startedAt,
    stateDir: paths.stateDir,
    policy,
    clock,
    appendRecord: auditDeps.appendRecord ?? appendDurableCliInvocationRecord,
  });
  const start = await lifecycle.start({
    build: cliInvocationBuildEvidence(currentBuildInfo),
    intentPath: [...resolvedPath],
    arguments: buildCliInvocationArgumentShape(parsed?.args ?? []),
    effect,
    sink,
    callerClaims: {
      tmux: nonEmptyEnvironmentValue(processEnv.TMUX),
      tmuxPane: nonEmptyEnvironmentValue(processEnv.TMUX_PANE),
    },
  });
  if (!start.durable) {
    stderrWrite(
      effect === "mutation"
        ? CLI_INVOCATION_MUTATION_BLOCKED_WARNING
        : CLI_INVOCATION_AUDIT_WARNING,
    );
  } else if (start.cleanupDegraded) {
    stderrWrite(CLI_INVOCATION_AUDIT_WARNING);
  }

  const finalize = async (
    code: number,
    status: Parameters<CliInvocationAuditLifecycle["outcome"]>[0]["status"],
    audit?: CliRunAuditMetadata,
  ): Promise<number> => {
    const outcome = await lifecycle.outcome({
      status,
      exitCode: code,
      resolvedPath: [...resolvedPath],
      ...(audit === undefined ? {} : { audit }),
    });
    if (!outcome.durable) {
      stderrWrite(
        effect === "mutation" && start.durable
          ? CLI_INVOCATION_OUTCOME_UNCERTAIN_WARNING
          : CLI_INVOCATION_AUDIT_WARNING,
      );
      return effect === "mutation" && start.durable && code === 0 ? 1 : code;
    }
    if (outcome.cleanupDegraded) stderrWrite(CLI_INVOCATION_AUDIT_WARNING);
    return code;
  };

  if (effect === "mutation" && !start.durable) {
    const code = await finalize(1, "process_exception");
    setExitCode(code);
    return;
  }

  if (buildError !== undefined || currentBuildInfo === undefined) {
    const error = buildError ?? new Error("Station build information is unavailable.");
    stderrWrite(`${formatCliError(error)}\n`);
    const audit = auditMetadataForError(error);
    const code = await finalize(1, "process_exception", audit);
    setExitCode(code);
    return;
  }

  const processOptions = withProcessComposition(options, currentBuildInfo);
  const suppressOutput = parsed === undefined ? false : shouldSuppressCliProcessOutput(parsed.args);
  let completedAudit: CliRunAuditMetadata | undefined;
  try {
    if (parseError !== undefined) throw parseError;
    if (parsed === undefined) throw new Error("CLI arguments were not prepared.");
    const result = await runParsedCli(parsed, processOptions, preparedConfig);
    completedAudit = result.audit;
    if (!suppressOutput && result.output !== undefined) {
      stdoutWrite(formatCliOutput(result));
    }
    if (suppressOutput) {
      if (result.code !== 0 && result.output !== undefined) {
        stderrWrite(formatCliOutput(result));
      }
      const finalCode = await finalize(
        result.code,
        terminalStatusForResult({
          help: helpRequested,
          version: versionRequested,
          recovery: effect === "recovery",
          code: result.code,
          ...(result.audit === undefined ? {} : { audit: result.audit }),
        }),
        result.audit,
      );
      exit(finalCode);
      return;
    }
    const finalCode = await finalize(
      result.code,
      terminalStatusForResult({
        help: helpRequested,
        version: versionRequested,
        recovery: effect === "recovery",
        code: result.code,
        ...(result.audit === undefined ? {} : { audit: result.audit }),
      }),
      result.audit,
    );
    setExitCode(finalCode);
  } catch (error) {
    stderrWrite(`${formatCliError(error)}\n`);
    const audit = auditMetadataForError(error, completedAudit);
    const status = terminalStatusForError({
      error,
      parseError,
      configError: preparedConfig.error,
      unknownCommand: route === undefined && parsed !== undefined,
    });
    const finalCode = await finalize(1, status, audit);
    setExitCode(finalCode);
  }
}

type CliInvocationAuditLifecycle = ReturnType<typeof createCliInvocationAuditLifecycle>;

async function prepareCliConfig(
  parsed: ParsedGlobalOptions | undefined,
  loader: CliInvocationAuditDeps["loadConfig"],
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

function auditMetadataForError(
  error: unknown,
  base?: CliRunAuditMetadata,
): CliRunAuditMetadata | undefined {
  const summary = cliInvocationErrorSummary(error);
  if (summary === undefined) return base;
  return allowlistedCliRunAuditMetadata({ ...base, error: summary }) ?? base;
}

function terminalStatusForError(input: {
  error: unknown;
  parseError?: unknown;
  configError?: unknown;
  unknownCommand: boolean;
}): Parameters<CliInvocationAuditLifecycle["outcome"]>[0]["status"] {
  if (input.error === input.parseError || isCliInputError(input.error)) return "parse_failure";
  if (input.error === input.configError || input.error instanceof ConfigError) {
    return "config_failure";
  }
  if (input.unknownCommand) return "unknown_command";
  if (isSafeError(input.error) && input.error.tag === "TimeoutError") return "timed_out";
  return "process_exception";
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

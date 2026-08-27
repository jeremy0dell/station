import { randomUUID } from "node:crypto";
import { loadConfig } from "@station/config";
import { ObserverLifecycleFailureSchema } from "@station/contracts";
import {
  isSafeError,
  providerHookArtifactOwner,
  type RuntimeSafeError,
  stationBuildInfo,
} from "@station/runtime";
import { CliInputError } from "./args.js";
import {
  defaultCommandEnv,
  type ParsedGlobalOptions,
  type PreparedCliConfig,
  parseGlobalOptions,
  resolveDefaultCliCommand,
  runParsedCli,
} from "./cliExecution.js";
import { createCliProcessDiagnostics } from "./cliProcessDiagnostics.js";
import type { CliProcessDeps } from "./cliProcessTypes.js";
import type { CliRunOptions, CliRunResult } from "./cliTypes.js";
import { resolveCliCommandRoute } from "./commandRegistry.js";
import type { CliEnv } from "./env.js";
import { isCliHelpFlag } from "./help.js";
import { escapeTerminalBytes, formatCliJson, formatCliOutput } from "./terminalOutput.js";
import { resolveDefaultIngressLauncher } from "./worktrunkHookExpectation.js";

type CliBuildInfo = ReturnType<typeof stationBuildInfo>;

type PreparedCliProcess = {
  parsed?: ParsedGlobalOptions;
  parseError?: unknown;
  processEnv: CliEnv;
  routePath: readonly string[];
  config: PreparedCliConfig;
  buildInfo?: CliBuildInfo;
  buildError?: unknown;
  suppressOutput: boolean;
};

type CliProcessIo = {
  stdoutWrite(value: string): void;
  stderrWrite(value: string): void;
  exit(code: number): void;
  setExitCode(code: number): void;
};

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
  const deps = options.cliProcessDeps ?? {};
  const clock = deps.clock ?? { now: () => new Date() };
  const startedAt = safeNow(clock);
  const invocationId = safeInvocationId(deps.randomUUID);
  const prepared = await prepareCliProcess(argv, options, deps);
  const diagnostics = createCliProcessDiagnostics(
    {
      env: prepared.processEnv,
      invocationId,
      startedAt,
      route: prepared.routePath,
      argumentCount: prepared.parsed?.args.length ?? argv.length,
      hasStdin: prepared.parsed?.args.includes("--stdin") ?? argv.includes("--stdin"),
      ...(prepared.config.loaded?.config === undefined
        ? {}
        : { config: prepared.config.loaded.config }),
      ...(prepared.buildInfo === undefined ? {} : { buildVersion: prepared.buildInfo.version }),
    },
    deps,
  );

  diagnostics.start();
  await runPreparedCliProcess(prepared, options, createCliProcessIo(deps), diagnostics);
}

async function prepareCliProcess(
  argv: readonly string[],
  options: CliRunOptions,
  deps: CliProcessDeps,
): Promise<PreparedCliProcess> {
  let parsed: ParsedGlobalOptions | undefined;
  let parseError: unknown;
  try {
    parsed = parseGlobalOptions(argv);
  } catch (error) {
    parseError = error;
  }

  const processEnv = defaultCommandEnv(options);
  const helpRequested = parsed?.args.some(isCliHelpFlag) === true;
  const versionRequested = parsed?.args.length === 1 && parsed.args[0] === "--version";
  const command =
    parsed === undefined ? undefined : (parsed.args[0] ?? resolveDefaultCliCommand(processEnv));
  const commandArgs =
    parsed === undefined || parsed.args[0] === undefined ? [] : parsed.args.slice(1);
  const route = command === undefined ? undefined : resolveCliCommandRoute(command, commandArgs);
  const requiresConfig =
    parseError === undefined &&
    !helpRequested &&
    !versionRequested &&
    route?.requiresConfig === true;
  const config = requiresConfig
    ? await prepareCliConfig(parsed, deps.loadConfig)
    : ({} satisfies PreparedCliConfig);

  let buildInfo: CliBuildInfo | undefined;
  let buildError: unknown;
  try {
    buildInfo =
      options.updateDeps?.currentBuildInfo ?? (options.updateDeps?.buildInfo ?? stationBuildInfo)();
  } catch (error) {
    buildError = error;
  }

  const prepared: PreparedCliProcess = {
    processEnv,
    routePath: canonicalProcessRoute(parsed, route?.resolvedPath, helpRequested, versionRequested),
    config,
    suppressOutput: parsed === undefined ? false : shouldSuppressCliProcessOutput(parsed.args),
  };
  if (parsed !== undefined) prepared.parsed = parsed;
  if (parseError !== undefined) prepared.parseError = parseError;
  if (buildInfo !== undefined) prepared.buildInfo = buildInfo;
  if (buildError !== undefined) prepared.buildError = buildError;
  return prepared;
}

async function runPreparedCliProcess(
  prepared: PreparedCliProcess,
  options: CliRunOptions,
  io: CliProcessIo,
  diagnostics: ReturnType<typeof createCliProcessDiagnostics>,
): Promise<void> {
  let correlation: CliRunResult["correlation"];
  try {
    if (prepared.parseError !== undefined) throw prepared.parseError;
    if (prepared.parsed === undefined) {
      throw new CliInputError("CLI_GLOBAL_PARSE_FAILED", "Global CLI parsing failed.");
    }
    if (prepared.buildError !== undefined) throw prepared.buildError;
    if (prepared.buildInfo === undefined) {
      throw new Error("Station build information is unavailable.");
    }

    const result = await runParsedCli(
      prepared.parsed,
      withProcessComposition(options, prepared.buildInfo),
      prepared.config,
    );
    correlation = result.correlation;
    if (!prepared.suppressOutput && result.output !== undefined) {
      io.stdoutWrite(formatCliOutput(result));
    }
    if (prepared.suppressOutput && result.code !== 0 && result.output !== undefined) {
      io.stderrWrite(formatCliOutput(result));
    }

    await diagnostics.outcome({
      exitCode: result.code,
      ...(result.correlation === undefined ? {} : { correlation: result.correlation }),
      ...(prepared.config.error === undefined ? {} : { error: prepared.config.error }),
    });
    if (prepared.suppressOutput) {
      io.exit(result.code);
      return;
    }
    io.setExitCode(result.code);
  } catch (error) {
    try {
      io.stderrWrite(`${formatCliError(error)}\n`);
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
    io.setExitCode(1);
  }
}

function createCliProcessIo(deps: CliProcessDeps): CliProcessIo {
  return {
    stdoutWrite: deps.stdoutWrite ?? ((value) => process.stdout.write(value)),
    stderrWrite: deps.stderrWrite ?? ((value) => process.stderr.write(value)),
    exit: deps.exit ?? ((code) => process.exit(code)),
    setExitCode:
      deps.setExitCode ??
      ((code) => {
        process.exitCode = code;
      }),
  };
}

async function prepareCliConfig(
  parsed: ParsedGlobalOptions | undefined,
  loader: CliProcessDeps["loadConfig"],
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

function withProcessComposition(options: CliRunOptions, buildInfo: CliBuildInfo): CliRunOptions {
  const providerHookIngressLauncher =
    options.providerHookIngressLauncher ?? resolveDefaultIngressLauncher();
  return {
    ...options,
    updateDeps: { ...options.updateDeps, currentBuildInfo: buildInfo },
    providerHookIngressLauncher,
    providerHookArtifactOwner:
      options.providerHookArtifactOwner ??
      providerHookArtifactOwner(providerHookIngressLauncher, buildInfo),
  };
}

export function shouldSuppressCliProcessOutput(invoked: readonly string[]): boolean {
  if (invoked.some(isCliHelpFlag)) return false;
  const command = invoked[0];
  return command === undefined || command === "tui" || command === "popup" || command === "observe";
}

function formatCliError(error: unknown): string {
  if (isSafeError(error)) return formatSafeError(error);
  if (error instanceof Error) return escapeTerminalBytes(error.message);
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
  if (error.hint !== undefined) lines.push(`Hint: ${escapeTerminalBytes(error.hint)}`);
  if (error.diagnosticId !== undefined) {
    lines.push(`Diagnostic: ${escapeTerminalBytes(error.diagnosticId)}`);
  }
  if (error.commandId !== undefined) {
    lines.push(`Command: ${escapeTerminalBytes(error.commandId)}`);
  }
  if (error.traceId !== undefined) lines.push(`Trace: ${escapeTerminalBytes(error.traceId)}`);
  return lines.join("\n");
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

#!/usr/bin/env node
import { type LoadedStationConfig, loadConfig } from "@station/config";
import { ObserverLifecycleFailureSchema } from "@station/contracts";
import { stationBuildInfo } from "@station/runtime";
import { CliInputError, parseRequiredOptionValue } from "./args.js";
import {
  createCliProcessIo,
  formatCliError,
  resolveCliProcessEnv,
  safeCliProcessInvocationId,
  safeCliProcessNow,
} from "./cliProcessBoundary.js";
import { createCliProcessDiagnostics } from "./cliProcessDiagnostics.js";
import type { CliRunCorrelation, CliRunOptions, CliRunResult } from "./cliTypes.js";
import {
  type CommandCommandOptions,
  commandCommandCorrelation,
  commandCommandExitCode,
  runCommandCommand,
} from "./commands/command.js";
import { readStdinIfAvailable } from "./stdin.js";
import { formatCliOutput } from "./terminalOutput.js";
import { isTopLevelCliCommand } from "./topLevelCliCommands.js";

type ParsedCommandDispatch = {
  allArgs: string[];
  commandArgs: string[];
  configPath?: string;
};

/**
 * Executes raw typed-command dispatch through the ordinary config, Observer, diagnostics, output,
 * and error boundaries without loading unrelated CLI command registries.
 */
export async function runCliMain(
  argv: readonly string[] = process.argv.slice(2),
  options: CliRunOptions = {},
): Promise<void> {
  const deps = options.cliProcessDeps ?? {};
  const clock = deps.clock ?? { now: () => new Date() };
  const startedAt = safeCliProcessNow(clock);
  const invocationId = safeCliProcessInvocationId(deps.randomUUID);
  const env = resolveCliProcessEnv(options);
  const io = createCliProcessIo(deps);
  let parsed: ParsedCommandDispatch | undefined;
  let parseError: unknown;
  try {
    parsed = parseCommandDispatch(argv);
  } catch (error) {
    parseError = error;
  }

  let loaded: LoadedStationConfig | undefined;
  let configError: unknown;
  if (parsed !== undefined) {
    try {
      const loader =
        deps.loadConfig ??
        (async (configPath?: string) =>
          configPath === undefined ? loadConfig() : loadConfig(configPath));
      loaded = parsed.configPath === undefined ? await loader() : await loader(parsed.configPath);
    } catch (error) {
      configError = error;
    }
  }

  let buildInfo: ReturnType<typeof stationBuildInfo> | undefined;
  let buildError: unknown;
  try {
    buildInfo =
      options.updateDeps?.currentBuildInfo ?? (options.updateDeps?.buildInfo ?? stationBuildInfo)();
  } catch (error) {
    buildError = error;
  }

  const diagnostics = createCliProcessDiagnostics(
    {
      env,
      invocationId,
      startedAt,
      route: ["command", "dispatch"],
      argumentCount: parsed?.allArgs.length ?? argv.length,
      hasStdin: parsed?.allArgs.includes("--stdin") ?? argv.includes("--stdin"),
      ...(loaded?.config === undefined ? {} : { config: loaded.config }),
      ...(buildInfo === undefined ? {} : { buildVersion: buildInfo.version }),
    },
    deps,
  );
  diagnostics.start();

  let correlation: CliRunCorrelation | undefined;
  try {
    if (parseError !== undefined) throw parseError;
    if (parsed === undefined) {
      throw new CliInputError("CLI_GLOBAL_PARSE_FAILED", "CLI global parsing failed.");
    }
    if (configError !== undefined) throw configError;
    if (loaded === undefined) throw new Error("Station config is unavailable.");
    if (buildError !== undefined) throw buildError;
    if (buildInfo === undefined) throw new Error("Station build information is unavailable.");

    const stdin = parsed.commandArgs.includes("--stdin")
      ? (options.stdin ?? (await readStdinIfAvailable()))
      : options.stdin;
    const commandOptions: CommandCommandOptions = {
      config: loaded.config,
      configPath: loaded.configPath,
    };
    if (stdin !== undefined) commandOptions.stdin = stdin;
    const result = await runCommandCommand(
      parsed.commandArgs,
      commandOptions,
      options.observerDeps,
    );
    correlation = commandCommandCorrelation(result);
    const cliResult: CliRunResult = {
      code: commandCommandExitCode(result),
      output: result,
    };
    if (correlation !== undefined) cliResult.correlation = correlation;
    io.stdoutWrite(formatCliOutput(cliResult));
    await diagnostics.outcome({
      exitCode: cliResult.code,
      ...(correlation === undefined ? {} : { correlation }),
    });
    io.setExitCode(cliResult.code);
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

function parseCommandDispatch(argv: readonly string[]): ParsedCommandDispatch {
  const allArgs: string[] = [];
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
    } else if (arg !== undefined) {
      allArgs.push(arg);
    }
  }
  if (allArgs[0] !== "command" || allArgs[1] !== "dispatch") {
    throw new Error("Command-dispatch process received an unrelated CLI route.");
  }
  return {
    allArgs,
    commandArgs: allArgs.slice(1),
    ...(configPath === undefined ? {} : { configPath }),
  };
}

if (import.meta.main) {
  void runCliMain();
}

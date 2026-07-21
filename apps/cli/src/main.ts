#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { loadConfig } from "@station/config";
import { isSafeError, type RuntimeSafeError, stationBuildInfo } from "@station/runtime";
import { parseRequiredOptionValue } from "./args.js";
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
import { resolveDefaultIngressLauncher } from "./worktrunkHookExpectation.js";

export type { CliRunOptions, CliRunResult } from "./cliTypes.js";

/**
 * ADAPTER
 *
 * Translates CLI arguments and loaded configuration into registered command execution.
 */
export async function runCli(
  argv = process.argv.slice(2),
  options: CliRunOptions = {},
): Promise<CliRunResult> {
  const commandOptions = withProviderHookSetupComposition(options);
  const { args, configPath } = parseGlobalOptions(argv);
  const help = renderCliHelpFromArgs(args);
  if (help !== undefined) {
    return { code: 0, output: help.text, outputFormat: "text" };
  }
  if (args.length === 1 && args[0] === "--version") {
    return { code: 0, output: stationBuildInfo().version, outputFormat: "text" };
  }
  const command = args[0] ?? defaultCommand(defaultCommandEnv(commandOptions));
  const commandArgs = args[0] === undefined ? [] : args.slice(1);
  const route = resolveCliCommandRoute(command, commandArgs);
  if (route === undefined) {
    throw new Error(`Unknown command: ${command ?? ""}`);
  }
  let loaded: Awaited<ReturnType<typeof loadConfig>> | undefined;
  try {
    loaded = route.requiresConfig
      ? configPath === undefined
        ? await loadConfig()
        : await loadConfig(configPath)
      : undefined;
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
 * Translates process arguments, output, and exit semantics around `runCli` while composing
 * process-owned provider-hook identity.
 */
export async function runCliMain(
  argv: readonly string[] = process.argv.slice(2),
  options: CliRunOptions = {},
): Promise<void> {
  const processOptions = withProcessComposition(options);
  let suppressOutput = false;
  try {
    suppressOutput = shouldSuppressCliProcessOutput(parseGlobalOptions([...argv]).args);
  } catch {
    suppressOutput = false;
  }
  try {
    const result = await runCli([...argv], processOptions);
    if (!suppressOutput && result.output !== undefined) {
      process.stdout.write(formatCliOutput(result));
    }
    if (suppressOutput) {
      if (result.code !== 0 && result.output !== undefined) {
        process.stderr.write(`${JSON.stringify(result.output, null, 2)}\n`);
      }
      process.exit(result.code);
    }
    process.exitCode = result.code;
  } catch (error) {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 1;
  }
}

function withProcessComposition(options: CliRunOptions): CliRunOptions {
  const providerHookIngressLauncher =
    options.providerHookIngressLauncher ?? resolveDefaultIngressLauncher();
  return {
    ...options,
    providerHookIngressLauncher,
  };
}

function withProviderHookSetupComposition(options: CliRunOptions): CliRunOptions {
  if (options.providerHookIngressLauncher === undefined) return options;
  return {
    ...options,
    setupDeps: {
      ...options.setupDeps,
      providerHookIngressLauncher: options.providerHookIngressLauncher,
    },
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

function formatCliOutput(result: CliRunResult): string {
  if (result.outputFormat === "text") {
    const text = String(result.output ?? "");
    return text.endsWith("\n") ? text : `${text}\n`;
  }
  return `${JSON.stringify(result.output, null, 2)}\n`;
}

function formatCliError(error: unknown): string {
  if (isSafeError(error)) {
    return formatSafeError(error);
  }
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "object" && error !== null) {
    try {
      return JSON.stringify(error, null, 2);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

function formatSafeError(error: RuntimeSafeError): string {
  const lines = [`${error.message} (${error.code})`];
  if (error.hint !== undefined) {
    lines.push(`Hint: ${error.hint}`);
  }
  if (error.diagnosticId !== undefined) {
    lines.push(`Diagnostic: ${error.diagnosticId}`);
  }
  if (error.traceId !== undefined) {
    lines.push(`Trace: ${error.traceId}`);
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
        throw new Error("--config requires a value.");
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

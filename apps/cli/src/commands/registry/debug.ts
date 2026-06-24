import { loadedCommandOptions } from "../cliCommand/helpers.js";
import type {
  CliCommandConfigErrorContext,
  CliCommandNode,
  CliCommandRunContext,
} from "../cliCommand/types.js";
import { isConfigError, runInvalidConfigDebugBundle } from "../configDiagnostics.js";
import { runDebugBundleCommand } from "../debugBundle.js";
import { runDebugLogsCommand } from "../debugLogs.js";
import { runDebugTraceCommand } from "../debugTrace.js";

export const debugCliCommand: CliCommandNode = {
  name: "debug",
  description: "Inspect traces, logs, and shareable diagnostic bundles.",
  usage: [
    "stn debug bundle [options]",
    "stn debug trace [query|--latest-failure] [--json]",
    "stn debug logs [query] [options]",
  ],
  options: [
    { name: "--help", description: "Show debug command help." },
    { name: "--man", description: "Show the fuller debug command manual." },
  ],
  examples: [
    "pnpm stn debug trace --latest-failure",
    "pnpm stn debug logs protocol --component hook",
    "pnpm stn debug bundle --latest-failure",
  ],
  children: [
    {
      name: "bundle",
      description: "Collect observer diagnostics into a shareable bundle.",
      requiresConfig: true,
      run: runDebugBundleCliCommand,
      handleConfigError: handleDebugBundleConfigError,
      usage: [
        "stn debug bundle",
        "stn debug bundle --trace <traceId>",
        "stn debug bundle --command <commandId>",
        "stn debug bundle --latest-failure",
        "stn debug bundle --last <duration>",
        "stn debug bundle --since <isoTimestamp>",
      ],
      options: [
        { name: "--project <id>", description: "Collect evidence for a specific project." },
        { name: "--command <id>", description: "Collect evidence for a command id." },
        { name: "--trace <id>", description: "Collect evidence for a trace id." },
        {
          name: "--latest-failure",
          description: "Collect evidence around the latest known failure.",
        },
        {
          name: "--last <duration>",
          description: "Collect recent evidence, such as 30m, 2h, or 1d.",
        },
        {
          name: "--since <isoTimestamp>",
          description: "Collect evidence after an ISO timestamp.",
        },
      ],
      examples: ["pnpm stn debug bundle --latest-failure", "pnpm stn debug bundle --last 30m"],
      notes: [
        "The command contacts the observer when run normally, but its help and manual topics are read-only.",
        "Bundles are written under the configured observer diagnostics directory.",
        "Use trace and command ids from observe output, debug trace output, or command records.",
      ],
    },
    {
      name: "trace",
      description: "Resolve trace, command, diagnostic, or latest-failure evidence.",
      requiresConfig: true,
      run: runDebugTraceCliCommand,
      usage: [
        "stn debug trace [query]",
        "stn debug trace --latest-failure",
        "stn debug trace [query] --json",
      ],
      options: [
        {
          name: "--latest-failure",
          description: "Find the most recent failure when no query is provided.",
        },
        { name: "--json", description: "Keep JSON output for agent-readable inspection." },
      ],
      examples: ["pnpm stn debug trace --latest-failure"],
    },
    {
      name: "logs",
      description: "Search bounded STATION component logs.",
      requiresConfig: true,
      run: runDebugLogsCliCommand,
      usage: ["stn debug logs [query] [options]"],
      options: [
        {
          name: "--component <name>",
          description: "Include observer, cli, tui, hook, or provider logs.",
        },
        { name: "--all-components", description: "Search every component log." },
        {
          name: "--min-level <level>",
          description: "Filter debug, info, warn, or error records.",
        },
        {
          name: "--since <isoTimestamp>",
          description: "Only include records at or after a timestamp.",
        },
        { name: "--limit <count>", description: "Limit returned records." },
        { name: "--json", description: "Keep JSON output for agent-readable inspection." },
      ],
      examples: [
        "pnpm stn debug logs protocol",
        "pnpm stn debug logs --all-components --min-level warn",
      ],
    },
  ],
};

async function runDebugBundleCliCommand(context: CliCommandRunContext) {
  const result = await runDebugBundleCommand(
    context.args,
    loadedCommandOptions(context),
    context.options.observerDeps,
  );
  return { code: 0, output: result };
}

async function handleDebugBundleConfigError(
  error: unknown,
  _context: CliCommandConfigErrorContext,
) {
  if (!isConfigError(error)) {
    return undefined;
  }
  const result = await runInvalidConfigDebugBundle({
    error,
    configPath: error.configPath,
  });
  return { code: 0, output: result };
}

async function runDebugTraceCliCommand(context: CliCommandRunContext) {
  const result = await runDebugTraceCommand(context.args, loadedCommandOptions(context));
  return { code: result.matched ? 0 : 1, output: result };
}

async function runDebugLogsCliCommand(context: CliCommandRunContext) {
  const result = await runDebugLogsCommand(context.args, loadedCommandOptions(context));
  return { code: result.matched > 0 ? 0 : 1, output: result };
}

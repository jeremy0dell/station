import { loadedCommandOptions } from "../cliCommand/helpers.js";
import type { CliCommandNode, CliCommandRunContext } from "../cliCommand/types.js";
import {
  observerCommandSummary,
  parseObserverCommandAction,
  runObserverCommand,
} from "../observer.js";

export const observerCliCommand: CliCommandNode = {
  name: "observer",
  description: "Start, stop, or inspect the local observer process.",
  requiresConfig: true,
  run: runObserverCliCommand,
  usage: [
    "stn observer start",
    "stn observer status",
    "stn observer stop",
    "stn observer reap [--force]",
  ],
  options: [
    {
      name: "--timeout-ms <ms>",
      description: "Override observer startup or health timeout where supported.",
    },
  ],
  examples: ["pnpm stn observer status", "pnpm stn observer start"],
  children: [
    {
      name: "start",
      description: "Start the observer and wait for health.",
      usage: ["stn observer start [--timeout-ms <ms>]"],
      options: [{ name: "--timeout-ms <ms>", description: "Override the startup health timeout." }],
      examples: ["pnpm stn observer start"],
    },
    {
      name: "status",
      description: "Report observer process availability.",
      usage: ["stn observer status"],
      examples: ["pnpm stn observer status"],
    },
    {
      name: "stop",
      description: "Stop the observer for the configured socket.",
      usage: ["stn observer stop"],
      examples: ["pnpm stn observer stop"],
    },
    {
      name: "reap",
      description:
        "List duplicate observers for the configured socket; --force terminates all but the live owner.",
      usage: ["stn observer reap [--force]"],
      options: [{ name: "--force", description: "Terminate the duplicates (default lists only)." }],
      examples: ["pnpm stn observer reap", "pnpm stn observer reap --force"],
    },
  ],
};

async function runObserverCliCommand(context: CliCommandRunContext) {
  const result = await runObserverCommand(
    context.args,
    loadedCommandOptions(context),
    context.options.observerDeps,
  );
  const action = parseObserverCommandAction(context.args);
  const failedStart =
    (action === "start" || action === "restart") &&
    "status" in result &&
    result.status !== "running";
  return { code: failedStart ? 1 : 0, output: observerCommandSummary(result) };
}

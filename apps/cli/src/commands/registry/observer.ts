import { loadedCommandOptions } from "../cliCommand/helpers.js";
import type { CliCommandNode, CliCommandRunContext } from "../cliCommand/types.js";
import { observerCommandSummary, runObserverCommand } from "../observer.js";

export const observerCliCommand: CliCommandNode = {
  name: "observer",
  description: "Start, stop, or inspect the local observer process.",
  requiresConfig: true,
  run: runObserverCliCommand,
  usage: ["stn observer start", "stn observer status", "stn observer stop"],
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
  ],
};

async function runObserverCliCommand(context: CliCommandRunContext) {
  const result = await runObserverCommand(
    context.args,
    loadedCommandOptions(context),
    context.options.observerDeps,
  );
  return { code: 0, output: observerCommandSummary(result) };
}

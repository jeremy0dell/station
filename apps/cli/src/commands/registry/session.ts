import { loadedCommandOptions } from "../cliCommand/helpers.js";
import type { CliCommandNode, CliCommandRunContext } from "../cliCommand/types.js";
import { runSessionCommand } from "../session.js";

export const sessionCliCommand: CliCommandNode = {
  name: "session",
  description: "Resolve the verified terminal context for the invoking session.",
  requiresConfig: true,
  run: runSessionCliCommand,
  usage: ["stn session current"],
  examples: ["stn session current"],
  notes: [
    "Current validates the caller's live terminal topology and returns a short-lived placement source.",
    "The output is strict JSON intended for explicit sibling placement commands.",
  ],
  children: [
    {
      name: "current",
      description: "Print the verified caller terminal context as JSON.",
      usage: ["stn session current"],
    },
  ],
};

async function runSessionCliCommand(context: CliCommandRunContext) {
  const result = await runSessionCommand(
    context.args,
    { ...loadedCommandOptions(context), ...context.options.sessionDeps },
    context.options.observerDeps,
  );
  return { code: 0, output: result };
}

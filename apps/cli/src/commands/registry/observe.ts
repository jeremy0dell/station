import { loadedCommandOptions } from "../cliCommand/helpers.js";
import type { CliCommandNode, CliCommandRunContext } from "../cliCommand/types.js";
import {
  type ObserveCommandDeps,
  type ObserveCommandOptions,
  runObserveCommand,
} from "../observe/index.js";

export const observeCliCommand: CliCommandNode = {
  name: "observe",
  description: "Stream live observer events and optional snapshots.",
  requiresConfig: true,
  run: runObserveCliCommand,
  usage: ["stn observe [options]"],
  options: [
    {
      name: "--json",
      description: "Print newline-delimited JSON for agent-readable consumption.",
    },
    {
      name: "--include-snapshot",
      description: "Emit the current snapshot before live events.",
    },
    { name: "--duration <time>", description: "Stop after a bounded duration." },
    { name: "--limit <count>", description: "Stop after a bounded number of events." },
  ],
  examples: [
    "pnpm stn observe --include-snapshot --duration 3s",
    "pnpm stn observe --json --limit 5",
  ],
};

async function runObserveCliCommand(context: CliCommandRunContext) {
  const observeOptions: ObserveCommandOptions = loadedCommandOptions(context);
  const observeDeps: ObserveCommandDeps = {};
  if (context.options.observeDeps !== undefined) {
    Object.assign(observeDeps, context.options.observeDeps);
  }
  if (context.options.observerDeps !== undefined && observeDeps.observer === undefined) {
    observeDeps.observer = context.options.observerDeps;
  }
  const result = await runObserveCommand(context.args, observeOptions, observeDeps);
  return { code: result.code };
}

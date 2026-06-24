import { readStdinIfAvailable } from "../../stdin.js";
import type { CliCommandNode, CliCommandRunContext } from "../cliCommand/types.js";
import type { NotifyCommandOptions } from "../notify.js";
import { runNotifyCommand } from "../notify.js";

export const notifyCliCommand: CliCommandNode = {
  name: "notify",
  description: "Run notification helpers used by event hooks.",
  run: runNotifyCliCommand,
  usage: ["stn notify turn-completion"],
  examples: ["pnpm stn event-hooks plan notify-turn-completion"],
  notes: [
    "Notify commands read hook payloads from stdin when run normally.",
    "They are primarily installed through observer event hooks instead of invoked by hand.",
  ],
  children: [
    {
      name: "turn-completion",
      description: "Notify when an agent transitions to idle through a hook event.",
      usage: ["stn notify turn-completion"],
      examples: ["pnpm stn event-hooks plan notify-turn-completion"],
    },
  ],
};

async function runNotifyCliCommand(context: CliCommandRunContext) {
  const stdin = context.options.stdin ?? (await readStdinIfAvailable());
  const notifyOptions: NotifyCommandOptions = {};
  if (stdin !== undefined) {
    notifyOptions.stdin = stdin;
  }
  if (context.configPath !== undefined) {
    notifyOptions.configPath = context.configPath;
  }
  const result = await runNotifyCommand(context.args, notifyOptions, context.options.notifyDeps);
  return { code: 0, output: result };
}

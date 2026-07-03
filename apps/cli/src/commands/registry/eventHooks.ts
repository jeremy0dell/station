import { hookCommandExitCode, loadedCommandOptions } from "../cliCommand/helpers.js";
import type { CliCommandNode, CliCommandRunContext } from "../cliCommand/types.js";
import type { EventHooksCommandOptions } from "../eventHooks.js";
import { runEventHooksCommand } from "../eventHooks.js";

const eventHookExamples = ["notify-agent-state"] as const;

export const eventHooksCliCommand: CliCommandNode = {
  name: "event-hooks",
  description: "Plan, install, or inspect observer event hooks.",
  requiresConfig: true,
  run: runEventHooksCliCommand,
  usage: [
    "stn event-hooks plan notify-agent-state [--force]",
    "stn event-hooks install notify-agent-state --yes [--force]",
    "stn event-hooks doctor",
  ],
  options: [
    { name: "--yes, -y", description: "Confirm event hook installation." },
    { name: "--force", description: "Replace an installed hook even if it already matches." },
  ],
  examples: ["pnpm stn event-hooks plan notify-agent-state", "pnpm stn event-hooks doctor"],
  children: [
    {
      name: "plan",
      displayName: "plan notify-agent-state",
      description: "Preview the built-in agent state notification observer event hook.",
      topicArguments: eventHookExamples,
      usage: ["stn event-hooks plan notify-agent-state [--force]"],
      options: [
        {
          name: "--force",
          description: "Show the replacement block even when the hook matches.",
        },
      ],
      examples: ["pnpm stn event-hooks plan notify-agent-state"],
    },
    {
      name: "install",
      displayName: "install notify-agent-state",
      description: "Install or replace the built-in agent state notification observer event hook.",
      topicArguments: eventHookExamples,
      usage: ["stn event-hooks install notify-agent-state --yes [--force]"],
      options: [
        { name: "--yes, -y", description: "Confirm writing the config file." },
        {
          name: "--force",
          description: "Replace an installed hook even if it already matches.",
        },
      ],
      examples: ["pnpm stn event-hooks install notify-agent-state --yes"],
    },
    {
      name: "doctor",
      description: "Check whether the built-in agent state notification event hook is usable.",
      usage: ["stn event-hooks doctor"],
      examples: ["pnpm stn event-hooks doctor"],
    },
  ],
};

async function runEventHooksCliCommand(context: CliCommandRunContext) {
  const eventHookOptions: EventHooksCommandOptions = loadedCommandOptions(context);
  if (context.options.env !== undefined) {
    eventHookOptions.env = context.options.env;
  }
  const result = await runEventHooksCommand(context.args, eventHookOptions);
  return { code: hookCommandExitCode(result), output: result };
}

import {
  actionNeedsYes,
  capitalize,
  hookCommandExitCode,
  loadedConfigCommandOptions,
} from "../cliCommand/helpers.js";
import type { CliCommandNode, CliCommandRunContext } from "../cliCommand/types.js";
import { runWorktrunkHooksCommand } from "../providerHookAdapters.js";

export const worktrunkCliCommand: CliCommandNode = {
  name: "worktrunk",
  description: "Manage Worktrunk-specific lifecycle hook helpers.",
  requiresConfig: true,
  usage: ["stn worktrunk hooks plan|install|uninstall|doctor [options]"],
  examples: ["pnpm stn worktrunk hooks doctor", "pnpm stn worktrunk hooks plan"],
  children: [
    {
      name: "hooks",
      description: "Plan, install, uninstall, or doctor Worktrunk hooks.",
      run: runWorktrunkHooksCliCommand,
      usage: [
        "stn worktrunk hooks plan [options]",
        "stn worktrunk hooks install --yes [options]",
        "stn worktrunk hooks uninstall --yes [options]",
        "stn worktrunk hooks doctor [options]",
      ],
      options: [
        { name: "--yes, -y", description: "Confirm install or uninstall actions." },
        {
          name: "--worktrunk-config <path>",
          description: "Use a specific Worktrunk config file.",
        },
        { name: "--hook-bin <command>", description: "Use a specific stn-ingress command." },
      ],
      examples: ["pnpm stn worktrunk hooks doctor", "pnpm stn worktrunk hooks install --yes"],
      children: ["plan", "install", "uninstall", "doctor"].map((action) =>
        worktrunkHookActionCommand(action),
      ),
    },
  ],
};

async function runWorktrunkHooksCliCommand(context: CliCommandRunContext) {
  const result = await runWorktrunkHooksCommand(context.args, loadedConfigCommandOptions(context));
  return { code: hookCommandExitCode(result), output: result };
}

function worktrunkHookActionCommand(action: string): CliCommandNode {
  return {
    name: action,
    description: `${capitalize(action)} Worktrunk lifecycle hooks.`,
    usage: [`stn worktrunk hooks ${action}${actionNeedsYes(action) ? " --yes" : ""} [options]`],
    options: [
      { name: "--yes, -y", description: "Required for install and uninstall actions." },
      { name: "--worktrunk-config <path>", description: "Use a specific Worktrunk config file." },
      { name: "--hook-bin <command>", description: "Use a specific stn-ingress command." },
    ],
    examples: [`pnpm stn worktrunk hooks ${action}${actionNeedsYes(action) ? " --yes" : ""}`],
  };
}

import {
  actionNeedsYes,
  hookCommandExitCode,
  loadedCommandOptions,
  loadedConfigCommandOptions,
} from "../cliCommand/helpers.js";
import type { CliCommandNode, CliCommandRunContext } from "../cliCommand/types.js";
import type { EventHooksCommandOptions } from "../eventHooks.js";
import { runEventHooksCommand } from "../eventHooks.js";
import {
  type ProviderHooksCommandOptions,
  runClaudeHooksCommand,
  runCodexHooksCommand,
  runCursorHooksCommand,
  runOpenCodeHooksCommand,
  runWorktrunkHooksCommand,
} from "../providerHookAdapters.js";

const hookTargets = ["worktrunk", "claude", "codex", "cursor", "opencode", "event"] as const;
const hookActions = ["plan", "install", "uninstall", "doctor"] as const;

export const hooksCliCommand: CliCommandNode = {
  name: "hooks",
  description: "Plan, install, uninstall, or inspect provider delivery hooks.",
  requiresConfig: true,
  usage: [
    "stn hooks plan <target> [options]",
    "stn hooks install <target> --yes [options]",
    "stn hooks uninstall <target> --yes [options]",
    "stn hooks doctor <target> [options]",
  ],
  options: [
    { name: "<target>", description: `One of: ${hookTargets.join(", ")}.` },
    { name: "--yes, -y", description: "Confirm install or uninstall actions." },
    {
      name: "--hook-bin <command>",
      description: "Use a specific stn-ingress command for generated hooks.",
    },
    {
      name: "--hook-script <path>",
      description: "Use a specific provider hook script path when supported.",
    },
  ],
  examples: [
    "pnpm stn hooks plan codex",
    "pnpm stn hooks install codex --yes",
    "pnpm stn hooks doctor opencode",
  ],
  children: hookActions.map((action) => hookActionCommand(action)),
};

async function runProviderHookCliCommand(context: CliCommandRunContext) {
  const hookAction = context.path[1];
  if (hookAction === undefined || !isHookAction(hookAction)) {
    throw new Error(`Unknown hook action: ${hookAction ?? ""}`);
  }
  const hookTarget = context.args[0];
  const hookArgs = [hookAction, ...context.args.slice(1)];
  switch (hookTarget) {
    case "worktrunk": {
      const result = await runWorktrunkHooksCommand(hookArgs, loadedConfigCommandOptions(context));
      return { code: hookCommandExitCode(result), output: result };
    }
    case "claude": {
      const claudeOptions: ProviderHooksCommandOptions = loadedCommandOptions(context);
      if (context.options.env !== undefined) {
        claudeOptions.env = context.options.env;
      }
      const result = await runClaudeHooksCommand(hookArgs, claudeOptions);
      return { code: hookCommandExitCode(result), output: result };
    }
    case "codex": {
      const codexOptions: ProviderHooksCommandOptions = loadedCommandOptions(context);
      if (context.options.env !== undefined) {
        codexOptions.env = context.options.env;
      }
      const result = await runCodexHooksCommand(hookArgs, codexOptions);
      return { code: hookCommandExitCode(result), output: result };
    }
    case "cursor": {
      const cursorOptions: ProviderHooksCommandOptions = loadedCommandOptions(context);
      if (context.options.env !== undefined) {
        cursorOptions.env = context.options.env;
      }
      const result = await runCursorHooksCommand(hookArgs, cursorOptions);
      return { code: hookCommandExitCode(result), output: result };
    }
    case "opencode": {
      const openCodeOptions: ProviderHooksCommandOptions = loadedCommandOptions(context);
      if (context.options.env !== undefined) {
        openCodeOptions.env = context.options.env;
      }
      const result = await runOpenCodeHooksCommand(hookArgs, openCodeOptions);
      return { code: hookCommandExitCode(result), output: result };
    }
    case "event": {
      const eventHookOptions: EventHooksCommandOptions = loadedCommandOptions(context);
      if (context.options.env !== undefined) {
        eventHookOptions.env = context.options.env;
      }
      const result = await runEventHooksCommand(hookArgs, eventHookOptions);
      return { code: hookCommandExitCode(result), output: result };
    }
    default:
      throw new Error(`Unknown hook target: ${hookTarget ?? ""}`);
  }
}

function hookActionCommand(action: (typeof hookActions)[number]): CliCommandNode {
  return {
    name: action,
    displayName: `${action} <target>`,
    description: hookActionDescription(action),
    run: runProviderHookCliCommand,
    topicArguments: hookTargets,
    usage: [`stn hooks ${action} <target>${actionNeedsYes(action) ? " --yes" : ""} [options]`],
    options: [
      { name: "<target>", description: `One of: ${hookTargets.join(", ")}.` },
      { name: "--yes, -y", description: "Required for install and uninstall actions." },
      {
        name: "--hook-bin <command>",
        description: "Use a specific stn-ingress command for generated hooks.",
      },
      {
        name: "--hook-script <path>",
        description: "Use a specific provider hook script path when supported.",
      },
      {
        name: "--cursor-hooks <path>",
        description: "Use a specific Cursor hooks directory for Cursor.",
      },
      {
        name: "--worktrunk-config <path>",
        description: "Use a specific Worktrunk config for Worktrunk.",
      },
    ],
    examples: [
      `pnpm stn hooks ${action} codex${actionNeedsYes(action) ? " --yes" : ""}`,
      `pnpm stn hooks ${action} worktrunk${actionNeedsYes(action) ? " --yes" : ""}`,
    ],
    notes: [
      "Provider hooks are delivery hints, not authoritative runtime truth.",
      "Use hook doctor output for setup delivery and observer snapshot output for current graph truth.",
    ],
  };
}

function hookActionDescription(action: (typeof hookActions)[number]): string {
  switch (action) {
    case "plan":
      return "Preview generated hook changes.";
    case "install":
      return "Install generated hook delivery for a target.";
    case "uninstall":
      return "Remove generated hook delivery for a target.";
    case "doctor":
      return "Inspect hook setup for a target.";
  }
}

function isHookAction(value: string): value is (typeof hookActions)[number] {
  return hookActions.includes(value as (typeof hookActions)[number]);
}

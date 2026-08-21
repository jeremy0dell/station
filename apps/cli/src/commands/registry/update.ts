import { loadedConfigCommandOptions } from "../cliCommand/helpers.js";
import type { CliCommandNode, CliCommandRunContext } from "../cliCommand/types.js";
import { runUpdateCommand } from "../update.js";

export const updateCliCommand: CliCommandNode = {
  name: "update",
  description: "Plan or apply an update through the installation's owning channel.",
  requiresConfig: true,
  run: runUpdateCliCommand,
  usage: [
    "stn update [--channel <id>] [--dry-run] [--reap] [--json] [--drive-package-manager] [--handoff[=processes|screen] | --no-handoff]",
  ],
  options: [
    {
      name: "--channel <id>",
      description: "Require installer-binary, dev-checkout, homebrew, npm-global, or mise.",
    },
    { name: "--dry-run", description: "Print the complete plan without applying it." },
    {
      name: "--reap",
      description: "With --dry-run, disclose exact terminal-loss and recovery consequences.",
    },
    { name: "--json", description: "Print the update plan or result as JSON." },
    {
      name: "--drive-package-manager",
      description: "Run the detected package manager command instead of deferring it.",
    },
    {
      name: "--handoff[=processes|screen]",
      description: "Explicitly preserve live Host state; bare --handoff uses processes fidelity.",
    },
    {
      name: "--no-handoff",
      description: "Update without preserving a busy Host; the next TUI may refuse it.",
    },
  ],
  examples: [
    "stn update --dry-run",
    "stn update --dry-run --json",
    "stn update --dry-run --reap --json",
    "stn update --drive-package-manager",
    "stn update --handoff=screen",
  ],
  notes: [
    "Package-managed installations defer by default and print the exact manager command.",
    "A committed update restarts the Observer before the default processes Host handoff.",
    "Non-dry-run --reap is reserved for the later destructive executor and is rejected before update detection.",
  ],
  verification: ["stn update --dry-run --json"],
};

async function runUpdateCliCommand(context: CliCommandRunContext) {
  const loaded = loadedConfigCommandOptions(context);
  return runUpdateCommand(
    context.args,
    {
      config: loaded.config,
      cliEntryPath: context.cliEntryPath,
      ...(loaded.configPath === undefined ? {} : { configPath: loaded.configPath }),
      ...(context.options.env === undefined ? {} : { env: context.options.env }),
    },
    updateDeps(context),
  );
}

function updateDeps(context: CliCommandRunContext) {
  const hostDeps = context.options.updateDeps?.hostDeps ?? context.options.hostDeps;
  return {
    ...context.options.updateDeps,
    ...(hostDeps === undefined ? {} : { hostDeps }),
  };
}

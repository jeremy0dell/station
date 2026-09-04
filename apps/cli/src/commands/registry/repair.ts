import { stationBuildInfo } from "@station/runtime";
import { createProviderRegistry } from "../../observerProviders.js";
import { createRepairExecutionDeps } from "../../repair/adapters.js";
import { loadedConfigCommandOptions } from "../cliCommand/helpers.js";
import type { CliCommandNode, CliCommandRunContext } from "../cliCommand/types.js";
import { runRepairCommand } from "../repair/command.js";

const applyOptions = [
  { name: "--json", description: "Print the strict redacted repair report." },
  { name: "--yes", description: "Authorize the previewed exact repair." },
  {
    name: "--expect-plan <sha256>",
    description: "Require the exact preview plan digest.",
  },
] as const;

export const repairCliCommand: CliCommandNode = {
  name: "repair",
  description: "Inspect and repair exact exceptional runtime or recovery state.",
  requiresConfig: true,
  run: runRepairCliCommand,
  usage: [
    "stn repair inventory [--json]",
    "stn repair terminal reap --terminal <terminalTargetId> [--json] [--yes --expect-plan <sha256>]",
    "stn repair observer cleanup [--json] [--yes --expect-plan <sha256>]",
    "stn repair recovery resume --handle <recoveryHandleId> [--json] [--yes --expect-plan <sha256>]",
    "stn repair recovery prune --handle <recoveryHandleId> [--json] [--yes --expect-plan <sha256>]",
  ],
  examples: ["stn repair inventory --json", "stn repair observer cleanup"],
  notes: [
    "Inventory and commands without both --yes and --expect-plan are read-only previews.",
    "Apply repeats the complete inventory under a repair lock and refuses a changed plan.",
    "Recovery prune may remove the explicitly selected eligible handle after a verified backup; it never changes unrelated handles.",
  ],
  verification: ["stn repair inventory --json"],
  children: [
    {
      name: "inventory",
      description: "Print coherent redacted runtime and recovery inventory.",
      usage: ["stn repair inventory [--json]"],
      options: [{ name: "--json", description: "Print the strict inventory contract." }],
    },
    {
      name: "terminal",
      description: "Preview or apply exact terminal repair.",
      children: [
        {
          name: "reap",
          description: "Reap one exact Host-owned terminal process group.",
          usage: [
            "stn repair terminal reap --terminal <terminalTargetId> [--json] [--yes --expect-plan <sha256>]",
          ],
          options: [
            {
              name: "--terminal <terminalTargetId>",
              description: "Select one exact Station terminal.",
            },
            ...applyOptions,
          ],
        },
      ],
    },
    {
      name: "observer",
      description: "Preview or apply stale Observer evidence cleanup.",
      children: [
        {
          name: "cleanup",
          description: "Delegate stale evidence cleanup to Observer lifecycle policy.",
          usage: ["stn repair observer cleanup [--json] [--yes --expect-plan <sha256>]"],
          options: applyOptions,
        },
      ],
    },
    {
      name: "recovery",
      description: "Preview or apply exact recovery-handle repair.",
      children: [
        {
          name: "resume",
          description: "Resume one exact eligible recovery handle after backup.",
          usage: [
            "stn repair recovery resume --handle <recoveryHandleId> [--json] [--yes --expect-plan <sha256>]",
          ],
          options: [
            {
              name: "--handle <recoveryHandleId>",
              description: "Select one opaque Station handle.",
            },
            ...applyOptions,
          ],
        },
        {
          name: "prune",
          description: "Delete one exact eligible recovery handle after backup.",
          usage: [
            "stn repair recovery prune --handle <recoveryHandleId> [--json] [--yes --expect-plan <sha256>]",
          ],
          options: [
            {
              name: "--handle <recoveryHandleId>",
              description: "Select one opaque Station handle.",
            },
            ...applyOptions,
          ],
        },
      ],
    },
  ],
};

async function runRepairCliCommand(context: CliCommandRunContext) {
  if (context.options.repairDeps !== undefined) {
    return runRepairCommand(context.args, context.options.repairDeps);
  }
  const loaded = loadedConfigCommandOptions(context);
  const providerOptions: Parameters<typeof createProviderRegistry>[1] = {};
  if (loaded.configPath !== undefined) providerOptions.configPath = loaded.configPath;
  if (loaded.providerHookIngressLauncher !== undefined) {
    providerOptions.providerHookIngressLauncher = loaded.providerHookIngressLauncher;
  }
  if (loaded.providerHookArtifactOwner !== undefined) {
    providerOptions.providerHookArtifactOwner = loaded.providerHookArtifactOwner;
  }
  return runRepairCommand(
    context.args,
    createRepairExecutionDeps({
      config: loaded.config,
      ...(loaded.configPath === undefined ? {} : { configPath: loaded.configPath }),
      currentBuildInfo: stationBuildInfo(),
      providers: createProviderRegistry(loaded.config, providerOptions),
      ...(context.options.hostDeps === undefined ? {} : { hostDeps: context.options.hostDeps }),
    }),
  );
}

import { loadedConfigCommandOptions } from "../cliCommand/helpers.js";
import type { CliCommandNode, CliCommandRunContext } from "../cliCommand/types.js";
import { runRepairCommand } from "../repair/index.js";

export const repairCliCommand: CliCommandNode = {
  name: "repair",
  description: "Inventory read-only repair evidence and preview-only runtime or recovery repairs.",
  requiresConfig: true,
  run: runRepairCliCommand,
  usage: [
    "stn repair inventory [--json]",
    "stn repair runtime --dry-run --expect-inventory <sha256> --target <target-key>... [--json]",
    "stn repair recovery --dry-run --expect-inventory <sha256> --session <id> [--keep-handle <id>] [--prune-handle <id>...] [--json]",
  ],
  options: [
    { name: "--json", description: "Print the strict schema-version-1 result as JSON." },
    { name: "--dry-run", description: "Required for runtime and recovery previews." },
    {
      name: "--expect-inventory <sha256>",
      description: "Require the exact freshly captured inventory digest.",
    },
    { name: "--target <key>", description: "Select an exact runtime target; repeatable." },
    { name: "--session <id>", description: "Select one retained Station session." },
    { name: "--keep-handle <id>", description: "Explicitly preserve one viable handle." },
    { name: "--prune-handle <id>", description: "Preview pruning one handle; repeatable." },
  ],
  examples: [
    "stn repair inventory --json",
    "stn repair runtime --dry-run --expect-inventory <sha256> --target <target-key> --json",
    "stn repair recovery --dry-run --expect-inventory <sha256> --session <id> --keep-handle <id> --json",
  ],
  notes: [
    "Repair inventory never starts or reconciles Observer and never starts, hands off, or closes Host.",
    "Runtime and recovery are preview-only; --yes, --force, and --expect-plan are rejected.",
    "Inventory target keys aid selection but never authorize mutation; future apply must revalidate exact identity.",
  ],
  verification: ["stn repair inventory --json"],
};

async function runRepairCliCommand(context: CliCommandRunContext) {
  const loaded = loadedConfigCommandOptions(context);
  return runRepairCommand(
    context.args,
    {
      config: loaded.config,
      ...(loaded.configPath === undefined ? {} : { configPath: loaded.configPath }),
    },
    context.options.repairDeps,
  );
}

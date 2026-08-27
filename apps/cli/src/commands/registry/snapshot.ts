import { loadedCommandOptions } from "../cliCommand/helpers.js";
import type { CliCommandNode, CliCommandRunContext } from "../cliCommand/types.js";
import { runSnapshotCommand } from "../snapshot.js";

export const snapshotCliCommand: CliCommandNode = {
  name: "snapshot",
  description: "Print the current observer graph snapshot.",
  requiresConfig: true,
  run: runSnapshotCliCommand,
  usage: ["stn snapshot [--json] [--include-debug] [--require-running]"],
  options: [
    { name: "--json", description: "Print the raw snapshot JSON." },
    {
      name: "--include-debug",
      description: "Include the latest reconciled diagnostic evidence.",
    },
    {
      name: "--require-running",
      description: "Refuse instead of starting a missing Observer.",
    },
  ],
  examples: ["stn snapshot --json --include-debug --require-running"],
};

async function runSnapshotCliCommand(context: CliCommandRunContext) {
  const result = await runSnapshotCommand(
    context.args,
    loadedCommandOptions(context),
    context.options.observerDeps,
  );
  return { code: 0, output: result };
}

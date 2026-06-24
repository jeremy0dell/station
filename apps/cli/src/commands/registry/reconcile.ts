import { loadedCommandOptions } from "../cliCommand/helpers.js";
import type { CliCommandNode, CliCommandRunContext } from "../cliCommand/types.js";
import { runReconcileCommand } from "../reconcile.js";

export const reconcileCliCommand: CliCommandNode = {
  name: "reconcile",
  description: "Request an immediate observer reconcile.",
  requiresConfig: true,
  run: runReconcileCliCommand,
  usage: ["stn reconcile [--reason <reason>]"],
  options: [{ name: "--reason <reason>", description: "Annotate the reconcile request." }],
  examples: ["pnpm stn reconcile --reason manual-smoke"],
};

async function runReconcileCliCommand(context: CliCommandRunContext) {
  const result = await runReconcileCommand(
    context.args,
    loadedCommandOptions(context),
    context.options.observerDeps,
  );
  return { code: 0, output: result };
}

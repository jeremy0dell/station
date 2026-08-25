import { loadedCommandOptions } from "../cliCommand/helpers.js";
import type { CliCommandNode, CliCommandRunContext } from "../cliCommand/types.js";
import { runSessionCommand } from "../session.js";

const sessionExamples = ["stn session current"] as const;
const sessionNotes = [
  "Current validates the invoking terminal's live topology and returns a placement source as strict JSON.",
  "Normal execution loads configuration and may start or contact the Observer.",
  "tmux is currently the only placement-capable terminal provider.",
  "The returned source is short-lived, one-shot bearer input for raw sibling session.create or session.fork dispatch through stn command dispatch --stdin --wait; do not persist or log it.",
  "Detached placement is source-free and does not use stn session current.",
] as const;

export const sessionCliCommand: CliCommandNode = {
  name: "session",
  description: "Resolve verified context for the invoking terminal.",
  requiresConfig: true,
  run: runSessionCliCommand,
  usage: ["stn session current"],
  examples: sessionExamples,
  notes: sessionNotes,
  children: [
    {
      name: "current",
      description: "Print the verified invoking terminal context as JSON.",
      usage: ["stn session current"],
      examples: sessionExamples,
      notes: sessionNotes,
    },
  ],
};

async function runSessionCliCommand(context: CliCommandRunContext) {
  const result = await runSessionCommand(
    context.args,
    { ...loadedCommandOptions(context), ...context.options.sessionDeps },
    context.options.observerDeps,
  );
  return { code: 0, output: result };
}

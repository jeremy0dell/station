import { loadedConfigCommandOptions } from "../cliCommand/helpers.js";
import type { CliCommandNode, CliCommandRunContext } from "../cliCommand/types.js";
import { hostCommandSummary, runHostCommand } from "../host/index.js";

export const hostCliCommand: CliCommandNode = {
  name: "host",
  description: "Inspect or opt into live Station host upgrade handoff.",
  requiresConfig: true,
  run: runHostCliCommand,
  usage: ["stn host status", "stn host handoff [--dry-run] [--fidelity processes|screen]"],
  options: [
    {
      name: "--dry-run",
      description: "Plan a live handoff without parking bridges or spawning a successor.",
    },
    {
      name: "--fidelity processes|screen",
      description: "Handoff fidelity; screen degrades to processes when capture fails.",
    },
  ],
  examples: [
    "pnpm stn host status",
    "pnpm stn host handoff --dry-run",
    "pnpm stn host handoff --fidelity screen",
  ],
  children: [
    {
      name: "status",
      description: "Report host health, compatibility, and handoff eligibility.",
      usage: ["stn host status"],
      examples: ["pnpm stn host status"],
    },
    {
      name: "handoff",
      description: "Opt into live PTY ownership transfer to this Station build.",
      usage: ["stn host handoff [--dry-run] [--fidelity processes|screen]"],
      options: [
        {
          name: "--dry-run",
          description: "Plan without mutating the incumbent host.",
        },
        {
          name: "--fidelity processes|screen",
          description: "Transfer fidelity level.",
        },
      ],
      examples: ["pnpm stn host handoff --dry-run"],
    },
  ],
};

async function runHostCliCommand(context: CliCommandRunContext) {
  const options = loadedConfigCommandOptions(context);
  try {
    const result = await runHostCommand(context.args, options, context.options.hostDeps);
    const failed =
      (result.action === "handoff" &&
        (result.status === "refused" || result.status === "unavailable")) ||
      (result.action === "status" && result.probe !== "listening");
    return { code: failed ? 1 : 0, output: hostCommandSummary(result) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { code: 2, output: `${message}\n` };
  }
}

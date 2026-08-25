import { loadedCommandOptions } from "../cliCommand/helpers.js";
import type { CliCommandNode, CliCommandRunContext } from "../cliCommand/types.js";
import {
  observerCommandSummary,
  parseObserverCommandAction,
  runObserverCommand,
} from "../observer.js";

export const observerCliCommand: CliCommandNode = {
  name: "observer",
  description: "Start, stop, or inspect the local observer process.",
  requiresConfig: true,
  run: runObserverCliCommand,
  usage: [
    "stn observer start",
    "stn observer ensure-exact-build",
    "stn observer status",
    "stn observer stop",
    "stn observer restart",
    "stn observer reap [--force]",
  ],
  options: [
    {
      name: "--timeout-ms <ms>",
      description: "Override observer startup or health timeout where supported.",
    },
  ],
  examples: ["stn observer status", "stn observer start"],
  children: [
    {
      name: "start",
      description: "Start the observer and wait for health.",
      usage: ["stn observer start [--timeout-ms <ms>]"],
      options: [{ name: "--timeout-ms <ms>", description: "Override the startup health timeout." }],
      examples: ["stn observer start"],
    },
    {
      name: "ensure-exact-build",
      description:
        "Reuse or cooperatively replace the configured Observer so its immutable build exactly matches this CLI.",
      usage: ["stn observer ensure-exact-build [--timeout-ms <ms>]"],
      options: [{ name: "--timeout-ms <ms>", description: "Override the activation timeout." }],
      examples: ["stn observer ensure-exact-build"],
    },
    {
      name: "status",
      description: "Report observer process availability.",
      usage: ["stn observer status"],
      examples: ["stn observer status"],
    },
    {
      name: "stop",
      description: "Stop the observer for the configured socket.",
      usage: ["stn observer stop"],
      examples: ["stn observer stop"],
    },
    {
      name: "restart",
      description: "Replace or start the Observer through build-precedence lifecycle policy.",
      usage: ["stn observer restart [--timeout-ms <ms>]"],
      options: [{ name: "--timeout-ms <ms>", description: "Override the startup health timeout." }],
      examples: ["stn observer restart"],
    },
    {
      name: "reap",
      description:
        "Inspect duplicate processes and automatic-eligibility checks; --force explicitly permits SIGTERM then SIGKILL.",
      usage: ["stn observer reap [--force]"],
      options: [
        {
          name: "--force",
          description: "Revalidate and terminate duplicates, escalating to SIGKILL if needed.",
        },
      ],
      examples: ["stn observer reap", "stn observer reap --force"],
    },
  ],
};

async function runObserverCliCommand(context: CliCommandRunContext) {
  const result = await runObserverCommand(
    context.args,
    loadedCommandOptions(context),
    context.options.observerDeps,
  );
  const action = parseObserverCommandAction(context.args);
  const failedStart =
    (action === "start" || action === "restart" || action === "ensure-exact-build") &&
    "status" in result &&
    result.status !== "running";
  return { code: failedStart ? 1 : 0, output: observerCommandSummary(result) };
}

import {
  projectStationHostCrossoverError,
  type StationHostUpdateCrossoverResult,
  StationHostUpdateCrossoverResultSchema,
} from "@station/contracts";
import { stationHostSafeError } from "@station/host";
import { safeErrorFromUnknown } from "@station/runtime";
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
  examples: ["stn host status", "stn host handoff --dry-run", "stn host handoff --fidelity screen"],
  children: [
    {
      name: "status",
      description: "Report host health, compatibility, and handoff eligibility.",
      usage: ["stn host status"],
      examples: ["stn host status"],
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
      examples: ["stn host handoff --dry-run"],
    },
  ],
};

async function runHostCliCommand(context: CliCommandRunContext) {
  const options = loadedConfigCommandOptions(context);
  const updateCrossover = context.args.includes("--update-crossover");
  try {
    const result = await runHostCommand(context.args, options, context.options.hostDeps);
    const failed =
      (result.action === "handoff" &&
        (result.status === "refused" || result.status === "unavailable")) ||
      (result.action === "status" && (result.probe !== "listening" || result.error !== undefined));
    if (updateCrossover) {
      const crossover: StationHostUpdateCrossoverResult =
        result.action === "handoff" && result.status === "completed"
          ? { schemaVersion: 1, status: "completed" }
          : {
              schemaVersion: 1,
              status: "failed",
              error: projectStationHostCrossoverError(
                result.action === "handoff" && result.error !== undefined
                  ? result.error
                  : stationHostSafeError(
                      "HOST_REQUEST_FAILED",
                      result.action === "handoff" ? result.message : "Host crossover failed.",
                    ),
              ),
              ...(result.action === "handoff" && result.convergenceFailure !== undefined
                ? { convergenceFailure: result.convergenceFailure }
                : {}),
            };
      return {
        code: crossover.status === "completed" ? 0 : 1,
        output: `${JSON.stringify(StationHostUpdateCrossoverResultSchema.parse(crossover))}\n`,
        outputFormat: "text" as const,
      };
    }
    return {
      code: failed ? 1 : 0,
      output: hostCommandSummary(result),
      outputFormat: "text" as const,
    };
  } catch (error) {
    const normalized = safeErrorFromUnknown(error, {
      tag: "HostCommandError",
      code: "HOST_COMMAND_FAILED",
      message: "Host command failed.",
    });
    if (updateCrossover) {
      const crossover: StationHostUpdateCrossoverResult = {
        schemaVersion: 1,
        status: "failed",
        error: projectStationHostCrossoverError(normalized),
      };
      return {
        code: 1,
        output: `${JSON.stringify(StationHostUpdateCrossoverResultSchema.parse(crossover))}\n`,
        outputFormat: "text" as const,
      };
    }
    return {
      code: 2,
      output: `${normalized.message}\n`,
      outputFormat: "text" as const,
    };
  }
}

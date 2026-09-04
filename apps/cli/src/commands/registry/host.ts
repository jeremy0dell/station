import { stationHostSocketPath } from "@station/config";
import {
  type HostHandoffFidelity,
  projectStationHostUpdateCrossoverError,
  type StationHostConvergenceCommand,
  type StationHostTargetBuild,
  type StationHostUpdateCrossoverResult,
  StationHostUpdateCrossoverResultSchema,
  stationHostEvidenceMatchesTargetBuild,
  stationHostTerminalsAreHandoffEligible,
} from "@station/contracts";
import { stationHostSafeError } from "@station/host";
import { safeErrorFromUnknown, stationBuildInfo } from "@station/runtime";
import {
  convergeStationHost,
  inspectStationHost,
  recoverExactStationHostOrphans,
} from "@station/terminal";
import { resolveObserverPaths } from "../../paths.js";
import { loadedConfigCommandOptions } from "../cliCommand/helpers.js";
import type { CliCommandNode, CliCommandRunContext } from "../cliCommand/types.js";
import { parseHostArgs } from "../host/args.js";
import {
  type HostCommandDeps,
  hostCommandSummary,
  resolveStationHostCommand,
  runHostCommand,
} from "../host/index.js";

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
    if (updateCrossover) {
      const fidelity = parseUpdateCrossover(context.args);
      await runUpdateHostCrossover(fidelity, options, context.options.hostDeps);
      const result: StationHostUpdateCrossoverResult = {
        schemaVersion: 1,
        status: "completed",
      };
      return {
        code: 0,
        output: `${JSON.stringify(StationHostUpdateCrossoverResultSchema.parse(result))}\n`,
        outputFormat: "text" as const,
      };
    }
    const result = await runHostCommand(context.args, options, context.options.hostDeps);
    const failed =
      (result.action === "handoff" &&
        (result.status === "refused" || result.status === "unavailable")) ||
      (result.action === "status" && (result.probe !== "listening" || result.error !== undefined));
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
    if (!updateCrossover) {
      return {
        code: 2,
        output: `${normalized.message}\n`,
        outputFormat: "text" as const,
      };
    }
    const result: StationHostUpdateCrossoverResult = {
      schemaVersion: 1,
      status: "failed",
      error: projectStationHostUpdateCrossoverError(normalized),
    };
    return {
      code: 1,
      output: `${JSON.stringify(StationHostUpdateCrossoverResultSchema.parse(result))}\n`,
      outputFormat: "text" as const,
    };
  }
}

function parseUpdateCrossover(args: readonly string[]): HostHandoffFidelity {
  if (args.filter((arg) => arg === "--update-crossover").length !== 1) {
    throw new Error("Host update crossover may be selected only once.");
  }
  const parsed = parseHostArgs(args.filter((arg) => arg !== "--update-crossover"));
  if (parsed.action !== "handoff" || parsed.dryRun) {
    throw new Error("Host update crossover requires a non-preview handoff.");
  }
  return parsed.fidelity;
}

async function runUpdateHostCrossover(
  fidelity: HostHandoffFidelity,
  options: ReturnType<typeof loadedConfigCommandOptions>,
  deps: HostCommandDeps = {},
): Promise<void> {
  const targetBuild: StationHostTargetBuild =
    deps.expectedBuildVersion !== undefined && deps.expectedBuildIdentity !== undefined
      ? {
          buildVersion: deps.expectedBuildVersion,
          buildIdentity: deps.expectedBuildIdentity,
        }
      : (() => {
          const build = stationBuildInfo();
          return {
            buildVersion: deps.expectedBuildVersion ?? build.version,
            buildIdentity: deps.expectedBuildIdentity ?? build.buildIdentity,
          };
        })();
  const socketPath = stationHostSocketPath(options.config);
  const stateDir = resolveObserverPaths(options.config).stateDir;
  const deadlineMs = (deps.now ?? Date.now)() + 12_000;
  let selectedHostCommand: readonly [string, ...string[]] | undefined;
  const hostCommand = () => {
    selectedHostCommand ??= deps.resolveHostCommand?.() ?? resolveStationHostCommand();
    return selectedHostCommand;
  };
  const inspection = await (deps.inspectHost ?? inspectStationHost)({
    socketPath,
    expectedBuildVersion: targetBuild.buildVersion,
  });

  if (inspection.status === "inaccessible" || inspection.status === "unknown") {
    throw inspection.error;
  }
  if (
    inspection.status === "exact" &&
    !stationHostEvidenceMatchesTargetBuild(inspection.evidence, targetBuild)
  ) {
    if (
      inspection.evidence.terminals.length > 0 &&
      !stationHostTerminalsAreHandoffEligible(inspection.evidence.terminals)
    ) {
      throw stationHostSafeError(
        "HOST_UPGRADE_BLOCKED",
        "Host terminals are not all eligible for live handoff.",
      );
    }
    const common = {
      targetBuild,
      socketPath,
      expected: inspection.evidence,
      deadlineMs,
    };
    const command: StationHostConvergenceCommand =
      inspection.evidence.terminals.length === 0
        ? { ...common, action: "replace-idle" }
        : { ...common, action: "handoff", fidelity };
    const convergence = await (deps.convergeHost ?? convergeStationHost)({
      command,
      targetBuild,
      socketPath,
      stateDir,
      hostCommand: hostCommand(),
    });
    if (convergence.status === "failed") throw convergence.error;
  }

  await (deps.recoverHostOrphans ?? recoverExactStationHostOrphans)({
    socketPath,
    stateDir,
    targetBuild,
    hostCommand: hostCommand(),
    deadlineMs,
  });
}

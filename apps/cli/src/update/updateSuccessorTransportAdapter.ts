import { UpdateCommandReportSchema } from "@station/contracts";
import { type ExternalCommandRunner, runExternalCommand } from "@station/runtime";
import type { ExecutableArgv } from "../selfExec.js";
import { sanitizePublicUpdateReport } from "./publicUpdateReportAdapter.js";
import type { UpdateCommandArgv } from "./updateChannel.js";
import { updateCommandExitCode } from "./updateCommandStatusPolicy.js";
import type {
  UpdateSuccessorTransportInput,
  UpdateSuccessorTransportPort,
} from "./updateSuccessorTransportPort.js";

export type UpdateSuccessorTransportAdapterOptions = {
  configPath?: string;
  commandRunner?: ExternalCommandRunner;
};

/**
 * ADAPTER
 *
 * Owns pinned successor argv, strict JSON transport, redaction, and child exit consistency.
 */
export function createUpdateSuccessorTransportAdapter(
  options: UpdateSuccessorTransportAdapterOptions,
): UpdateSuccessorTransportPort {
  return {
    run: (input) => runSuccessor(input, options),
  };
}

async function runSuccessor(
  input: UpdateSuccessorTransportInput,
  options: UpdateSuccessorTransportAdapterOptions,
) {
  const command = stationCommand(input.launcher, options.configPath, [
    "update",
    "--channel",
    input.channel,
    "--json",
    "--internal-successor-evaluator",
    "--internal-selected-target-version",
    input.target.version,
    ...(input.target.revision === undefined
      ? []
      : ["--internal-selected-target-revision", input.target.revision]),
    ...(input.handoff === undefined
      ? ["--no-handoff"]
      : input.handoff === "processes"
        ? []
        : [`--handoff=${input.handoff}`]),
  ]);
  const [executable, ...args] = command;
  const result = await runExternalCommand(
    {
      command: executable,
      args,
      timeoutMs: 120_000,
      maxOutputChars: 512 * 1024,
      allowedExitCodes: [1],
    },
    options.commandRunner,
  );
  const report = sanitizePublicUpdateReport(
    UpdateCommandReportSchema.parse(JSON.parse(result.stdout)),
  );
  if (result.exitCode !== updateCommandExitCode(report)) {
    throw new Error("Successor update report contradicted its process exit status.");
  }
  return report;
}

function stationCommand(
  cli: ExecutableArgv,
  configPath: string | undefined,
  operation: string[],
): UpdateCommandArgv {
  const [command, ...prefix] = cli;
  return [
    command,
    ...prefix,
    ...(configPath === undefined ? [] : ["--config", configPath]),
    ...operation,
  ];
}

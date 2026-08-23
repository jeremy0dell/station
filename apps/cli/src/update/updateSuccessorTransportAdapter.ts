import {
  type UpdateArtifact,
  type UpdateCommandReport,
  UpdateCommandReportSchema,
  type UpdateEvidencePlan,
  updateCommandReportStatus,
} from "@station/contracts";
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
 * Owns pinned successor argv, strict JSON transport, exact target-ownership validation, redaction,
 * and child exit consistency.
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
  const parsed = UpdateCommandReportSchema.parse(JSON.parse(result.stdout));
  assertPinnedSuccessorReport(parsed, input);
  const derivedStatus = updateCommandReportStatus(parsed);
  if (
    parsed.status !== derivedStatus ||
    result.exitCode !== updateCommandExitCode({ status: derivedStatus })
  ) {
    throw new Error("Successor update report contradicted its process exit status.");
  }
  return sanitizePublicUpdateReport(parsed);
}

function assertPinnedSuccessorReport(
  report: UpdateCommandReport,
  input: UpdateSuccessorTransportInput,
): void {
  if (report.channel !== input.channel) {
    throw new Error("Successor update report did not retain the selected update channel.");
  }
  if (
    !artifactsMatch(report.current, input.target) ||
    !artifactsMatch(report.target, input.target)
  ) {
    throw new Error("Successor update report did not retain the installed pinned target.");
  }

  const evidence = successorEvidence(report);
  let buildIdentity: string | undefined;
  for (const entry of evidence) {
    if (
      entry.evidence.evaluator !== "successor-cli" ||
      !artifactsMatch(entry.evidence.preflight.installed, input.target) ||
      !artifactsMatch(entry.evidence.preflight.target, input.target) ||
      !artifactsMatch(entry.evidence.plan.selectedTarget.artifact, input.target) ||
      entry.evidence.plan.selectedTarget.buildIdentity.status !== "known"
    ) {
      throw new Error(`Successor ${entry.name} did not retain exact target-owned evidence.`);
    }
    const evidenceBuildIdentity = entry.evidence.plan.selectedTarget.buildIdentity.value;
    if (buildIdentity !== undefined && evidenceBuildIdentity !== buildIdentity) {
      throw new Error(
        "Successor update evidence contradicted its immutable target build identity.",
      );
    }
    buildIdentity = evidenceBuildIdentity;
  }

  switch (report.result.kind) {
    case "already-converged":
    case "non-mutating-stop":
    case "current-runtime-execution":
      if (report.artifactApplication.status !== "not-required") {
        throw new Error("Successor convergence cannot apply or defer another artifact.");
      }
      return;
    case "execution-failed":
      if (
        report.artifactApplication.status !== "not-required" ||
        report.result.stage === "artifact-application" ||
        report.result.stage === "successor-boundary" ||
        report.result.successor !== undefined
      ) {
        throw new Error("Successor failure report crossed another artifact or successor boundary.");
      }
      return;
    case "preview":
    case "deferred":
    case "successor-runtime-execution":
      throw new Error(
        "Successor update returned a result kind forbidden at the internal boundary.",
      );
  }
}

function successorEvidence(
  report: UpdateCommandReport,
): Array<{ name: string; evidence: UpdateEvidencePlan }> {
  const evidence = [{ name: "initial plan", evidence: report.initial }];
  switch (report.result.kind) {
    case "current-runtime-execution":
      evidence.push({ name: "post-action plan", evidence: report.result.postAction });
      break;
    case "successor-runtime-execution":
      evidence.push(
        { name: "nested successor plan", evidence: report.result.successor },
        { name: "post-action plan", evidence: report.result.postAction },
      );
      break;
    case "execution-failed":
      if (report.result.successor !== undefined) {
        evidence.push({ name: "nested successor plan", evidence: report.result.successor });
      }
      if (report.result.finalInspection.status === "completed") {
        evidence.push({
          name: "final inspection",
          evidence: report.result.finalInspection.evidence,
        });
      }
      break;
    case "already-converged":
    case "preview":
    case "deferred":
    case "non-mutating-stop":
      break;
  }
  return evidence;
}

function artifactsMatch(left: UpdateArtifact, right: UpdateArtifact): boolean {
  return left.version === right.version && left.revision === right.revision;
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

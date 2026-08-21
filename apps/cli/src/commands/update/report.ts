import type {
  ObserverLifecycleFailure,
  UpdateCommandArgv,
  UpdateCommandReport,
  UpdateCommandStep,
  UpdateCommandStepStatus,
} from "@station/contracts";
import { publicSafeErrorFromUnknown, shellQuote } from "@station/runtime";
import type { CliRunResult } from "../../cliTypes.js";
import type { PlannedUpdateChannel } from "../../update/channelDetection.js";
import type { UpdateRequest } from "./args.js";
import type { HostHandoffScenario, UpdateScenario } from "./scenario.js";

export type { UpdateCommandReport, UpdateCommandStep } from "@station/contracts";

const updateFailureFallback = {
  tag: "UpdateError",
  code: "UPDATE_FAILED",
  message: "Station update failed.",
} as const;

function artifact(version: string, revision: string | undefined) {
  return { version, ...(revision === undefined ? {} : { revision }) };
}

function hostHandoffDetail(hostHandoff: HostHandoffScenario): string {
  return hostHandoff.kind === "not-requested"
    ? "Host handoff was explicitly disabled."
    : "No live Host handoff is needed.";
}

function previewApplyStep(
  scenario: Extract<UpdateScenario, { kind: "preview" }>,
): UpdateCommandStep {
  if (scenario.mutation.kind === "defer-to-package-manager") {
    return updateStep(
      "apply",
      "deferred",
      "The package manager owns mutation; rerun with --drive-package-manager to execute it.",
      scenario.mutation.managerCommand,
    );
  }
  return updateStep(
    "apply",
    "planned",
    "The selected channel would apply the planned update.",
    scenario.mutation.managerCommand,
  );
}

function previewObserverRestartStep(
  scenario: Extract<UpdateScenario, { kind: "preview" }>,
): UpdateCommandStep {
  if (scenario.mutation.kind === "apply") {
    return updateStep(
      "observer-restart",
      "planned",
      "The new launcher would restart the Observer.",
    );
  }
  return updateStep("observer-restart", "skipped", "No Station build would be installed.");
}

function previewHookReconciliationStep(
  scenario: Extract<UpdateScenario, { kind: "preview" }>,
): UpdateCommandStep {
  if (scenario.mutation.kind === "apply") {
    return updateStep(
      "hook-reconciliation",
      "planned",
      "The selected launcher would verify and repair configured provider hooks.",
    );
  }
  return updateStep("hook-reconciliation", "skipped", "No Station build would be installed.");
}

function previewHostHandoffStep(hostHandoff: HostHandoffScenario): UpdateCommandStep {
  if (hostHandoff.kind === "handoff") {
    return updateStep(
      "host-handoff",
      "planned",
      `The new launcher would hand off ${hostHandoff.fidelity} state.`,
    );
  }
  return updateStep("host-handoff", "skipped", hostHandoffDetail(hostHandoff));
}

function updatedHostHandoffStep(hostHandoff: HostHandoffScenario): UpdateCommandStep {
  if (hostHandoff.kind === "handoff") {
    return updateStep(
      "host-handoff",
      "completed",
      `The Host completed ${hostHandoff.fidelity} handoff.`,
    );
  }
  return updateStep("host-handoff", "skipped", hostHandoffDetail(hostHandoff));
}

function artifactText(value: UpdateCommandReport["current"]): string {
  return value.revision === undefined ? value.version : `${value.version} (${value.revision})`;
}

function formatCommand(command: readonly string[]): string {
  return command.map((value) => shellQuote(value)).join(" ");
}

export function createUpdateReport(selected: PlannedUpdateChannel): UpdateCommandReport {
  return {
    schemaVersion: 2,
    channel: selected.channel,
    status: "planned",
    current: artifact(selected.plan.currentVersion, selected.plan.currentRevision),
    target: artifact(selected.plan.targetVersion, selected.plan.targetRevision),
    steps: [
      updateStep("detect", "completed", `Detected ${selected.channel} ownership.`),
      updateStep("plan", "completed", "Resolved the current and target Station builds."),
    ],
    warnings: [],
    recoveryCommands: [],
  };
}

export function currentUpdateResult(
  report: UpdateCommandReport,
  output: UpdateRequest["output"],
): CliRunResult {
  report.status = "current";
  report.steps.push(
    updateStep("observer-restart", "skipped", "No build changed."),
    updateStep("host-handoff", "skipped", "No build changed."),
  );
  return updateCommandResult(report, output);
}

export function previewUpdateResult(
  report: UpdateCommandReport,
  scenario: Extract<UpdateScenario, { kind: "preview" }>,
  output: UpdateRequest["output"],
): CliRunResult {
  report.status = "planned";
  report.steps.push(
    previewApplyStep(scenario),
    previewHookReconciliationStep(scenario),
    previewObserverRestartStep(scenario),
    previewHostHandoffStep(scenario.hostHandoff),
  );
  return updateCommandResult(report, output);
}

export function deferredUpdateResult(
  report: UpdateCommandReport,
  managerCommand: UpdateCommandArgv | undefined,
  output: UpdateRequest["output"],
): CliRunResult {
  report.status = "deferred";
  report.steps.push(
    updateStep(
      "apply",
      "deferred",
      "The package manager owns mutation and no manager command was executed.",
      managerCommand,
    ),
    updateStep("hook-reconciliation", "skipped", "No Station build was installed."),
    updateStep("observer-restart", "skipped", "No Station build was installed."),
    updateStep("host-handoff", "skipped", "No Station build was installed."),
  );
  return updateCommandResult(report, output);
}

export function updatedUpdateResult(
  report: UpdateCommandReport,
  hostHandoff: HostHandoffScenario,
  output: UpdateRequest["output"],
): CliRunResult {
  report.steps.push(updatedHostHandoffStep(hostHandoff));
  report.status = "updated";
  return updateCommandResult(report, output);
}

export function failedUpdateResult(
  report: UpdateCommandReport,
  phase: UpdateCommandStep["id"],
  error: unknown,
  recoveryCommands: readonly UpdateCommandArgv[],
  output: UpdateRequest["output"],
  lifecycleFailure?: ObserverLifecycleFailure,
): CliRunResult {
  const safeError = publicSafeErrorFromUnknown(error, updateFailureFallback);
  report.status = "failed";
  report.error = safeError;
  if (lifecycleFailure !== undefined) {
    report.cause = lifecycleFailure.cause ?? lifecycleFailure.error;
    if (lifecycleFailure.startupEvidence !== undefined) {
      report.startupEvidence = lifecycleFailure.startupEvidence;
    }
  }
  report.recoveryCommands.push(...recoveryCommands);
  report.steps.push(updateStep(phase, "failed", safeError.message, recoveryCommands[0]));
  if (phase === "apply") {
    report.steps.push(
      updateStep("hook-reconciliation", "skipped", "The update did not install a build."),
      updateStep("observer-restart", "skipped", "The update did not reach runtime crossover."),
      updateStep("host-handoff", "skipped", "The update did not reach runtime crossover."),
    );
  } else if (phase === "hook-reconciliation") {
    report.steps.push(
      updateStep("observer-restart", "skipped", "Hook reconciliation failed first."),
      updateStep("host-handoff", "skipped", "Hook reconciliation failed first."),
    );
  } else if (phase === "observer-restart") {
    report.steps.push(updateStep("host-handoff", "skipped", "Observer crossover failed first."));
  }
  return updateCommandResult(report, output);
}

export function updateStep(
  id: UpdateCommandStep["id"],
  status: UpdateCommandStepStatus,
  detail: string,
  command?: UpdateCommandArgv,
): UpdateCommandStep {
  return { id, status, detail, ...(command === undefined ? {} : { command }) };
}

export function updateCommandResult(
  report: UpdateCommandReport,
  output: UpdateRequest["output"],
): CliRunResult {
  const json = output === "json";
  return {
    code: report.status === "failed" ? 1 : 0,
    output: json ? report : renderUpdateReport(report),
    ...(json ? {} : { outputFormat: "text" as const }),
  };
}

function renderUpdateReport(report: UpdateCommandReport): string {
  const lines = [
    `channel: ${report.channel}`,
    `status: ${report.status}`,
    `current: ${artifactText(report.current)}`,
    `target: ${artifactText(report.target)}`,
    "steps:",
  ];
  for (const item of report.steps) {
    lines.push(`  ${item.id}: ${item.status} - ${item.detail}`);
    if (item.command !== undefined) lines.push(`    ${formatCommand(item.command)}`);
  }
  for (const warning of report.warnings) lines.push(`warning: ${warning.message}`);
  if (report.hookReconciliation !== undefined) {
    lines.push(`hooks: ${report.hookReconciliation.status}`);
  }
  if (report.error !== undefined)
    lines.push(`error: ${report.error.message} (${report.error.code})`);
  if (report.cause !== undefined)
    lines.push(`cause: ${report.cause.message} (${report.cause.code})`);
  if (report.startupEvidence !== undefined) {
    lines.push(`observer boot log: ${report.startupEvidence.bootLogPath}`);
  }
  if (report.recoveryCommands.length > 0) {
    lines.push("recovery:");
    for (const command of report.recoveryCommands) lines.push(`  ${formatCommand(command)}`);
  }
  return `${lines.join("\n")}\n`;
}

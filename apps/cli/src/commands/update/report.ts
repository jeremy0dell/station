import {
  type ObserverLifecycleFailure,
  parseUpdateCommandReport,
  projectPublicUpdateReport,
  type UpdateCommandArgv,
  type UpdateCommandReport,
  type UpdateCommandStep,
  type UpdateCommandStepStatus,
  type UpdateReapRecoveryHandleResolution,
} from "@station/contracts";
import { publicSafeErrorFromUnknown, shellQuote } from "@station/runtime";
import type { CliRunResult } from "../../cliTypes.js";
import { escapeTerminalBytes } from "../../terminalOutput.js";
import type { PlannedUpdateChannel } from "../../update/channelDetection.js";
import type { UpdateRequest } from "./args.js";
import type { HostHandoffScenario } from "./scenario.js";

export type { UpdateCommandReport, UpdateCommandStep } from "@station/contracts";

const updateFailureFallback = {
  tag: "UpdateError",
  code: "UPDATE_FAILED",
  message: "Station update failed.",
} as const;

type UpdateCommandResultReport = Extract<UpdateCommandReport, { kind: "result" }>;
type UpdateCommandPreviewReport = Extract<UpdateCommandReport, { kind: "preview" }>;
export type UpdateCommandResultDraft = Omit<UpdateCommandResultReport, "status">;
type PreviewPhases = UpdateCommandPreviewReport["plan"]["phases"];

function artifact(version: string, revision: string | undefined) {
  return { version, ...(revision === undefined ? {} : { revision }) };
}

function hostHandoffDetail(hostHandoff: HostHandoffScenario): string {
  return hostHandoff.kind === "not-requested"
    ? "Host handoff was explicitly disabled."
    : "No live Host handoff is needed.";
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
  return value.revision === undefined
    ? escapeTerminalBytes(value.version)
    : `${escapeTerminalBytes(value.version)} (${escapeTerminalBytes(value.revision)})`;
}

function formatCommand(command: readonly string[]): string {
  return command.map((value) => shellQuote(escapeTerminalBytes(value))).join(" ");
}

export function createUpdateReport(selected: PlannedUpdateChannel): UpdateCommandResultDraft {
  return {
    schemaVersion: 4,
    kind: "result",
    channel: selected.channel,
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
  report: UpdateCommandResultDraft,
  hostHandoff: HostHandoffScenario,
  output: UpdateRequest["output"],
): CliRunResult {
  report.steps.push(updatedHostHandoffStep(hostHandoff));
  return updateCommandResult({ ...report, status: "current" }, output);
}

export function deferredUpdateResult(
  report: UpdateCommandResultDraft,
  managerCommand: UpdateCommandArgv | undefined,
  output: UpdateRequest["output"],
): CliRunResult {
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
  return updateCommandResult({ ...report, status: "deferred" }, output);
}

export function updatedUpdateResult(
  report: UpdateCommandResultDraft,
  hostHandoff: HostHandoffScenario,
  output: UpdateRequest["output"],
): CliRunResult {
  report.steps.push(updatedHostHandoffStep(hostHandoff));
  return updateCommandResult({ ...report, status: "updated" }, output);
}

export function failedUpdateResult(
  report: UpdateCommandResultDraft,
  phase: UpdateCommandStep["id"],
  error: unknown,
  recoveryCommands: readonly UpdateCommandArgv[],
  output: UpdateRequest["output"],
  lifecycleFailure?: ObserverLifecycleFailure,
): CliRunResult {
  const safeError = publicSafeErrorFromUnknown(error, updateFailureFallback);
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
  return updateCommandResult({ ...report, status: "failed" }, output);
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
  report: UpdateCommandResultReport,
  output: UpdateRequest["output"],
): CliRunResult {
  const parsed = parseUpdateCommandReport(
    projectPublicUpdateReport(report),
  ) as UpdateCommandResultReport;
  const json = output === "json";
  return {
    code: parsed.status === "failed" ? 1 : 0,
    output: json ? parsed : renderUpdateReport(parsed),
    ...(json ? {} : { outputFormat: "text" as const }),
  };
}

export function previewUpdateCommandResult(
  report: UpdateCommandPreviewReport,
  output: UpdateRequest["output"],
): CliRunResult {
  const parsed = parseUpdateCommandReport(report) as UpdateCommandPreviewReport;
  const json = output === "json";
  return {
    code: parsed.plan.outcome === "blocked" || parsed.plan.outcome === "reap-required" ? 1 : 0,
    output: json ? parsed : renderUpdateConvergenceReportText(parsed),
    ...(json ? {} : { outputFormat: "text" as const }),
  };
}

function renderUpdateReport(report: UpdateCommandResultReport): string {
  const lines = [
    `channel: ${escapeTerminalBytes(report.channel)}`,
    `status: ${escapeTerminalBytes(report.status)}`,
    `current: ${artifactText(report.current)}`,
    `target: ${artifactText(report.target)}`,
    "steps:",
  ];
  for (const item of report.steps) {
    lines.push(`  ${item.id}: ${item.status} - ${escapeTerminalBytes(item.detail)}`);
    if (item.command !== undefined) lines.push(`    ${formatCommand(item.command)}`);
  }
  for (const warning of report.warnings)
    lines.push(`warning: ${escapeTerminalBytes(warning.message)}`);
  if (report.hookReconciliation !== undefined) {
    lines.push(`hooks: ${escapeTerminalBytes(report.hookReconciliation.status)}`);
  }
  if (report.error !== undefined)
    lines.push(
      `error: ${escapeTerminalBytes(report.error.message)} (${escapeTerminalBytes(report.error.code)})`,
    );
  if (report.cause !== undefined)
    lines.push(
      `cause: ${escapeTerminalBytes(report.cause.message)} (${escapeTerminalBytes(report.cause.code)})`,
    );
  if (report.startupEvidence !== undefined) {
    lines.push(`observer boot log: ${escapeTerminalBytes(report.startupEvidence.bootLogPath)}`);
  }
  if (report.recoveryCommands.length > 0) {
    lines.push("recovery:");
    for (const command of report.recoveryCommands) lines.push(`  ${formatCommand(command)}`);
  }
  return `${lines.join("\n")}\n`;
}

const previewOutcomeText = {
  converged: "no-op (converged)",
  actionable: "safe actionable convergence",
  deferred: "deferred to package manager",
  "reap-required": "reap required; no recovery attempted",
  "intentionally-incomplete": "intentionally incomplete (--no-handoff)",
  blocked: "blocked",
} as const satisfies Record<UpdateCommandPreviewReport["plan"]["outcome"], string>;

export function renderUpdateConvergenceReportText(report: UpdateCommandPreviewReport): string {
  const { plan } = report;
  const providers = plan.phases.hookReconciliation.providers
    .map(
      (provider) =>
        `${escapeTerminalBytes(provider.provider)}=${provider.action}/${provider.reason}`,
    )
    .join(", ");
  const lines = [
    "update dry run (No actions executed)",
    `channel: ${escapeTerminalBytes(report.channel)}`,
    `outcome: ${previewOutcomeText[plan.outcome]}`,
    `current: ${artifactText(report.current)}`,
    `target: ${artifactText(report.target)}`,
    artifactPhaseText(plan.phases.artifactApplication),
    `${phaseText("hooks", plan.phases.hookReconciliation)}${providers ? `; ${providers}` : ""}`,
    phaseText("Observer", plan.phases.observerConvergence),
    hostPhaseText(plan.phases.hostConvergence),
    terminalPhaseText(plan.phases.terminalConvergence),
    recoveryText(report),
    phaseText("reconcile", plan.phases.persistedStateReconcile),
    phaseText("verification", plan.phases.finalVerification),
  ];
  return `${lines.join("\n")}\n`;
}

function recoveryText(report: UpdateCommandPreviewReport): string {
  const { initial } = report;
  const lines = [
    `recovery: evidence=${initial.evidenceComplete ? "complete" : "incomplete"}; authorization=none`,
  ];
  if (initial.terminalDispositions.length === 0) {
    const consequence =
      initial.host.status === "unknown"
        ? "unknown (Host inventory unavailable)"
        : `none${initial.host.status === "absent" ? " (Host absent)" : ""}`;
    lines.push(`  terminals: ${consequence}`);
  }
  for (const terminal of initial.terminalDispositions) {
    lines.push(
      `  terminal ${escapeTerminalBytes(terminal.terminalTargetId)} pty=${escapeTerminalBytes(terminal.ptyId)}/${escapeTerminalBytes(terminal.ptyInstanceId)} session=${escapeTerminalBytes(terminal.sessionId)} handoff=${terminal.handoff} reap=${terminal.reapRecovery}`,
    );
    if (terminal.reasons.length > 0) lines.push(`    reasons: ${terminal.reasons.join(", ")}`);
  }
  if (initial.observer.status !== "exact" || initial.observer.recovery.status !== "assessed") {
    lines.push("  sessions: unknown");
  } else {
    const assessment = initial.observer.recovery.assessment;
    if (assessment.sessions.length === 0) lines.push("  sessions: none retained");
    for (const session of assessment.sessions) {
      lines.push(
        `  session ${escapeTerminalBytes(session.sessionId)} disposition=${session.disposition} handle=${recoveryHandleText(session.handleResolution)}`,
      );
      if (session.reasons.length > 0) lines.push(`    reasons: ${session.reasons.join(", ")}`);
    }
    const capabilities = assessment.providerCapabilities
      .map((capability) => `${escapeTerminalBytes(capability.provider)}=${capability.status}`)
      .join(", ");
    lines.push(`  resume capabilities: ${capabilities || "none reported"}`);
  }
  return lines.join("\n");
}

function recoveryHandleText(resolution: UpdateReapRecoveryHandleResolution): string {
  if (resolution.kind === "selected")
    return `selected eligible=${resolution.eligibleHandleCount} rejected=${resolution.rejectedHandleCount}`;
  if (resolution.kind === "none") return `none rejected=${resolution.rejectedHandleCount}`;
  return `unknown (${resolution.reasons.join(", ")})`;
}

function phaseText(label: string, phase: { action: string; reason: string }): string {
  return `${label}: ${phase.action} (${phase.reason})`;
}

function artifactPhaseText(phase: PreviewPhases["artifactApplication"]): string {
  const detail = phaseText("artifact", phase);
  switch (phase.action) {
    case "no-op":
      return detail;
    case "apply":
      return phase.command.kind === "manager"
        ? `${detail}; command: ${formatCommand(phase.command.argv)}`
        : detail;
    case "defer":
      return `${detail}; command: ${formatCommand(phase.command.argv)}`;
  }
}

function hostPhaseText(phase: PreviewPhases["hostConvergence"]): string {
  switch (phase.action) {
    case "handoff":
      return `${phaseText("Host", phase)}; fidelity=${phase.fidelity}`;
    case "no-op":
    case "replace-idle":
    case "await-reap":
    case "leave-in-place":
    case "reinspect":
    case "blocked":
      return phaseText("Host", phase);
  }
}

function terminalPhaseText(phase: PreviewPhases["terminalConvergence"]): string {
  switch (phase.action) {
    case "preserve-via-handoff":
      return `${phaseText("terminals", phase)}; fidelity=${phase.fidelity}`;
    case "no-op":
    case "reap-required":
    case "leave-in-place":
    case "reinspect":
    case "blocked":
      return phaseText("terminals", phase);
  }
}

import {
  parseUpdateCommandReport,
  projectPublicUpdateReport,
  type UpdateArtifact,
  type UpdateCommandArgv,
  type UpdateCommandReport,
  type UpdateCommandStep,
  type UpdateCommandStepStatus,
  type UpdateConvergencePlan,
  UpdateConvergencePlanningInputSchema,
  type UpdateFinalInspection,
  type UpdateReapRecoveryAssessment,
} from "@station/contracts";
import {
  publicSafeErrorFromUnknown,
  shellQuote,
  stationObserverBuildVersion,
} from "@station/runtime";
import type { CliRunResult } from "../../cliTypes.js";
import { escapeTerminalBytes } from "../../terminalOutput.js";
import type { PlannedUpdateChannel } from "../../update/channelDetection.js";
import type {
  UpdateConvergenceExecutionDeps,
  UpdateConvergenceExecutionInput,
  UpdateConvergenceExecutionResult,
} from "../../update/convergenceExecution.js";
import { deriveUpdateConvergencePlan } from "../../update/convergencePlan.js";
import type { UpdateRequest } from "./args.js";

export type { UpdateCommandStep } from "@station/contracts";

type UpdateCommandResultReport = Extract<UpdateCommandReport, { kind: "result" }>;
type UpdateCommandPreviewReport = Extract<UpdateCommandReport, { kind: "preview" }>;
export type UpdateCommandResultDraft = Omit<UpdateCommandResultReport, "status">;
type PreviewPhases = UpdateCommandPreviewReport["plan"]["phases"];

function artifact(version: string, revision: string | undefined) {
  return { version, ...(revision === undefined ? {} : { revision }) };
}

export function createUpdateReport(
  selected: PlannedUpdateChannel,
  initial: UpdateCommandResultDraft["initial"],
  plan: UpdateCommandResultDraft["plan"],
): UpdateCommandResultDraft {
  return {
    schemaVersion: 5,
    kind: "result",
    channel: selected.channel,
    current: artifact(selected.plan.currentVersion, selected.plan.currentRevision),
    target: artifact(selected.plan.targetVersion, selected.plan.targetRevision),
    initial,
    plan,
    hookReconciliations: [],
    steps: [
      updateStep("detect", "completed", `Detected ${selected.channel} ownership.`),
      updateStep("plan", "completed", "Resolved the current and target Station builds."),
    ],
    warnings: [],
    recoveryCommands: [],
  };
}

export function updateStep(
  id: UpdateCommandStep["id"],
  status: UpdateCommandStepStatus,
  detail: string,
  command?: UpdateCommandArgv,
): UpdateCommandStep {
  return { id, status, detail, ...(command === undefined ? {} : { command }) };
}

export async function finalizeUpdateConvergence(
  input: UpdateConvergenceExecutionInput,
  deps: UpdateConvergenceExecutionDeps,
  failure: unknown,
  successfulExecution: boolean,
  installed: UpdateArtifact,
): Promise<UpdateConvergenceExecutionResult> {
  try {
    const final = await deps.inspect({
      installed,
      target: input.target,
      currentBuildInfo: input.buildInfo,
    });
    if (
      !artifactsMatch(final.installed, installed) ||
      !artifactsMatch(final.target, input.target)
    ) {
      throw new Error("Final aggregate changed the selected artifact evidence.");
    }
    const planning = UpdateConvergencePlanningInputSchema.parse({
      preflight: final,
      targetRuntime: artifactsMatch(installed, input.target)
        ? {
            status: "known",
            buildIdentity: input.buildInfo.buildIdentity,
            observerSelector: stationObserverBuildVersion(input.buildInfo),
          }
        : { status: "not-yet-provable" },
      installation: input.planning.installation,
      handoff: input.planning.handoff,
    });
    const plan = deriveUpdateConvergencePlan(planning);
    const inspection: UpdateFinalInspection = { status: "completed", aggregate: final, plan };
    input.report.finalInspection = inspection;
    input.report.steps.push(
      updateStep(
        "final-verification",
        "completed",
        `Final aggregate verification: ${plan.outcome}.`,
      ),
    );
    if (failure !== undefined || !successfulExecution) {
      return { status: "failed", finalInspection: inspection };
    }
    if (plan.outcome === "converged") {
      return { status: input.artifactChanged ? "updated" : "current", finalInspection: inspection };
    }
    return { status: finalDisposition(plan.outcome), finalInspection: inspection };
  } catch (error) {
    const safeError = publicSafeErrorFromUnknown(error, {
      tag: "UpdateError",
      code: "UPDATE_FINAL_VERIFICATION_FAILED",
      message: "Final update convergence inspection failed.",
    });
    input.report.finalInspection = { status: "failed", error: safeError };
    input.report.steps.push(updateStep("final-verification", "failed", safeError.message));
    return { status: "failed", finalInspection: input.report.finalInspection };
  }
}

export function resultUpdateCommandResult(
  report: UpdateCommandResultDraft,
  status: UpdateCommandResultReport["status"],
  output: UpdateRequest["output"],
): CliRunResult {
  return updateCommandResult({ ...report, status }, output);
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
    code: ["current", "updated", "deferred"].includes(parsed.status) ? 0 : 1,
    output: json ? parsed : renderUpdateReport(parsed),
    ...(json ? {} : { outputFormat: "text" as const }),
  };
}

export function previewUpdateCommandResult(
  report: UpdateCommandPreviewReport,
  output: UpdateRequest["output"],
): CliRunResult {
  const parsed = parseUpdateCommandReport(
    projectPublicUpdateReport(report),
  ) as UpdateCommandPreviewReport;
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
  for (const hook of report.hookReconciliations) {
    lines.push(`hooks: ${escapeTerminalBytes(hook.provider)}=${escapeTerminalBytes(hook.status)}`);
  }
  if (report.finalInspection !== undefined) {
    lines.push(`final: ${escapeTerminalBytes(report.finalInspection.status)}`);
    if (report.finalInspection.status === "completed") {
      lines.push(`final plan: ${escapeTerminalBytes(report.finalInspection.plan.outcome)}`);
    }
  }
  for (const warning of report.warnings)
    lines.push(`warning: ${escapeTerminalBytes(warning.message)}`);
  if (report.error !== undefined)
    lines.push(
      `error: ${escapeTerminalBytes(report.error.message)} (${escapeTerminalBytes(report.error.code)})`,
    );
  if (report.cause !== undefined)
    lines.push(
      `cause: ${escapeTerminalBytes(report.cause.message)} (${escapeTerminalBytes(report.cause.code)})`,
    );
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
    parkedBridgeText(report),
    recoveryText(report),
    phaseText("reconcile", plan.phases.persistedStateReconcile),
    phaseText("verification", plan.phases.finalVerification),
  ];
  return `${lines.join("\n")}\n`;
}

function parkedBridgeText(report: UpdateCommandPreviewReport): string {
  const parked = report.initial.parkedBridges;
  return parked.status === "assessed"
    ? `parked bridges: total=${parked.totalParkedCount}; unowned=${parked.unownedParkedCount}; adoption-required=${parked.adoptionRequiredCount}`
    : "parked bridges: unknown (inspection failed)";
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
        `  session ${escapeTerminalBytes(session.sessionId)} disposition=${session.disposition} ${handleText(session.handleResolution)}`,
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

function handleText(
  handle: UpdateReapRecoveryAssessment["sessions"][number]["handleResolution"],
): string {
  switch (handle.kind) {
    case "selected":
      return `handle=selected eligible=${handle.eligibleHandleCount} rejected=${handle.rejectedHandleCount}`;
    case "none":
      return `handle=none rejected=${handle.rejectedHandleCount}`;
    case "unknown":
      return "handle=unknown";
  }
}

function artifactText(value: UpdateCommandReport["current"]): string {
  return value.revision === undefined
    ? escapeTerminalBytes(value.version)
    : `${escapeTerminalBytes(value.version)} (${escapeTerminalBytes(value.revision)})`;
}

function formatCommand(command: readonly string[]): string {
  return command.map((value) => shellQuote(escapeTerminalBytes(value))).join(" ");
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
    case "recover-parked":
    case "replace-idle":
    case "await-reap":
    case "leave-in-place":
    case "reinspect":
    case "blocked":
      return phase.action === "recover-parked"
        ? `${phaseText("Host", phase)}; count=${phase.parkedCount}`
        : phaseText("Host", phase);
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

function finalDisposition(
  outcome: UpdateConvergencePlan["outcome"],
): UpdateConvergenceExecutionResult["status"] {
  return outcome === "blocked" ||
    outcome === "reap-required" ||
    outcome === "intentionally-incomplete"
    ? outcome
    : "failed";
}

function artifactsMatch(left: UpdateArtifact, right: UpdateArtifact): boolean {
  return left.version === right.version && left.revision === right.revision;
}

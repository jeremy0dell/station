import { type UpdateCommandReport, UpdateCommandReportSchema } from "@station/contracts";
import { shellQuote } from "@station/runtime";
import type { CliRunResult } from "../../cliTypes.js";
import { sanitizePublicUpdateReport } from "../../update/publicUpdateReportAdapter.js";
import { updateCommandExitCode } from "../../update/updateCommandStatusPolicy.js";
import { encodeUpdateTerminalText } from "../../update/updateTerminalText.js";
import type { UpdateRequest } from "./args.js";

export type { UpdateCommandReport } from "@station/contracts";

/**
 * ADAPTER
 *
 * Presents one strict public update report as JSON or terminal-safe text with its process status.
 */
export function updateCommandResult(
  reportInput: UpdateCommandReport,
  output: UpdateRequest["output"],
): CliRunResult {
  // Both presenters consume the same strict, deeply sanitized public representation.
  const report = sanitizePublicUpdateReport(UpdateCommandReportSchema.parse(reportInput));
  return {
    code: updateCommandExitCode(report),
    output: output === "json" ? report : renderUpdateReport(report),
    ...(output === "json" ? {} : { outputFormat: "text" as const }),
  };
}

export { updateCommandExitCode } from "../../update/updateCommandStatusPolicy.js";

function renderUpdateReport(report: UpdateCommandReport): string {
  const plan = report.initial.plan;
  const lines = [
    `channel: ${encodeUpdateTerminalText(report.channel)}`,
    `status: ${encodeUpdateTerminalText(report.status)}`,
    `artifact before: ${artifactText(report.current)}`,
    `artifact selected: ${artifactText(report.target)}`,
    `artifact application: ${encodeUpdateTerminalText(report.artifactApplication.status)}`,
  ];
  if (
    (report.artifactApplication.status === "preview" ||
      report.artifactApplication.status === "deferred") &&
    report.artifactApplication.managerCommand !== undefined
  ) {
    lines.push(
      `manager command: ${report.artifactApplication.managerCommand
        .map((value) => shellQuote(encodeUpdateTerminalText(value)))
        .join(" ")}`,
    );
  }
  lines.push(
    `plan evaluator: ${encodeUpdateTerminalText(report.initial.evaluator)}`,
    `plan digest: ${encodeUpdateTerminalText(plan.digest.value)}`,
    `plan status: ${encodeUpdateTerminalText(plan.status)}`,
    "hooks:",
  );
  if (plan.components.hooks.length === 0) lines.push("  none configured");
  for (const hook of plan.components.hooks) {
    lines.push(
      `  ${encodeUpdateTerminalText(hook.provider)}: ${encodeUpdateTerminalText(hook.action)} (${encodeUpdateTerminalText(hook.reason)})`,
    );
  }
  lines.push(
    `observer: ${encodeUpdateTerminalText(plan.components.observer.action)} (${encodeUpdateTerminalText(plan.components.observer.reason)})`,
    `host: ${encodeUpdateTerminalText(plan.components.host.action)} (${encodeUpdateTerminalText(plan.components.host.reason)})${fidelityText(plan.components.host.fidelity)}`,
    `terminals: ${encodeUpdateTerminalText(plan.components.terminals.action)} (${encodeUpdateTerminalText(plan.components.terminals.reason)})${fidelityText(plan.components.terminals.fidelity)}; live=${plan.components.terminals.liveCount} recoverable=${plan.components.terminals.recoverableCount} non-resumable=${plan.components.terminals.nonResumableCount} unknown=${plan.components.terminals.unknownRecoveryCount}`,
    `recovery: ${encodeUpdateTerminalText(plan.components.recovery.relevance)}/${encodeUpdateTerminalText(plan.components.recovery.status)}`,
    `reconcile: ${encodeUpdateTerminalText(plan.components.reconcile.action)} (${encodeUpdateTerminalText(plan.components.reconcile.reason)})`,
    "ordered convergence phases:",
  );
  for (const phase of plan.phases) {
    lines.push(
      `  ${encodeUpdateTerminalText(phase.id)}: ${encodeUpdateTerminalText(phase.action)} (${encodeUpdateTerminalText(phase.reason)})`,
    );
  }
  lines.push(`result: ${encodeUpdateTerminalText(report.result.kind)}`);
  const resultPhases = nonMutatingResultPhases(report);
  if (resultPhases !== undefined) {
    lines.push("result convergence phases:");
    for (const phase of resultPhases) {
      lines.push(
        `  ${encodeUpdateTerminalText(phase.id)}: ${encodeUpdateTerminalText(phase.status)}`,
      );
    }
  }
  for (const audit of actionAudits(report)) {
    lines.push(
      `executed digest: ${encodeUpdateTerminalText(audit.planDigest)} by ${encodeUpdateTerminalText(audit.executor)}`,
    );
    for (const action of audit.actions) {
      lines.push(
        `  ${encodeUpdateTerminalText(action.phase)}: ${encodeUpdateTerminalText(action.action)} ${encodeUpdateTerminalText(action.status)}${
          action.provider === undefined
            ? ""
            : ` provider=${encodeUpdateTerminalText(action.provider)}`
        }${fidelityText(action.fidelity)}`,
      );
    }
  }
  const final = finalEvidence(report);
  if (final !== undefined) {
    lines.push(
      `${final.label}: ${encodeUpdateTerminalText(final.evidence.plan.digest.value)} (${encodeUpdateTerminalText(final.evidence.plan.status)}) by ${encodeUpdateTerminalText(final.evidence.evaluator)}`,
    );
  }
  for (const warning of report.warnings) {
    lines.push(`warning: ${encodeUpdateTerminalText(warning.message)}`);
  }
  if (report.error !== undefined)
    lines.push(
      `error: ${encodeUpdateTerminalText(report.error.message)} (${encodeUpdateTerminalText(report.error.code)})`,
    );
  if (report.cause !== undefined)
    lines.push(
      `cause: ${encodeUpdateTerminalText(report.cause.message)} (${encodeUpdateTerminalText(report.cause.code)})`,
    );
  if (report.startupEvidence !== undefined) {
    lines.push("observer startup evidence:");
    lines.push(`  boot log: ${encodeUpdateTerminalText(report.startupEvidence.bootLogPath)}`);
    if (report.startupEvidence.bootLogTail !== undefined) {
      lines.push(
        `  bounded boot log tail: ${encodeUpdateTerminalText(report.startupEvidence.bootLogTail)}`,
      );
    }
  }
  if (report.recoveryCommands.length > 0) {
    lines.push("recovery commands:");
    for (const command of report.recoveryCommands) {
      lines.push(
        `  ${command.map((value) => shellQuote(encodeUpdateTerminalText(value))).join(" ")}`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

function fidelityText(fidelity: "processes" | "screen" | undefined): string {
  return fidelity === undefined ? "" : ` fidelity=${encodeUpdateTerminalText(fidelity)}`;
}

function actionAudits(report: UpdateCommandReport) {
  switch (report.result.kind) {
    case "current-runtime-execution":
    case "successor-runtime-execution":
    case "execution-failed":
      return report.result.actionAudits;
    case "already-converged":
    case "preview":
    case "deferred":
    case "non-mutating-stop":
      return [];
  }
}

function finalEvidence(report: UpdateCommandReport) {
  switch (report.result.kind) {
    case "already-converged":
      return { label: "verified plan" as const, evidence: report.initial };
    case "preview":
    case "deferred":
    case "non-mutating-stop":
      return undefined;
    case "current-runtime-execution":
      return { label: "verified plan" as const, evidence: report.result.postAction };
    case "successor-runtime-execution":
      return {
        label:
          report.result.verification.source === "successor" &&
          report.result.verification.status === "not-converged"
            ? ("successor plan" as const)
            : ("verified plan" as const),
        evidence: report.result.postAction,
      };
    case "execution-failed":
      return report.result.finalInspection.status === "completed"
        ? {
            label: "verified plan" as const,
            evidence: report.result.finalInspection.evidence,
          }
        : undefined;
  }
}

function nonMutatingResultPhases(report: UpdateCommandReport) {
  switch (report.result.kind) {
    case "preview":
    case "deferred":
    case "non-mutating-stop":
      return report.result.phases;
    case "already-converged":
    case "current-runtime-execution":
    case "successor-runtime-execution":
    case "execution-failed":
      return undefined;
  }
}

function artifactText(artifact: UpdateCommandReport["current"]): string {
  return artifact.revision === undefined
    ? encodeUpdateTerminalText(artifact.version)
    : `${encodeUpdateTerminalText(artifact.version)} (${encodeUpdateTerminalText(artifact.revision)})`;
}

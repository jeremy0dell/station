import {
  type UpdateCommandReport,
  UpdateCommandReportSchema,
  type UpdateConvergencePlan,
} from "@station/contracts";
import { shellQuote } from "@station/runtime";
import type { CliRunResult } from "../../cliTypes.js";
import { sanitizePublicUpdateReport } from "../../update/publicUpdateReport.js";
import type { UpdateRequest } from "./args.js";

export type { UpdateCommandReport } from "@station/contracts";

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

/**
 * POLICY
 *
 * Maps the strict update disposition to the CLI process contract shared by the presenter and
 * successor-child boundary.
 */
export function updateCommandExitCode(report: Pick<UpdateCommandReport, "status">): 0 | 1 {
  switch (report.status) {
    case "current":
    case "updated":
    case "planned":
    case "deferred":
      return 0;
    case "failed":
    case "blocked":
    case "reap-required":
    case "intentionally-incomplete":
      return 1;
  }
}

export function nonExecutedPhases(plan: UpdateConvergencePlan) {
  return plan.phases.map((phase) => ({ id: phase.id, status: "not-executed" as const }));
}

function renderUpdateReport(report: UpdateCommandReport): string {
  const plan = report.initial.plan;
  const lines = [
    `channel: ${report.channel}`,
    `status: ${report.status}`,
    `artifact installed: ${artifactText(report.current)}`,
    `artifact selected: ${artifactText(report.target)}`,
    `artifact application: ${report.artifactApplication.status}`,
  ];
  if (
    (report.artifactApplication.status === "preview" ||
      report.artifactApplication.status === "deferred") &&
    report.artifactApplication.managerCommand !== undefined
  ) {
    lines.push(
      `manager command: ${report.artifactApplication.managerCommand
        .map((value) => shellQuote(value))
        .join(" ")}`,
    );
  }
  lines.push(
    `plan evaluator: ${report.initial.evaluator}`,
    `plan digest: ${plan.digest.value}`,
    `plan status: ${plan.status}`,
    "hooks:",
  );
  if (plan.components.hooks.length === 0) lines.push("  none configured");
  for (const hook of plan.components.hooks) {
    lines.push(`  ${safeText(hook.provider)}: ${hook.action} (${hook.reason})`);
  }
  lines.push(
    `observer: ${plan.components.observer.action} (${plan.components.observer.reason})`,
    `host: ${plan.components.host.action} (${plan.components.host.reason})`,
    `terminals: ${plan.components.terminals.action} (${plan.components.terminals.reason}); live=${plan.components.terminals.liveCount} recoverable=${plan.components.terminals.recoverableCount} non-resumable=${plan.components.terminals.nonResumableCount} unknown=${plan.components.terminals.unknownRecoveryCount}`,
    `recovery: ${plan.components.recovery.relevance}/${plan.components.recovery.status}`,
    `reconcile: ${plan.components.reconcile.action} (${plan.components.reconcile.reason})`,
    "ordered convergence phases:",
  );
  for (const phase of plan.phases) {
    lines.push(`  ${phase.id}: ${phase.action} (${phase.reason})`);
  }
  lines.push(`result: ${report.result.kind}`);
  for (const audit of actionAudits(report)) {
    lines.push(`executed digest: ${audit.planDigest} by ${audit.executor}`);
    for (const action of audit.actions) {
      lines.push(
        `  ${action.phase}: ${action.action} ${action.status}${
          action.provider === undefined ? "" : ` provider=${safeText(action.provider)}`
        }`,
      );
    }
  }
  const final = finalEvidence(report);
  if (final !== undefined) {
    lines.push(
      `verified plan: ${final.plan.digest.value} (${final.plan.status}) by ${final.evaluator}`,
    );
  }
  for (const warning of report.warnings) lines.push(`warning: ${warning.message}`);
  if (report.error !== undefined)
    lines.push(`error: ${report.error.message} (${report.error.code})`);
  if (report.cause !== undefined)
    lines.push(`cause: ${safeText(report.cause.message)} (${safeText(report.cause.code)})`);
  if (report.startupEvidence !== undefined) {
    lines.push("observer startup evidence:");
    lines.push(`  boot log: ${safeText(report.startupEvidence.bootLogPath)}`);
    if (report.startupEvidence.bootLogTail !== undefined) {
      lines.push(`  bounded boot log tail: ${safeText(report.startupEvidence.bootLogTail)}`);
    }
  }
  if (report.recoveryCommands.length > 0) {
    lines.push("recovery commands:");
    for (const command of report.recoveryCommands) {
      lines.push(`  ${command.map((value) => shellQuote(value)).join(" ")}`);
    }
  }
  return `${lines.join("\n")}\n`;
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
      return report.initial;
    case "preview":
    case "deferred":
    case "non-mutating-stop":
      return undefined;
    case "current-runtime-execution":
      return report.result.postAction;
    case "successor-runtime-execution":
      return report.result.postAction;
    case "execution-failed":
      return report.result.finalInspection.status === "completed"
        ? report.result.finalInspection.evidence
        : undefined;
  }
}

function artifactText(artifact: UpdateCommandReport["current"]): string {
  return artifact.revision === undefined
    ? safeText(artifact.version)
    : `${safeText(artifact.version)} (${safeText(artifact.revision)})`;
}

function safeText(value: string): string {
  let escaped = "";
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0;
    escaped +=
      point <= 31 || (point >= 127 && point <= 159)
        ? `\\u${point.toString(16).padStart(4, "0")}`
        : character;
  }
  return escaped;
}

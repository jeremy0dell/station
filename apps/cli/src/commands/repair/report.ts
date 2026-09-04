import type { RepairInventoryReport, RepairPreview, RepairResult } from "@station/contracts";
import {
  RepairInventoryReportSchema,
  RepairPreviewSchema,
  RepairResultSchema,
} from "@station/contracts";
import { shellQuote } from "@station/runtime";
import type { CliRunResult } from "../../cliTypes.js";
import { escapeTerminalBytes } from "../../terminalOutput.js";

export function repairInventoryResult(
  report: RepairInventoryReport,
  output: "text" | "json",
): CliRunResult {
  const parsed = RepairInventoryReportSchema.parse(report);
  return formatted(0, parsed, output, renderInventory(parsed));
}

export function repairPreviewResult(report: RepairPreview, output: "text" | "json"): CliRunResult {
  const parsed = RepairPreviewSchema.parse(report);
  return formatted(parsed.plan.status === "ready" ? 0 : 1, parsed, output, renderPreview(parsed));
}

export function repairApplyResult(report: RepairResult, output: "text" | "json"): CliRunResult {
  const parsed = RepairResultSchema.parse(report);
  return formatted(parsed.status === "completed" ? 0 : 1, parsed, output, renderResult(parsed));
}

function formatted(
  code: number,
  json: unknown,
  output: "text" | "json",
  text: string,
): CliRunResult {
  return {
    code,
    output: output === "json" ? json : text,
    ...(output === "text" ? { outputFormat: "text" as const } : {}),
  };
}

function renderInventory(report: RepairInventoryReport): string {
  const inventory = report.inventory;
  const terminals =
    inventory.runtime.status === "available" &&
    inventory.runtime.preflight.host.status === "inspected"
      ? inventory.runtime.preflight.host.terminals.length
      : "unavailable";
  const handles =
    inventory.recovery.status === "available"
      ? inventory.recovery.assessment.inventory.recoveryHandles.length
      : "unavailable";
  return `${[
    "repair inventory (No actions executed)",
    `digest: ${inventory.repairInventoryDigest}`,
    `runtime: ${inventory.runtime.status}`,
    `terminals: ${terminals}`,
    `recovery: ${inventory.recovery.status}`,
    `recovery handles: ${handles}`,
  ].join("\n")}\n`;
}

function renderPreview(report: RepairPreview): string {
  return `${[
    "repair preview (No actions executed)",
    `action: ${actionText(report.plan.action)}`,
    `status: ${report.plan.status}`,
    `reason: ${report.plan.reason}`,
    `detail: ${escapeTerminalBytes(report.plan.detail)}`,
    `plan: ${report.plan.repairPlanDigest}`,
    report.plan.status === "ready"
      ? `apply: ${applyCommand(report.plan.action, report.plan.repairPlanDigest)}`
      : "apply: unavailable",
  ].join("\n")}\n`;
}

function renderResult(report: RepairResult): string {
  const lines = [
    `repair: ${report.status}`,
    `action: ${actionText(report.action)}`,
    `plan: ${report.planDigest}`,
  ];
  if (report.backup !== undefined) {
    lines.push(`backup: ${report.backup.id} (${report.backup.contentDigest})`);
  }
  if (report.auditId !== undefined) lines.push(`audit: ${report.auditId}`);
  if (report.termination !== undefined) {
    lines.push(
      `termination: ${report.termination.outcome}; escalation=${report.termination.escalationUsed ? "yes" : "no"}; unresolved=${report.termination.unresolved ? "yes" : "no"}`,
    );
  }
  if (report.error !== undefined) {
    lines.push(`error: ${escapeTerminalBytes(report.error.message)} (${report.error.code})`);
  }
  for (const command of report.recoveryCommands) {
    lines.push(`recovery: ${formatCommand(command)}`);
  }
  return `${lines.join("\n")}\n`;
}

function actionText(action: RepairPreview["plan"]["action"]): string {
  switch (action.kind) {
    case "terminal-reap":
      return `terminal reap ${escapeTerminalBytes(action.terminalTargetId)}`;
    case "observer-cleanup":
      return "observer cleanup";
    case "recovery-resume":
      return `recovery resume ${escapeTerminalBytes(action.recoveryHandleId)}`;
    case "recovery-prune":
      return `recovery prune ${escapeTerminalBytes(action.recoveryHandleId)}`;
  }
}

function applyCommand(action: RepairPreview["plan"]["action"], digest: string): string {
  let command: string[];
  switch (action.kind) {
    case "terminal-reap":
      command = ["stn", "repair", "terminal", "reap", "--terminal", action.terminalTargetId];
      break;
    case "observer-cleanup":
      command = ["stn", "repair", "observer", "cleanup"];
      break;
    case "recovery-resume":
      command = ["stn", "repair", "recovery", "resume", "--handle", action.recoveryHandleId];
      break;
    case "recovery-prune":
      command = ["stn", "repair", "recovery", "prune", "--handle", action.recoveryHandleId];
      break;
  }
  return formatCommand([...command, "--yes", "--expect-plan", digest]);
}

function formatCommand(command: readonly string[]): string {
  return command.map((value) => shellQuote(escapeTerminalBytes(value))).join(" ");
}

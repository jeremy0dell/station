import type { SafeError, SessionGroupView } from "@station/contracts";
import { escapeTerminalBytes } from "../../terminalOutput.js";
import type { GroupMutationConvergence } from "./convergence.js";
import type { CompletedGroupOutcome, GroupCommandResult, GroupMutationCommand } from "./result.js";

export function renderGroupCommandText(result: GroupCommandResult): string {
  if (result.action === "list") {
    const lines: string[] = [];
    if (result.filters.project !== undefined) {
      lines.push(`Filter: project=${escapeTerminalBytes(result.filters.project)}`, "");
    }
    if (result.groups.length === 0) return [...lines, "No Session Groups matched."].join("\n");
    return [...lines, ...renderGroupList(result.groups)].join("\n");
  }
  if (result.action === "get") return renderGroup(result.group);

  const lines = [`Group ${escapeTerminalBytes(result.action.replace(".", " "))}`];
  if (result.action !== "create") {
    lines.push(`Target: ${escapeTerminalBytes(result.target.id)}`, renderGroup(result.target));
  }
  lines.push(...renderGroupOutcome(result.outcome));
  if (result.action === "create" && "created" in result) {
    lines.push(
      `Created: ${escapeTerminalBytes(result.created.groupId)}`,
      `Project: ${escapeTerminalBytes(result.created.projectId)}`,
      `Version: ${result.created.version}`,
    );
  }
  if ("convergence" in result) lines.push("", ...renderGroupConvergence(result.convergence));
  return lines.join("\n");
}

function renderGroupList(groups: readonly SessionGroupView[]): string[] {
  return groups.flatMap((group, index) => [...(index === 0 ? [] : [""]), renderGroup(group)]);
}

function renderGroup(group: SessionGroupView): string {
  return [
    `${escapeTerminalBytes(group.id)}  ${escapeTerminalBytes(group.name)}`,
    `  project: ${escapeTerminalBytes(group.projectId)}`,
    `  sessions: ${
      group.sessionIds.length === 0
        ? "(none)"
        : group.sessionIds.map(escapeTerminalBytes).join(", ")
    }`,
    `  parent: ${group.parentGroupId === undefined ? "(root)" : escapeTerminalBytes(group.parentGroupId)}`,
    `  version: ${group.version}`,
    `  created: ${escapeTerminalBytes(group.createdAt)}`,
    `  updated: ${escapeTerminalBytes(group.updatedAt)}`,
  ].join("\n");
}

function renderGroupOutcome(outcome: CompletedGroupOutcome<GroupMutationCommand>): string[] {
  const lines = [
    `Outcome: ${escapeTerminalBytes(outcome.status)}`,
    `Command: ${escapeTerminalBytes(outcome.receipt.commandId)}`,
  ];
  if (outcome.receipt.traceId !== undefined) {
    lines.push(`Trace: ${escapeTerminalBytes(outcome.receipt.traceId)}`);
  }
  if (outcome.status === "rejected" && outcome.receipt.error !== undefined) {
    lines.push(...renderGroupError("Error", outcome.receipt.error));
  }
  if (outcome.status === "failed" && outcome.record.error !== undefined) {
    lines.push(...renderGroupError("Error", outcome.record.error));
  }
  return lines;
}

function renderGroupConvergence(convergence: GroupMutationConvergence): string[] {
  const lines = [
    `Convergence: ${escapeTerminalBytes(convergence.status)}`,
    `Project: ${escapeTerminalBytes(convergence.projectId)}`,
  ];
  if (convergence.groups !== undefined) {
    lines.push("Groups:", ...renderGroupList(convergence.groups));
  }
  if (convergence.warning !== undefined) {
    lines.push(...renderGroupError("Warning", convergence.warning));
  }
  return lines;
}

function renderGroupError(label: "Error" | "Warning", error: SafeError): string[] {
  const lines = [
    `${label}: ${escapeTerminalBytes(error.message)} (${escapeTerminalBytes(error.code)})`,
  ];
  if (error.hint !== undefined) lines.push(`Hint: ${escapeTerminalBytes(error.hint)}`);
  return lines;
}

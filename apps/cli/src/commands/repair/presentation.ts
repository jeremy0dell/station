import type { RepairCommandArgv, RepairInventory, RepairPreviewReport } from "@station/contracts";

export function repairInventoryText(inventory: RepairInventory): string {
  const lines = [
    `repair inventory: ${inventory.completeness}`,
    `digest: ${inventory.inventoryDigest}`,
    `capturedAt: ${inventory.capturedAt}`,
    ownershipLine("observer", inventory.observer),
    ownershipLine("host", inventory.host),
    `terminalGroups: ${inventory.terminalGroups.length}`,
  ];
  for (const target of inventory.terminalGroups) {
    lines.push(
      `  ${target.targetKey} ${target.disposition} pty=${target.ptyId}/${target.ptyInstanceId} child=${target.childPid} pgid=${target.processGroupId} session=${target.stationSessionId}`,
    );
  }
  lines.push(`retainedSessions: ${inventory.sessions.length}`);
  for (const session of inventory.sessions) {
    lines.push(
      `  ${session.id} ${session.lifecycle} project=${session.projectId} worktree=${session.worktreeId} provider=${session.harnessProvider ?? "unknown"}`,
    );
  }
  lines.push(`recoveryHandles: ${inventory.recoveryHandles.length}`);
  for (const handle of inventory.recoveryHandles) {
    lines.push(
      `  ${handle.id} ${handle.disposition} session=${handle.sessionId ?? "none"} provider=${handle.provider} target=${handle.targetKind} lastSeen=${handle.lastSeenAt}`,
    );
  }
  for (const finding of inventory.findings) {
    lines.push(`${finding.severity}: ${finding.code}: ${finding.message}`);
    for (const command of finding.recoveryCommands) lines.push(`  run: ${formatCommand(command)}`);
  }
  return `${lines.join("\n")}\n`;
}

export function repairPreviewText(report: RepairPreviewReport): string {
  const lines = [
    `repair ${report.action} preview: ${report.status}`,
    `inventoryDigest: ${report.inventoryDigest}`,
    `planDigest: ${report.planDigest}`,
    `selectedTargets: ${report.selectedTargets.length}`,
  ];
  for (const target of report.selectedTargets) lines.push(`  ${target}`);
  lines.push(`plannedActions: ${report.plannedActions.length}`);
  for (const action of report.plannedActions) {
    lines.push(`  ${action.order}. ${action.action} ${action.targetKey}`);
  }
  for (const blocker of report.blockers) lines.push(`blocker: ${blocker.code}: ${blocker.message}`);
  for (const warning of report.warnings) lines.push(`warning: ${warning.code}: ${warning.message}`);
  for (const command of report.recoveryCommands) lines.push(`run: ${formatCommand(command)}`);
  return `${lines.join("\n")}\n`;
}

function ownershipLine(
  label: string,
  ownership: RepairInventory["observer"] | RepairInventory["host"],
): string {
  return `${label}: ${ownership.status} socket=${ownership.socketPath} holders=${ownership.holderPids.join(",") || "none"}`;
}

function formatCommand(command: RepairCommandArgv): string {
  return command.map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:@=-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`;
}

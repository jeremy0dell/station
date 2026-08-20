import type {
  RepairInventory,
  RepairPlannedAction,
  RepairPreviewReport,
  RepairTargetReference,
  RuntimeRepairDryRunRequest,
  SafeError,
} from "@station/contracts";
import { RepairPreviewReportSchema, RepairTargetReferenceSchema } from "@station/contracts";
import { canonicalRepairDigest } from "./inventory.js";

export function planRuntimeRepair(
  inventory: RepairInventory,
  request: RuntimeRepairDryRunRequest,
): RepairPreviewReport {
  const blockers: SafeError[] = [];
  const selected = request.targetKeys
    .map((targetKey) => inventory.terminalGroups.find((target) => target.targetKey === targetKey))
    .filter((target) => target !== undefined);
  if (inventory.inventoryDigest !== request.expectInventory) {
    blockers.push(
      repairBlocker("REPAIR_INVENTORY_CHANGED", "The repair inventory digest changed."),
    );
  }
  if (inventory.completeness !== "complete") {
    blockers.push(
      repairBlocker(
        "REPAIR_INVENTORY_PARTIAL",
        "Runtime repair cannot be planned from a partial inventory.",
      ),
    );
  }
  for (const targetKey of request.targetKeys) {
    const target = inventory.terminalGroups.find((candidate) => candidate.targetKey === targetKey);
    if (target === undefined) {
      blockers.push(
        repairBlocker("REPAIR_TARGET_NOT_FOUND", `Runtime target ${targetKey} was not found.`),
      );
    } else if (target.kind !== "agent" || target.disposition !== "verified") {
      blockers.push(
        repairBlocker(
          "REPAIR_TARGET_NOT_VERIFIED",
          `Runtime target ${targetKey} is not a verified Station-owned agent process group.`,
        ),
      );
    }
  }

  const targets = selected
    .filter((target) => target.kind === "agent" && target.disposition === "verified")
    .map(targetReference);
  const plannedActions =
    blockers.length === 0 ? runtimeActions(targets, inventory.inventoryDigest) : [];
  const warnings = inventory.findings
    .filter((finding) => finding.severity === "warning")
    .map((finding) => repairWarning(finding.code, finding.message));
  const stableBlockers = sortErrors(blockers);
  const recoveryCommands = [runtimePreviewCommand(request)];
  const reportWithoutDigest = {
    schemaVersion: 1 as const,
    mode: "preview" as const,
    action: "runtime" as const,
    status: stableBlockers.length > 0 ? ("refused" as const) : ("planned" as const),
    inventoryDigest: inventory.inventoryDigest,
    selectedTargets: request.targetKeys,
    plannedActions,
    blockers: stableBlockers,
    warnings: sortErrors(warnings),
    recoveryCommands,
  };
  const planDigest = canonicalRepairDigest(planDigestProjection(reportWithoutDigest));
  return RepairPreviewReportSchema.parse({ ...reportWithoutDigest, planDigest });
}

function runtimeActions(
  targets: readonly RepairTargetReference[],
  inventoryDigest: string,
): RepairPlannedAction[] {
  const actions: RepairPlannedAction[] = [
    { order: 1, action: "reinventory", targetKey: `inventory:${inventoryDigest}` },
  ];
  for (const target of targets) {
    actions.push({
      order: actions.length + 1,
      action: "drain-terminal",
      targetKey: target.targetKey,
      target,
    });
    actions.push({
      order: actions.length + 1,
      action: "reap-process-group",
      targetKey: target.targetKey,
      target,
    });
  }
  actions.push({ order: actions.length + 1, action: "verify-runtime", targetKey: "runtime" });
  return actions;
}

function targetReference(target: RepairInventory["terminalGroups"][number]): RepairTargetReference {
  return RepairTargetReferenceSchema.parse({
    targetKey: target.targetKey,
    kind: "agent",
    hostSocketIdentity: target.hostSocketIdentity,
    hostProcess: target.hostProcess,
    hostBuildVersion: target.hostBuildVersion,
    hostProtocolVersion: target.hostProtocolVersion,
    ptyId: target.ptyId,
    ptyInstanceId: target.ptyInstanceId,
    terminalTargetId: target.terminalTargetId,
    projectId: target.projectId,
    worktreeId: target.worktreeId,
    stationSessionId: target.stationSessionId,
    harnessProvider: target.harnessProvider,
    childPid: target.childPid,
    processGroupId: target.processGroupId,
    terminalSessionId: target.terminalSessionId,
    tty: target.tty,
    leaderStartToken: target.leaderStartToken,
    members: target.members,
  });
}

function runtimePreviewCommand(request: RuntimeRepairDryRunRequest): [string, ...string[]] {
  return [
    "stn",
    "repair",
    "runtime",
    "--dry-run",
    "--expect-inventory",
    request.expectInventory,
    ...request.targetKeys.flatMap((target) => ["--target", target]),
  ];
}

export function repairBlocker(code: string, message: string): SafeError {
  return { tag: "RepairRefusal", code, message };
}

export function repairWarning(code: string, message: string): SafeError {
  return { tag: "RepairWarning", code, message };
}

export function sortErrors(errors: readonly SafeError[]): SafeError[] {
  const unique = new Map(errors.map((error) => [safeErrorKey(error), error]));
  return [...unique.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, error]) => error);
}

function safeErrorKey(error: SafeError): string {
  return JSON.stringify([
    error.code,
    error.message,
    error.tag,
    error.hint ?? "",
    error.commandId ?? "",
    error.projectId ?? "",
    error.worktreeId ?? "",
    error.sessionId ?? "",
    error.provider ?? "",
    error.traceId ?? "",
    error.diagnosticId ?? "",
  ]);
}

export function planDigestProjection(report: Omit<RepairPreviewReport, "planDigest">): unknown {
  return {
    schemaVersion: report.schemaVersion,
    mode: report.mode,
    action: report.action,
    status: report.status,
    inventoryDigest: report.inventoryDigest,
    selectedTargets: report.selectedTargets,
    plannedActions: report.plannedActions,
    blockers: report.blockers.map((blocker) => ({ code: blocker.code })),
    warnings: report.warnings.map((warning) => ({ code: warning.code })),
  };
}

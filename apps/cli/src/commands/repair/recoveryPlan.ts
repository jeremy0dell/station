import type {
  RecoveryRepairDryRunRequest,
  RepairInventory,
  RepairPlannedAction,
  RepairPreviewReport,
  RepairRecoveryHandle,
  SafeError,
} from "@station/contracts";
import { RepairPreviewReportSchema } from "@station/contracts";
import { canonicalRepairDigest } from "./inventory.js";
import { planDigestProjection, repairBlocker, repairWarning, sortErrors } from "./runtimePlan.js";

export function planRecoveryRepair(
  inventory: RepairInventory,
  request: RecoveryRepairDryRunRequest,
): RepairPreviewReport {
  const blockers: SafeError[] = [];
  if (inventory.inventoryDigest !== request.expectInventory) {
    blockers.push(
      repairBlocker("REPAIR_INVENTORY_CHANGED", "The repair inventory digest changed."),
    );
  }
  if (inventory.completeness !== "complete") {
    blockers.push(
      repairBlocker(
        "REPAIR_INVENTORY_PARTIAL",
        "Recovery repair cannot be planned from a partial inventory.",
      ),
    );
  }
  const session = inventory.sessions.find((candidate) => candidate.id === request.sessionId);
  if (session === undefined) {
    blockers.push(
      repairBlocker("REPAIR_SESSION_NOT_FOUND", "The selected retained session was not found."),
    );
  } else if (session.lifecycle === "ended") {
    blockers.push(
      repairBlocker("REPAIR_SESSION_ENDED", "The selected retained session has ended."),
    );
  } else if (session.harnessProvider === undefined) {
    blockers.push(
      repairBlocker("REPAIR_SESSION_PROVIDER_UNVERIFIED", "The session provider is not exact."),
    );
  }

  const sessionHandles = inventory.recoveryHandles.filter(
    (handle) => handle.sessionId === request.sessionId,
  );
  const viable = sessionHandles.filter((handle) => handle.eligible);
  const explicitKeep = findSelectedHandle(inventory, request.keepHandleId, "keep", blockers);
  const keep = resolveKeepHandle(explicitKeep, viable, request, blockers);
  const prune = request.pruneHandleIds
    .map((handleId) => findSelectedHandle(inventory, handleId, "prune", blockers))
    .filter((handle) => handle !== undefined);

  if (request.pruneHandleIds.length > 0 && request.keepHandleId === undefined) {
    blockers.push(
      repairBlocker(
        "REPAIR_KEEP_HANDLE_REQUIRED",
        "Pruning requires an explicitly selected viable --keep-handle.",
      ),
    );
  }
  if (session !== undefined) {
    for (const handle of [keep, ...prune]) {
      if (handle === undefined) continue;
      if (
        handle.sessionId !== session.id ||
        handle.projectId !== session.projectId ||
        handle.worktreeId !== session.worktreeId ||
        handle.provider !== session.harnessProvider
      ) {
        blockers.push(
          repairBlocker(
            "REPAIR_HANDLE_SCOPE_MISMATCH",
            `Recovery handle ${handle.id} crosses the selected session, worktree, or provider boundary.`,
          ),
        );
      }
    }
  }
  if (keep !== undefined && !keep.eligible) {
    blockers.push(
      repairBlocker("REPAIR_KEEP_HANDLE_NOT_VIABLE", "The explicitly kept handle is not viable."),
    );
  }
  if (keep !== undefined && prune.some((handle) => handle.id === keep.id)) {
    blockers.push(
      repairBlocker("REPAIR_KEEP_HANDLE_PRUNED", "The explicitly kept handle cannot be pruned."),
    );
  }

  const selectedTargets = [...new Set([keep?.id, ...request.pruneHandleIds].filter(isString))].sort(
    (left, right) => left.localeCompare(right),
  );
  const stableBlockers = sortErrors(blockers);
  const plannedActions =
    stableBlockers.length === 0 && keep !== undefined ? recoveryActions(keep, prune) : [];
  const warnings = inventory.findings
    .filter((finding) => finding.severity === "warning")
    .map((finding) => repairWarning(finding.code, finding.message));
  const reportWithoutDigest = {
    schemaVersion: 1 as const,
    mode: "preview" as const,
    action: "recovery" as const,
    status: stableBlockers.length > 0 ? ("refused" as const) : ("planned" as const),
    inventoryDigest: inventory.inventoryDigest,
    selectedTargets,
    plannedActions,
    blockers: stableBlockers,
    warnings: sortErrors(warnings),
    recoveryCommands: [recoveryPreviewCommand(request)],
  };
  const planDigest = canonicalRepairDigest(
    planDigestProjection(reportWithoutDigest as Omit<RepairPreviewReport, "planDigest">),
  );
  return RepairPreviewReportSchema.parse({ ...reportWithoutDigest, planDigest });
}

function resolveKeepHandle(
  explicit: RepairRecoveryHandle | undefined,
  viable: readonly RepairRecoveryHandle[],
  request: RecoveryRepairDryRunRequest,
  blockers: SafeError[],
): RepairRecoveryHandle | undefined {
  if (explicit !== undefined) return explicit;
  if (request.keepHandleId !== undefined) return undefined;
  if (viable.length === 1) return viable[0];
  if (viable.length === 0) {
    blockers.push(repairBlocker("REPAIR_NO_VIABLE_HANDLE", "No viable recovery handle remains."));
  } else {
    blockers.push(
      repairBlocker(
        "REPAIR_HANDLE_AMBIGUOUS",
        "More than one viable recovery handle exists; select one with --keep-handle.",
      ),
    );
  }
  return undefined;
}

function findSelectedHandle(
  inventory: RepairInventory,
  handleId: string | undefined,
  role: "keep" | "prune",
  blockers: SafeError[],
): RepairRecoveryHandle | undefined {
  if (handleId === undefined) return undefined;
  const handle = inventory.recoveryHandles.find((candidate) => candidate.id === handleId);
  if (handle === undefined) {
    blockers.push(
      repairBlocker(
        "REPAIR_HANDLE_NOT_FOUND",
        `The selected ${role} handle ${handleId} was not found.`,
      ),
    );
  }
  return handle;
}

function recoveryActions(
  keep: RepairRecoveryHandle,
  prune: readonly RepairRecoveryHandle[],
): RepairPlannedAction[] {
  const handles = [keep, ...prune.filter((handle) => handle.id !== keep.id)].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  const actions: RepairPlannedAction[] = handles.map((handle, index) => ({
    order: index + 1,
    action: "validate-recovery-handle",
    targetKey: handle.id,
    handle,
  }));
  actions.push({
    order: actions.length + 1,
    action: "keep-recovery-handle",
    targetKey: keep.id,
    handle: keep,
  });
  for (const handle of [...prune].sort((left, right) => left.id.localeCompare(right.id))) {
    actions.push({
      order: actions.length + 1,
      action: "prune-recovery-handle",
      targetKey: handle.id,
      handle,
    });
  }
  return actions;
}

function recoveryPreviewCommand(request: RecoveryRepairDryRunRequest): [string, ...string[]] {
  return [
    "stn",
    "repair",
    "recovery",
    "--dry-run",
    "--expect-inventory",
    request.expectInventory,
    "--session",
    request.sessionId,
    ...(request.keepHandleId === undefined ? [] : ["--keep-handle", request.keepHandleId]),
    ...request.pruneHandleIds.flatMap((handle) => ["--prune-handle", handle]),
  ];
}

function isString(value: string | undefined): value is string {
  return value !== undefined;
}

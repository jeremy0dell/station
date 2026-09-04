import type { RepairAction, RepairInventory, RepairPlan } from "@station/contracts";
import { compareSessionRecoveryHandleRecency, RepairPlanSchema } from "@station/contracts";
import { repairDigest } from "./inventory.js";

export type RepairSelector =
  | { kind: "terminal-reap"; terminalTargetId: string }
  | { kind: "observer-cleanup" }
  | { kind: "recovery-resume" | "recovery-prune"; recoveryHandleId: string };

/** POLICY: derives one non-authorizing exact-selector repair plan from public inventory evidence. */
export function deriveRepairPlan(inventory: RepairInventory, selector: RepairSelector): RepairPlan {
  const decision = decide(inventory, selector);
  const semantic = {
    schemaVersion: 1 as const,
    action: decision.action,
    inventoryDigest: inventory.repairInventoryDigest,
    configuredStateScopeDigest: inventory.configuredStateScopeDigest,
    status: decision.status,
    reason: decision.reason,
  };
  return RepairPlanSchema.parse({
    ...semantic,
    authorization: "none",
    detail: decision.detail,
    recoveryCommands: decision.recoveryCommands,
    repairPlanDigest: repairDigest("station-repair-plan-v1", semantic),
  });
}

function decide(
  inventory: RepairInventory,
  selector: RepairSelector,
): Pick<RepairPlan, "action" | "status" | "reason" | "detail" | "recoveryCommands"> {
  if (selector.kind === "terminal-reap") {
    if (inventory.runtime.status === "unavailable") {
      return refused(
        { kind: selector.kind, terminalTargetId: selector.terminalTargetId },
        "runtime-unavailable",
        "Exact runtime inventory is unavailable.",
      );
    }
    if (inventory.recovery.status === "unavailable") {
      return refused(
        { kind: selector.kind, terminalTargetId: selector.terminalTargetId },
        "recovery-unavailable",
        "Coherent recovery inventory is unavailable for the required backup.",
      );
    }
    const host = inventory.runtime.preflight.host;
    const terminal =
      host.status === "inspected"
        ? host.terminals.find(
            (candidate) => candidate.terminalTargetId === selector.terminalTargetId,
          )
        : undefined;
    if (terminal === undefined) {
      return refused(
        { kind: selector.kind, terminalTargetId: selector.terminalTargetId },
        "terminal-not-found",
        "The exact terminal target is not present in Host inventory.",
      );
    }
    if (!terminal.alive) {
      return refused(
        { kind: selector.kind, terminalTargetId: selector.terminalTargetId },
        "terminal-not-live",
        "The exact terminal target is already absent.",
      );
    }
    const disposition = inventory.runtime.preflight.terminalDispositions.find(
      (candidate) => candidate.terminalTargetId === selector.terminalTargetId,
    );
    if (disposition?.reapRecovery === "unknown" || disposition === undefined) {
      return refused(
        { kind: selector.kind, terminalTargetId: selector.terminalTargetId },
        "terminal-recovery-unknown",
        "The exact terminal recovery disposition is unknown.",
      );
    }
    return ready(
      { kind: selector.kind, terminalTargetId: selector.terminalTargetId },
      "The exact terminal is ready for journaled TERM/KILL recovery.",
    );
  }
  if (selector.kind === "observer-cleanup") {
    if (inventory.runtime.status === "unavailable") {
      return refused(
        { kind: selector.kind },
        "runtime-unavailable",
        "Exact runtime inventory is unavailable.",
      );
    }
    const observer = inventory.runtime.preflight.observer;
    if (
      observer.status !== "unknown" ||
      (observer.reason !== "stale-socket" && observer.reason !== "process-without-socket")
    ) {
      return refused(
        { kind: selector.kind },
        "observer-not-stale",
        "Observer lifecycle evidence is not a verified stale-cleanup candidate.",
      );
    }
    return ready(
      { kind: selector.kind },
      "Stale Observer evidence is ready for policy revalidation.",
    );
  }
  if (inventory.recovery.status === "unavailable") {
    return refused(
      fallbackRecoveryAction(selector),
      "recovery-unavailable",
      "Coherent recovery inventory is unavailable.",
    );
  }
  const recovery = inventory.recovery.assessment;
  const handle = recovery.inventory.recoveryHandles.find(
    (candidate) => candidate.id === selector.recoveryHandleId,
  );
  if (handle === undefined) {
    return refused(
      fallbackRecoveryAction(selector),
      "recovery-handle-not-found",
      "The exact recovery handle is not present.",
    );
  }
  if (handle.sessionId === undefined) {
    return refused(
      fallbackRecoveryAction(selector),
      "recovery-handle-unbound",
      "The exact recovery handle has no Station session identity.",
    );
  }
  const session = recovery.inventory.sessions.find(
    (candidate) => candidate.id === handle.sessionId,
  );
  if (session === undefined) {
    const capability = recovery.providerCapabilities.find(
      (candidate) => candidate.provider === handle.provider,
    );
    if (!recovery.resumeEnabled || capability?.status !== "enabled") {
      return refused(
        fallbackRecoveryAction(selector),
        "recovery-handle-ineligible",
        "The exact imported recovery handle does not have enabled resume capability.",
      );
    }
    const selected = recovery.inventory.recoveryHandles
      .filter(
        (candidate) =>
          candidate.projectId === handle.projectId &&
          candidate.worktreeId === handle.worktreeId &&
          candidate.sessionId === handle.sessionId &&
          candidate.provider === handle.provider,
      )
      .reduce<typeof handle | undefined>(
        (current, candidate) =>
          current === undefined || compareSessionRecoveryHandleRecency(candidate, current) < 0
            ? candidate
            : current,
        undefined,
      );
    if (selected?.id !== handle.id) {
      return refused(
        fallbackRecoveryAction(selector),
        "recovery-handle-ineligible",
        "The exact imported recovery handle is not the selected eligible handle.",
      );
    }
  } else if (
    session.projectId !== handle.projectId ||
    session.worktreeId !== handle.worktreeId ||
    session.harnessProvider !== handle.provider ||
    session.lifecycle !== "open"
  ) {
    return refused(
      fallbackRecoveryAction(selector),
      "recovery-identity-mismatch",
      "The recovery handle does not match one canonical open Station session.",
    );
  }
  if (session !== undefined) {
    const assessment = recovery.sessions.find((candidate) => candidate.sessionId === session.id);
    if (
      assessment?.disposition !== "recoverable" ||
      assessment.handleResolution.kind !== "selected" ||
      assessment.handleResolution.selectedHandleId !== handle.id
    ) {
      return refused(
        fallbackRecoveryAction(selector),
        "recovery-handle-ineligible",
        "The exact recovery handle is not the selected eligible handle.",
      );
    }
  }
  const action: RepairAction = {
    kind: selector.kind,
    recoveryHandleId: handle.id,
    projectId: handle.projectId,
    worktreeId: handle.worktreeId,
    sessionId: handle.sessionId,
    provider: handle.provider,
  };
  return ready(
    action,
    selector.kind === "recovery-prune"
      ? "The exact eligible handle will be backed up and removed; unrelated handles remain."
      : "The exact eligible handle is ready for backed-up agent resume.",
  );
}

function fallbackRecoveryAction(
  selector: Extract<RepairSelector, { kind: "recovery-resume" | "recovery-prune" }>,
): RepairAction {
  return {
    kind: selector.kind,
    recoveryHandleId: selector.recoveryHandleId,
    projectId: "unknown",
    worktreeId: "unknown",
    sessionId: "unknown",
    provider: "unknown",
  };
}

function ready(action: RepairAction, detail: string) {
  return {
    action,
    status: "ready" as const,
    reason: "ready" as const,
    detail,
    recoveryCommands: [],
  };
}

function refused(action: RepairAction, reason: RepairPlan["reason"], detail: string) {
  return {
    action,
    status: "refused" as const,
    reason,
    detail,
    recoveryCommands: [["stn", "repair", "inventory"] as const],
  };
}

import { randomUUID } from "node:crypto";
import type {
  RepairAction,
  RepairAudit,
  RepairBackup,
  RepairInventory,
  RepairJournal,
  RepairPlan,
  RepairRecoveryMutationProof,
  RepairResult,
  UpdateReapJournalTarget,
} from "@station/contracts";
import { RepairJournalSchema, RepairResultSchema } from "@station/contracts";
import { publicSafeErrorFromUnknown } from "@station/runtime";
import type { UpdateReapJournalPort } from "../update/reapJournal.js";
import type { RepairAuditPort } from "./audit.js";
import {
  advanceRepairJournal,
  type RepairJournalPort,
  repairJournalHasReached,
} from "./journal.js";
import type { RepairSelector } from "./plan.js";

export type RepairExecutionDeps = {
  inspectInventory(): Promise<RepairInventory>;
  derivePlan(inventory: RepairInventory, selector: RepairSelector): RepairPlan;
  journal: RepairJournalPort;
  audit: RepairAuditPort;
  updateReapJournal: Pick<UpdateReapJournalPort, "withLock">;
  backup: {
    create(input: { expectedRecoveryInventoryDigest: string }): Promise<RepairBackup>;
  };
  authorizeTerminal(input: {
    inventory: RepairInventory;
    action: Extract<RepairAction, { kind: "terminal-reap" }>;
    plan: RepairPlan;
  }): Promise<{ target: UpdateReapJournalTarget; authorizationDigest: string }>;
  reapTerminal(
    target: UpdateReapJournalTarget,
    planDigest: string,
  ): Promise<UpdateReapJournalTarget>;
  cleanupObserver(): Promise<void>;
  resumeRecovery(
    action: Extract<RepairAction, { kind: "recovery-resume" }>,
    proof: RepairRecoveryMutationProof,
  ): Promise<void>;
  pruneRecovery(
    action: Extract<RepairAction, { kind: "recovery-prune" }>,
    proof: RepairRecoveryMutationProof,
  ): Promise<void>;
  verify(action: RepairAction, journal: RepairJournal): Promise<boolean>;
  now?: () => string;
  journalId?: () => string;
};

/**
 * USE CASE
 *
 * Re-inventories under the repair lock, commits audit and restart state before mutation, and
 * continues only the same exact postcondition after an irreversible boundary. Terminal repair
 * also takes the update-reap lock second so both commands share one signal exclusion region.
 */
export async function executeRepair(
  selector: RepairSelector,
  expectedPlanDigest: string,
  deps: RepairExecutionDeps,
): Promise<RepairResult> {
  return deps.journal.withLock(() =>
    selector.kind === "terminal-reap"
      ? deps.updateReapJournal.withLock(() => executeLocked(selector, expectedPlanDigest, deps))
      : executeLocked(selector, expectedPlanDigest, deps),
  );
}

async function executeLocked(
  selector: RepairSelector,
  expectedPlanDigest: string,
  deps: RepairExecutionDeps,
): Promise<RepairResult> {
  let existing = await deps.journal.findIncomplete();
  const unfinishedAudit = await deps.audit.findInProgress();
  if (unfinishedAudit !== undefined && unfinishedAudit.id !== existing?.auditId) {
    const linkedJournal = await deps.journal.findByAuditId(unfinishedAudit.id);
    const completed = linkedJournal?.phase === "completed";
    const auditUpdate: Parameters<RepairAuditPort["finalize"]>[1] = {
      status: completed ? "completed" : existing === undefined ? "refused" : "recovery-required",
      errorCodes: completed ? [] : ["REPAIR_AUDIT_INTERRUPTED"],
      recoveryCommands: completed
        ? []
        : recoveryCommands(unfinishedAudit.action, unfinishedAudit.planDigest),
    };
    const completedBackup = linkedJournal?.backup ?? unfinishedAudit.backup;
    if (completedBackup !== undefined) auditUpdate.backup = completedBackup;
    const finalizedAudit = await deps.audit.finalize(unfinishedAudit, auditUpdate);
    if (
      completed &&
      linkedJournal !== undefined &&
      linkedJournal.planDigest === expectedPlanDigest &&
      selectorMatchesAction(selector, linkedJournal.action)
    ) {
      return result({
        status: "completed",
        action: linkedJournal.action,
        planDigest: linkedJournal.planDigest,
        inventoryDigest: linkedJournal.inventoryDigest,
        audit: finalizedAudit,
        journal: linkedJournal,
      });
    }
  }
  if (existing !== undefined && !selectorMatchesAction(selector, existing.action)) {
    if (unfinishedAudit?.id === existing.auditId) {
      await deps.audit.finalize(unfinishedAudit, {
        status: "recovery-required",
        errorCodes: ["REPAIR_TRANSACTION_INTERRUPTED"],
        recoveryCommands: recoveryCommands(existing.action, existing.planDigest),
        ...(unfinishedAudit.backup === undefined ? {} : { backup: unfinishedAudit.backup }),
      });
    }
    return refuseIncompleteTransaction(selector, existing, deps);
  }
  const afterMutation =
    existing !== undefined && repairJournalHasReached(existing, "mutation-started");
  let inventory: RepairInventory | undefined;
  let plan: RepairPlan | undefined;
  if (!afterMutation) {
    inventory = await deps.inspectInventory();
    plan = deps.derivePlan(inventory, selector);
  }
  const existingMatchesPlan =
    existing === undefined ||
    (existing.planDigest === plan?.repairPlanDigest &&
      JSON.stringify(existing.action) === JSON.stringify(plan?.action));
  const replacePreMutationJournal =
    existing !== undefined &&
    !afterMutation &&
    plan?.status === "ready" &&
    plan.repairPlanDigest === expectedPlanDigest &&
    !existingMatchesPlan;
  const replacementPlan = replacePreMutationJournal && plan !== undefined ? plan : undefined;
  const action = replacementPlan?.action ?? existing?.action ?? plan?.action;
  const planDigest =
    replacementPlan?.repairPlanDigest ?? existing?.planDigest ?? plan?.repairPlanDigest;
  const inventoryDigest =
    replacementPlan !== undefined
      ? inventory?.repairInventoryDigest
      : (existing?.inventoryDigest ?? inventory?.repairInventoryDigest);
  if (action === undefined || planDigest === undefined || inventoryDigest === undefined) {
    throw new Error("Repair transaction identity was unavailable.");
  }
  const replacedJournalId = replacePreMutationJournal ? existing?.id : undefined;
  let journal = replacePreMutationJournal ? undefined : existing;
  let audit = journal === undefined ? undefined : await deps.audit.read(journal.auditId);
  if (audit !== undefined && journal !== undefined) assertAuditMatchesJournal(audit, journal);
  if (audit?.status !== "in-progress") {
    if (
      journal === undefined &&
      unfinishedAudit !== undefined &&
      existing !== undefined &&
      unfinishedAudit.id === existing.auditId
    ) {
      await deps.audit.finalize(unfinishedAudit, {
        status: "refused",
        errorCodes: ["REPAIR_AUTHORIZATION_REPLACED"],
        recoveryCommands: recoveryCommands(existing.action, existing.planDigest),
        ...(unfinishedAudit.backup === undefined ? {} : { backup: unfinishedAudit.backup }),
      });
    }
    audit = await deps.audit.start({
      action,
      planDigest,
      inventoryDigest,
      errorCodes: [],
      recoveryCommands: recoveryCommands(action, planDigest),
    });
    if (journal !== undefined) {
      journal = RepairJournalSchema.parse({
        ...journal,
        auditId: audit.id,
        updatedAt: (deps.now ?? (() => new Date().toISOString()))(),
      });
      await deps.journal.write(journal);
      existing = journal;
    }
  }
  if (
    !afterMutation &&
    (plan?.status !== "ready" || plan.repairPlanDigest !== expectedPlanDigest)
  ) {
    audit = await deps.audit.finalize(audit, {
      status: "refused",
      errorCodes: [plan?.status === "ready" ? "REPAIR_PLAN_CHANGED" : "REPAIR_PLAN_REFUSED"],
      recoveryCommands: [["stn", "repair", "inventory"]],
    });
    return result({
      status: "refused",
      action,
      planDigest,
      inventoryDigest,
      audit,
    });
  }

  try {
    if (journal === undefined) {
      if (inventory === undefined || plan === undefined)
        throw new Error("Repair plan was missing.");
      const now = (deps.now ?? (() => new Date().toISOString()))();
      const terminalAuthorization =
        action.kind === "terminal-reap"
          ? await deps.authorizeTerminal({ inventory, action, plan })
          : undefined;
      journal = RepairJournalSchema.parse({
        schemaVersion: 1,
        id: replacedJournalId ?? (deps.journalId ?? randomUUID)(),
        auditId: audit.id,
        planDigest,
        inventoryDigest,
        configuredStateScopeDigest: inventory.configuredStateScopeDigest,
        action,
        phase: "authorized",
        ...(terminalAuthorization === undefined
          ? {}
          : {
              terminalTarget: terminalAuthorization.target,
              terminalAuthorizationDigest: terminalAuthorization.authorizationDigest,
            }),
        createdAt: now,
        updatedAt: now,
      });
      await deps.journal.write(journal);
    }
    if (!repairJournalHasReached(journal, "backup-verified")) {
      const backup =
        action.kind === "observer-cleanup"
          ? undefined
          : await deps.backup.create({
              expectedRecoveryInventoryDigest: requireRecoveryDigest(inventory),
            });
      journal = advanceRepairJournal(
        RepairJournalSchema.parse({
          ...journal,
          ...(backup === undefined ? {} : { backup }),
        }),
        "backup-verified",
      );
      await deps.journal.write(journal);
      if (backup !== undefined) {
        audit = await deps.audit.finalize(audit, {
          status: "in-progress",
          errorCodes: [],
          recoveryCommands: recoveryCommands(action, planDigest),
          backup,
        });
      }
    }
    if (!repairJournalHasReached(journal, "mutation-started")) {
      const repeatedInventory = await deps.inspectInventory();
      const repeatedPlan = deps.derivePlan(repeatedInventory, selector);
      if (
        repeatedPlan.status !== "ready" ||
        repeatedPlan.repairPlanDigest !== journal.planDigest ||
        JSON.stringify(repeatedPlan.action) !== JSON.stringify(journal.action)
      ) {
        throw new Error("Repair inventory changed before mutation.");
      }
      if (action.kind === "terminal-reap") {
        const repeated = await deps.authorizeTerminal({
          inventory: repeatedInventory,
          action,
          plan: repeatedPlan,
        });
        if (
          repeated.authorizationDigest !== journal.terminalAuthorizationDigest ||
          JSON.stringify(repeated.target) !== JSON.stringify(journal.terminalTarget)
        ) {
          throw new Error("Exact terminal repair authorization changed before signaling.");
        }
      }
      journal = advanceRepairJournal(journal, "mutation-started");
      await deps.journal.write(journal);
    }
    if (!repairJournalHasReached(journal, "mutation-completed")) {
      const alreadyCompleted = afterMutation && (await deps.verify(action, journal));
      if (!alreadyCompleted) {
        if (afterMutation && action.kind === "recovery-resume") {
          throw new Error(
            "Interrupted recovery resume requires inspection before another launch attempt.",
          );
        }
        journal = await executeAction(action, journal, deps);
        if (
          action.kind === "terminal-reap" &&
          journal.terminalTarget?.result?.unresolved !== false
        ) {
          throw new Error("The exact terminal process group remains unresolved.");
        }
      }
      journal = advanceRepairJournal(journal, "mutation-completed");
      await deps.journal.write(journal);
    }
    if (!repairJournalHasReached(journal, "verified")) {
      if (!(await deps.verify(action, journal))) {
        throw new Error("Repair postcondition could not be verified.");
      }
      journal = advanceRepairJournal(journal, "verified");
      await deps.journal.write(journal);
    }
    if (!repairJournalHasReached(journal, "completed")) {
      journal = advanceRepairJournal(journal, "completed");
      await deps.journal.write(journal);
    }
    audit = await deps.audit.finalize(audit, {
      status: "completed",
      errorCodes: [],
      recoveryCommands: [],
      ...(journal.backup === undefined ? {} : { backup: journal.backup }),
    });
    return result({
      status: "completed",
      action,
      planDigest,
      inventoryDigest,
      audit,
      journal,
    });
  } catch (error) {
    const safe = publicSafeErrorFromUnknown(error, {
      tag: "RepairExecutionError",
      code: "REPAIR_EXECUTION_FAILED",
      message: "The repair transaction did not reach its verified postcondition.",
    });
    const irreversible =
      journal !== undefined && repairJournalHasReached(journal, "mutation-started");
    const terminalPartial =
      action.kind === "terminal-reap" && journal?.terminalTarget?.result?.unresolved === true;
    const status = terminalPartial ? "partial" : irreversible ? "recovery-required" : "refused";
    audit = await deps.audit.finalize(audit, {
      status,
      errorCodes: [safe.code],
      recoveryCommands: recoveryCommands(action, planDigest),
      ...(journal?.backup === undefined ? {} : { backup: journal.backup }),
    });
    return result({
      status,
      action,
      planDigest,
      inventoryDigest,
      audit,
      ...(journal === undefined ? {} : { journal }),
      error: safe,
    });
  }
}

async function refuseIncompleteTransaction(
  selector: RepairSelector,
  existing: RepairJournal,
  deps: RepairExecutionDeps,
): Promise<RepairResult> {
  const inventory = await deps.inspectInventory();
  const plan = deps.derivePlan(inventory, selector);
  const continuation = recoveryCommands(existing.action, existing.planDigest);
  let audit = await deps.audit.start({
    action: plan.action,
    planDigest: plan.repairPlanDigest,
    inventoryDigest: inventory.repairInventoryDigest,
    errorCodes: [],
    recoveryCommands: continuation,
  });
  audit = await deps.audit.finalize(audit, {
    status: "refused",
    errorCodes: ["REPAIR_INCOMPLETE_TRANSACTION_CONFLICT"],
    recoveryCommands: continuation,
  });
  return result({
    status: "refused",
    action: plan.action,
    planDigest: plan.repairPlanDigest,
    inventoryDigest: inventory.repairInventoryDigest,
    audit,
    recoveryCommands: continuation,
  });
}

function assertAuditMatchesJournal(audit: RepairAudit, journal: RepairJournal): void {
  if (
    audit.id !== journal.auditId ||
    audit.planDigest !== journal.planDigest ||
    audit.inventoryDigest !== journal.inventoryDigest ||
    JSON.stringify(audit.action) !== JSON.stringify(journal.action)
  ) {
    throw new Error("Repair audit identity did not match its restart journal.");
  }
}

async function executeAction(
  action: RepairAction,
  journal: RepairJournal,
  deps: RepairExecutionDeps,
): Promise<RepairJournal> {
  switch (action.kind) {
    case "terminal-reap": {
      if (journal.terminalTarget === undefined) throw new Error("Terminal authority was missing.");
      const terminalTarget = await deps.reapTerminal(journal.terminalTarget, journal.planDigest);
      const updated = RepairJournalSchema.parse({ ...journal, terminalTarget });
      await deps.journal.write(updated);
      return updated;
    }
    case "observer-cleanup":
      await deps.cleanupObserver();
      return journal;
    case "recovery-resume":
      await deps.resumeRecovery(action, recoveryMutationProof(journal));
      return journal;
    case "recovery-prune":
      await deps.pruneRecovery(action, recoveryMutationProof(journal));
      return journal;
  }
}

function requireRecoveryDigest(inventory: RepairInventory | undefined): string {
  if (inventory?.recovery.status !== "available") {
    throw new Error("A coherent recovery inventory is required before repair mutation.");
  }
  return inventory.recovery.recoveryInventoryDigest;
}

function recoveryMutationProof(journal: RepairJournal): RepairRecoveryMutationProof {
  if (journal.backup === undefined) throw new Error("A verified recovery backup is required.");
  return {
    journalId: journal.id,
    auditId: journal.auditId,
    planDigest: journal.planDigest,
    inventoryDigest: journal.inventoryDigest,
    expectedRecoveryInventoryDigest: journal.backup.recoveryInventoryDigest,
    backup: journal.backup,
  };
}

function selectorMatchesAction(selector: RepairSelector, action: RepairAction): boolean {
  if (selector.kind !== action.kind) return false;
  if (selector.kind === "terminal-reap" && action.kind === "terminal-reap") {
    return selector.terminalTargetId === action.terminalTargetId;
  }
  if (
    (selector.kind === "recovery-resume" || selector.kind === "recovery-prune") &&
    (action.kind === "recovery-resume" || action.kind === "recovery-prune")
  ) {
    return selector.recoveryHandleId === action.recoveryHandleId;
  }
  return selector.kind === "observer-cleanup";
}

function recoveryCommands(
  action: RepairAction,
  planDigest: string,
): RepairResult["recoveryCommands"] {
  const apply = ["--yes", "--expect-plan", planDigest] as const;
  switch (action.kind) {
    case "terminal-reap":
      return [
        ["stn", "repair", "terminal", "reap", "--terminal", action.terminalTargetId, ...apply],
      ];
    case "observer-cleanup":
      return [["stn", "repair", "observer", "cleanup", ...apply]];
    case "recovery-resume":
      return [
        ["stn", "repair", "recovery", "resume", "--handle", action.recoveryHandleId, ...apply],
      ];
    case "recovery-prune":
      return [
        ["stn", "repair", "recovery", "prune", "--handle", action.recoveryHandleId, ...apply],
      ];
  }
}

function result(input: {
  status: RepairResult["status"];
  action: RepairAction;
  planDigest: string;
  inventoryDigest: string;
  audit: RepairAudit;
  journal?: RepairJournal;
  error?: RepairResult["error"];
  recoveryCommands?: RepairResult["recoveryCommands"];
}): RepairResult {
  const terminal = input.journal?.terminalTarget?.result;
  return RepairResultSchema.parse({
    schemaVersion: 1,
    kind: "result",
    status: input.status,
    action: input.action,
    planDigest: input.planDigest,
    inventoryDigest: input.inventoryDigest,
    auditId: input.audit.id,
    ...(input.journal === undefined ? {} : { journalId: input.journal.id }),
    ...(input.journal?.backup === undefined ? {} : { backup: input.journal.backup }),
    ...(terminal === undefined
      ? {}
      : {
          termination: {
            outcome: terminal.terminationOutcome,
            escalationUsed: terminal.escalationUsed,
            unresolved: terminal.unresolved,
          },
        }),
    ...(input.error === undefined ? {} : { error: input.error }),
    recoveryCommands:
      input.status === "completed"
        ? []
        : (input.recoveryCommands ?? recoveryCommands(input.action, input.planDigest)),
  });
}

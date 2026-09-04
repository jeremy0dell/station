import type { ProviderProjectConfig, RepairAction } from "@station/contracts";
import type { RuntimeClock } from "@station/runtime";
import type { FeatureFlagEvaluator } from "../../features/evaluator.js";
import type { EventJournal, RecoveryRepairStore, SessionStore } from "../../persistence/index.js";
import type { RecoveryRepairAuthorizationPort } from "../../persistence/recoveryBackup.js";
import type { ProviderRegistry } from "../../providers/registry.js";
import type { ObserverCore } from "../../reconcile/core.js";
import { resolveSessionRecovery } from "../../sessionRecovery/resolve.js";
import { nowIso } from "../../utils/time.js";
import {
  createWorktreeMutationCoordinator,
  type WorktreeMutationCoordinator,
} from "../../worktreeMutationCoordinator.js";
import { assertCommandType } from "../assertCommand.js";
import type { CommandHandler } from "../queue.js";
import {
  commandValidationError,
  findProjectOrThrow,
  throwIfAborted,
  validateSnapshotRow,
  worktreeObservationFromRow,
} from "./shared.js";

export type CreatePruneRecoveryHandleHandlerOptions = {
  getProjects: () => readonly ProviderProjectConfig[];
  providers: ProviderRegistry;
  core: ObserverCore;
  persistence: SessionStore & RecoveryRepairStore & EventJournal;
  featureFlags: FeatureFlagEvaluator;
  clock?: RuntimeClock;
  worktreeMutations?: WorktreeMutationCoordinator;
  repairRecoveryAuthorization?: RecoveryRepairAuthorizationPort | undefined;
};

/**
 * USE CASE
 *
 * Revalidates one explicitly selected eligible handle and its private journal, audit, and backup,
 * then deletes only that handle in one digest-guarded transaction that proves every unrelated
 * handle was preserved.
 */
export function createPruneRecoveryHandleHandler(
  options: CreatePruneRecoveryHandleHandlerOptions,
): CommandHandler {
  const worktreeMutations = options.worktreeMutations ?? createWorktreeMutationCoordinator();
  return async (context) => {
    assertCommandType(context, "session.pruneRecoveryHandle");
    throwIfAborted(context.signal);
    if (!options.featureFlags.enabled("sessionResumeAgent")) {
      throw commandValidationError({
        code: "SESSION_RESUME_DISABLED",
        message: "Recovery-handle repair is disabled.",
      });
    }
    const payload = context.command.payload;
    const action: Extract<RepairAction, { kind: "recovery-prune" }> = {
      kind: "recovery-prune",
      recoveryHandleId: payload.recoveryHandleId,
      projectId: payload.projectId,
      worktreeId: payload.worktreeId,
      sessionId: payload.expected.sessionId,
      provider: payload.expected.provider,
    };
    await worktreeMutations.run(payload.projectId, payload.worktreeId, async () => {
      const project = findProjectOrThrow(options.getProjects(), payload.projectId);
      const row = options.core
        .getSnapshot()
        .rows.find((candidate) => candidate.id === payload.worktreeId);
      validateSnapshotRow(row, payload.projectId);
      if (row === undefined) {
        throw commandValidationError({
          code: "WORKTREE_NOT_FOUND",
          message: "The requested worktree is not visible in the current snapshot.",
          projectId: payload.projectId,
          worktreeId: payload.worktreeId,
        });
      }
      const captured = await options.persistence.readRecoveryRepairSnapshot();
      if (captured.recoveryInventoryDigest !== payload.repair.expectedRecoveryInventoryDigest) {
        throw commandValidationError({
          code: "REPAIR_RECOVERY_INVENTORY_CHANGED",
          message: "Recovery inventory changed before handle pruning.",
          projectId: payload.projectId,
          worktreeId: payload.worktreeId,
        });
      }
      await resolveSessionRecovery({
        persistence: options.persistence,
        providers: options.providers,
        projectId: payload.projectId,
        worktreeId: payload.worktreeId,
        worktree: worktreeObservationFromRow(
          row,
          options.providers.worktree.id,
          nowIso(options.clock),
        ),
        recoveryHandleId: payload.recoveryHandleId,
        expected: payload.expected,
        repairSnapshot: captured.snapshot,
        requireCanonicalSelection: true,
      });
      throwIfAborted(context.signal);
      if (options.repairRecoveryAuthorization === undefined) {
        throw commandValidationError({
          code: "REPAIR_RECOVERY_AUTHORIZATION_REQUIRED",
          message: "Recovery pruning requires a verified private journal, audit, and backup.",
          projectId: payload.projectId,
          worktreeId: payload.worktreeId,
        });
      }
      await options.repairRecoveryAuthorization.authorize({
        action,
        proof: payload.repair,
      });
      context.beginCommit();
      await options.persistence.pruneSessionRecoveryHandle({
        recoveryHandleId: payload.recoveryHandleId,
        expectedRecoveryInventoryDigest: payload.repair.expectedRecoveryInventoryDigest,
        expected: {
          projectId: project.id,
          worktreeId: payload.worktreeId,
          sessionId: payload.expected.sessionId,
          provider: payload.expected.provider,
        },
      });
    });
  };
}

import type {
  ProviderProjectConfig,
  RepairAction,
  RepairRecoveryMutationProof,
  SafeError,
  WorktreeRow,
} from "@station/contracts";
import { worktreeHasLiveAgent } from "@station/contracts";
import type { RuntimeClock } from "@station/runtime";
import type { FeatureFlagEvaluator } from "../../features/evaluator.js";
import type { EventJournal, RecoveryRepairStore, SessionStore } from "../../persistence/index.js";
import type { RecoveryRepairAuthorizationPort } from "../../persistence/recoveryBackup.js";
import type { ProviderRegistry } from "../../providers/registry.js";
import type { ObserverCore } from "../../reconcile/core.js";
import type { ObserverEventBus } from "../../runtime/eventBus.js";
import { recoveryInventoryDigest } from "../../sessionRecovery/inventoryDigest.js";
import { resolveSessionRecovery } from "../../sessionRecovery/resolve.js";
import type { StationLogger } from "../../stationLogger.js";
import { nowIso } from "../../utils/time.js";
import {
  createWorktreeMutationCoordinator,
  type WorktreeMutationCoordinator,
} from "../../worktreeMutationCoordinator.js";
import { assertCommandType } from "../assertCommand.js";
import { worktreeMissingError } from "../errors.js";
import type { HarnessLaunchPreflight } from "../harnessLaunchPreflight.js";
import { resolveTerminalProviderOrThrow } from "../providers.js";
import type { CommandHandler } from "../queue.js";
import { reconcileAndPublish } from "../reconcile.js";
import { ensureAgentWorkspace } from "../terminalOperations.js";
import {
  commandValidationError,
  defaultSessionCommandIdFactory,
  discardSessionSeedBestEffort,
  findProjectOrThrow,
  publishSessionCreated,
  type SessionCommandIdFactory,
  seedSession,
  throwIfAborted,
  validateSnapshotRow,
  worktreeObservationFromRow,
} from "./shared.js";

export type CreateSessionResumeAgentHandlerOptions = {
  getProjects: () => readonly ProviderProjectConfig[];
  providers: ProviderRegistry;
  launchPreflight: HarnessLaunchPreflight;
  core: ObserverCore;
  persistence: SessionStore & RecoveryRepairStore & EventJournal;
  featureFlags: FeatureFlagEvaluator;
  eventBus?: ObserverEventBus | undefined;
  clock?: RuntimeClock | undefined;
  idFactory?: Partial<SessionCommandIdFactory> | undefined;
  logger?: StationLogger | undefined;
  worktreeMutations?: WorktreeMutationCoordinator | undefined;
  repairRecoveryAuthorization?: RecoveryRepairAuthorizationPort | undefined;
};

/**
 * USE CASE
 *
 * Serializes recovery with close for one worktree, binds to its canonical open Station session when
 * present, then validates the optional expected session/provider identity and preflights
 * provider-native resume. Explicit imported handles may seed their absent session identity; ended
 * or contradictory local lifecycle is never reopened. Repair callers also commit the coherent
 * recovery inventory digest before launch. Repair resume also verifies its private journal, audit,
 * and backup and re-resolves the canonical handle immediately before terminal creation. Failed
 * cleanup discards only a session seeded by this command.
 */
export function createSessionResumeAgentHandler(
  options: CreateSessionResumeAgentHandlerOptions,
): CommandHandler {
  const idFactory = {
    ...defaultSessionCommandIdFactory,
    ...options.idFactory,
  };
  const worktreeMutations = options.worktreeMutations ?? createWorktreeMutationCoordinator();

  return async (context) => {
    assertCommandType(context, "session.resumeAgent");
    throwIfAborted(context.signal);

    // The command is registered unconditionally so old clients get a stable
    // SafeError instead of an unknown-command failure while the feature bakes.
    if (!options.featureFlags.enabled("sessionResumeAgent")) {
      throw commandValidationError({
        code: "SESSION_RESUME_DISABLED",
        message: "Agent resume is disabled.",
        hint: "Enable feature_flags.sessionResumeAgent and retry.",
      });
    }

    const payload = context.command.payload;
    const repairProof = payload.repair;
    const repairAction: Extract<RepairAction, { kind: "recovery-resume" }> | undefined =
      repairProof === undefined
        ? undefined
        : payload.expected === undefined
          ? undefined
          : {
              kind: "recovery-resume",
              recoveryHandleId: payload.recoveryHandleId ?? "",
              projectId: payload.projectId,
              worktreeId: payload.worktreeId,
              sessionId: payload.expected.sessionId,
              provider: payload.expected.provider,
            };
    if (repairProof !== undefined && repairAction === undefined) {
      throw commandValidationError({
        code: "REPAIR_RECOVERY_EXPECTATION_REQUIRED",
        message: "Repair resume requires one exact handle, session, and provider.",
        projectId: payload.projectId,
        worktreeId: payload.worktreeId,
      });
    }
    if (repairAction !== undefined && repairProof !== undefined) {
      await authorizeRepairRecovery(options.repairRecoveryAuthorization, repairAction, repairProof);
    }
    await worktreeMutations.run(payload.projectId, payload.worktreeId, async () => {
      throwIfAborted(context.signal);
      const project = findProjectOrThrow(options.getProjects(), payload.projectId);
      const terminalProviderId = payload.terminal?.provider ?? project.defaults.terminal;
      const terminal = resolveTerminalProviderOrThrow(options.providers, terminalProviderId);
      const snapshot = options.core.getSnapshot();
      const row = snapshot.rows.find((candidate) => candidate.id === payload.worktreeId);
      validateSnapshotRow(row, payload.projectId);
      // Resume is recovery for a lost primary agent, not a second way to launch
      // another provider process next to a healthy row.
      assertResumeAllowed(row);

      if (row === undefined) {
        throw worktreeMissingError({
          projectId: payload.projectId,
          worktreeId: payload.worktreeId,
          message: "The requested worktree is not visible in the current snapshot.",
        });
      }
      const worktree = worktreeObservationFromRow(
        row,
        options.providers.worktree.id,
        nowIso(options.clock),
      );
      throwIfAborted(context.signal);

      const repairSnapshot =
        repairProof === undefined
          ? undefined
          : await options.persistence.readRecoveryRepairSnapshot();
      if (
        repairProof !== undefined &&
        repairSnapshot?.recoveryInventoryDigest !== repairProof.expectedRecoveryInventoryDigest
      ) {
        throw commandValidationError({
          code: "REPAIR_RECOVERY_INVENTORY_CHANGED",
          message: "Recovery inventory changed before agent resume.",
          projectId: payload.projectId,
          worktreeId: payload.worktreeId,
        });
      }

      const recovery = await resolveSessionRecovery({
        persistence: options.persistence,
        providers: options.providers,
        projectId: payload.projectId,
        worktreeId: payload.worktreeId,
        worktree,
        recoveryHandleId: payload.recoveryHandleId,
        ...(payload.expected === undefined ? {} : { expected: payload.expected }),
        ...(repairSnapshot === undefined ? {} : { repairSnapshot: repairSnapshot.snapshot }),
        ...(repairProof === undefined ? {} : { requireCanonicalSelection: true }),
      });
      const beginCommit = () => {
        if (repairProof !== undefined) {
          const current = options.core
            .getSnapshot()
            .rows.find((candidate) => candidate.id === payload.worktreeId);
          validateSnapshotRow(current, payload.projectId);
          assertResumeAllowed(current);
        }
        context.beginCommit();
      };
      await options.launchPreflight(recovery.harness.id, {
        signal: context.signal,
        beginMutation: beginCommit,
      });

      const sessionNeedsSeed = recovery.stationSession === undefined;
      const sessionId =
        recovery.stationSession?.id ?? recovery.handle.sessionId ?? idFactory.sessionId();
      let seededSession: Awaited<ReturnType<typeof seedSession>>["session"] | undefined;
      const revalidateResume =
        repairAction === undefined || repairProof === undefined
          ? undefined
          : async () => {
              await authorizeRepairRecovery(
                options.repairRecoveryAuthorization,
                repairAction,
                repairProof,
              );
              const current = options.core
                .getSnapshot()
                .rows.find((candidate) => candidate.id === payload.worktreeId);
              validateSnapshotRow(current, payload.projectId);
              assertResumeAllowed(current);
              if (current === undefined) {
                throw worktreeMissingError({
                  projectId: payload.projectId,
                  worktreeId: payload.worktreeId,
                  message: "The requested worktree is not visible before repair resume.",
                });
              }
              const captured = await options.persistence.readRecoveryRepairSnapshot();
              let expectedRecoveryInventoryDigest = repairProof.expectedRecoveryInventoryDigest;
              if (sessionNeedsSeed) {
                const initialSnapshot = repairSnapshot;
                const exactSeed = seededSession;
                if (exactSeed === undefined || initialSnapshot === undefined) {
                  throw commandValidationError({
                    code: "REPAIR_RECOVERY_INVENTORY_CHANGED",
                    message: "The imported recovery session was not seeded as authorized.",
                    projectId: payload.projectId,
                    worktreeId: payload.worktreeId,
                  });
                }
                expectedRecoveryInventoryDigest = recoveryInventoryDigest({
                  sessions: [...initialSnapshot.snapshot.sessions, exactSeed],
                  recoveryHandles: initialSnapshot.snapshot.recoveryHandles,
                });
              }
              if (captured.recoveryInventoryDigest !== expectedRecoveryInventoryDigest) {
                throw commandValidationError({
                  code: "REPAIR_RECOVERY_INVENTORY_CHANGED",
                  message: "Recovery inventory changed before agent launch.",
                  projectId: payload.projectId,
                  worktreeId: payload.worktreeId,
                });
              }
              const refreshed = await resolveSessionRecovery({
                persistence: options.persistence,
                providers: options.providers,
                projectId: payload.projectId,
                worktreeId: payload.worktreeId,
                worktree: worktreeObservationFromRow(
                  current,
                  options.providers.worktree.id,
                  nowIso(options.clock),
                ),
                recoveryHandleId: repairAction.recoveryHandleId,
                expected: {
                  sessionId: repairAction.sessionId,
                  provider: repairAction.provider,
                },
                repairSnapshot: captured.snapshot,
                requireCanonicalSelection: true,
              });
              return refreshed.resume;
            };

      let sessionSeeded = false;
      try {
        if (sessionNeedsSeed) {
          const seeded = await seedSession({
            persistence: options.persistence,
            sessionId,
            projectId: project.id,
            worktreeId: worktree.id,
            initialTitle: row?.title ?? worktree.branch,
            harness: recovery.harness.id,
            terminalProvider: terminalProviderId,
            clock: options.clock,
          });
          seededSession = seeded.session;
          sessionSeeded = true;
        }
        throwIfAborted(context.signal);

        // The harness adapter alone translates this provider-native resume target into CLI args.
        await ensureAgentWorkspace({
          terminal,
          harness: recovery.harness,
          launchPreflight: options.launchPreflight,
          project,
          worktree,
          sessionId,
          harnessOptions: { mode: "interactive" },
          layout: payload.terminal?.layout ?? project.defaults.layout,
          focus: payload.terminal?.focus,
          origin: payload.terminal?.origin,
          initialPrompt: payload.initialPrompt,
          resume: recovery.resume,
          ...(revalidateResume === undefined ? {} : { revalidateResume }),
          context: { ...context, beginCommit },
          clock: options.clock,
          logger: options.logger,
        });
        throwIfAborted(context.signal);
      } catch (error) {
        if (sessionSeeded) {
          await discardSessionSeedBestEffort({
            persistence: options.persistence,
            sessionId,
            context,
            logger: options.logger,
          });
        }
        throw error;
      }

      const nextSnapshot = await reconcileAndPublish({
        core: options.core,
        eventBus: options.eventBus,
        clock: options.clock,
        reason: "command:session.resumeAgent",
        trace: context.trace,
      });
      await publishSessionCreated({
        snapshot: nextSnapshot,
        sessionId,
        persistence: options.persistence,
        eventBus: options.eventBus,
        context,
        clock: options.clock,
      });
    });
  };
}

async function authorizeRepairRecovery(
  port: RecoveryRepairAuthorizationPort | undefined,
  action: Extract<RepairAction, { kind: "recovery-resume" }>,
  proof: RepairRecoveryMutationProof,
): Promise<void> {
  if (port === undefined) {
    throw commandValidationError({
      code: "REPAIR_RECOVERY_AUTHORIZATION_REQUIRED",
      message: "Repair resume requires a verified private journal, audit, and backup.",
      projectId: action.projectId,
      worktreeId: action.worktreeId,
    });
  }
  await port.authorize({ action, proof });
}

function assertResumeAllowed(row: WorktreeRow | undefined): void {
  // Relaunchable states (no agent / none / exited, and unknown with a stale or
  // missing terminal — the crash-recovery case) fall through. A genuinely live
  // agent — including unknown with an open, still externally focusable target — is not
  // overwritten. One shared predicate so resume and the Station launch agree.
  if (row === undefined || !worktreeHasLiveAgent(row)) {
    return;
  }
  const error: SafeError = {
    tag: "CommandValidationError",
    code: "SESSION_ALREADY_HAS_AGENT",
    message: "This worktree already has a primary agent session.",
    hint: "Focus the existing agent or close it before resuming an agent.",
    worktreeId: row.id,
  };
  if (row.agent?.sessionId !== undefined) error.sessionId = row.agent.sessionId;
  throw error;
}

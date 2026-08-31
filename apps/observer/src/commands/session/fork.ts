import type {
  ProviderProjectConfig,
  SessionForkCommandResult,
  WorktreeObservation,
} from "@station/contracts";
import type { RuntimeClock } from "@station/runtime";
import type {
  EventJournal,
  SessionSeedGroupProvenance,
  SessionStore,
} from "../../persistence/index.js";
import type { ProviderRegistry } from "../../providers/registry.js";
import type { ObserverCore } from "../../reconcile/core.js";
import type { ObserverEventBus } from "../../runtime/eventBus.js";
import type { StationLogger } from "../../stationLogger.js";
import {
  createWorktreeCreateCoordinator,
  type WorktreeCreateCoordinator,
} from "../../worktreeCreateCoordinator.js";
import { assertCommandType } from "../assertCommand.js";
import type { HarnessLaunchPreflight } from "../harnessLaunchPreflight.js";
import {
  resolveHarnessProviderOrThrow,
  resolveTerminalPlacementPortOrThrow,
  resolveTerminalProviderOrThrow,
} from "../providers.js";
import type { CommandResultHandler } from "../queue.js";
import { reconcileAndPublish } from "../reconcile.js";
import { commandPlacementResult, ensureAgentWorkspace } from "../terminalOperations.js";
import {
  commandValidationError,
  defaultSessionCommandIdFactory,
  discardSessionSeedBestEffort,
  findProjectOrThrow,
  isTerminalCleanupUncertain,
  publishSessionCreated,
  rememberedHarnessProviderForWorktree,
  removeWorktreeBestEffort,
  resolveForkSessionGroupPlacement,
  runProviderMutation,
  type SessionCommandIdFactory,
  seedSession,
  sessionSeedGroupPlacement,
  throwIfAborted,
  validateSnapshotRow,
} from "./shared.js";

export type CreateSessionForkHandlerOptions = {
  getProjects: () => readonly ProviderProjectConfig[];
  providers: ProviderRegistry;
  launchPreflight: HarnessLaunchPreflight;
  core: ObserverCore;
  persistence: SessionStore & EventJournal;
  eventBus?: ObserverEventBus | undefined;
  clock?: RuntimeClock | undefined;
  idFactory?: Partial<SessionCommandIdFactory> | undefined;
  logger?: StationLogger | undefined;
  worktreeCreates?: WorktreeCreateCoordinator | undefined;
};

/**
 * USE CASE
 *
 * Resolves and preflights the selected harness, forks an existing worktree onto an internal
 * branch, and atomically seeds its title with the source session's current Group when requested
 * before launching a fresh agent with pre-mutation placement authorization and
 * provider-side revalidation immediately before terminal mutation. Shared branch ownership spans
 * seed, launch, publication, and verified rollback while per-project capacity spans only provider
 * creation. Cleanup retires only fork-owned state. Success returns the exact created identities,
 * transaction-resolved Group identity when grouped, and the placement projection.
 */
export function createSessionForkHandler(
  options: CreateSessionForkHandlerOptions,
): CommandResultHandler<"session.fork"> {
  const worktreeCreates = options.worktreeCreates ?? createWorktreeCreateCoordinator();
  const idFactory = {
    ...defaultSessionCommandIdFactory,
    ...options.idFactory,
  };

  return async (context) => {
    assertCommandType(context, "session.fork");
    throwIfAborted(context.signal);

    const payload = context.command.payload;
    const project = findProjectOrThrow(options.getProjects(), payload.projectId);
    const terminalProviderId = payload.terminal.provider;
    const terminal = resolveTerminalProviderOrThrow(options.providers, terminalProviderId);
    const placementPort = resolveTerminalPlacementPortOrThrow(
      options.providers,
      terminalProviderId,
      payload.placement,
    );

    const snapshot = options.core.getSnapshot();
    const sourceRow = snapshot.rows.find((candidate) => candidate.id === payload.sourceWorktreeId);
    validateSnapshotRow(sourceRow, payload.projectId);
    if (sourceRow === undefined) {
      throw commandValidationError({
        code: "WORKTREE_NOT_FOUND",
        message: "The source worktree to fork is not visible in the current snapshot.",
        projectId: payload.projectId,
        worktreeId: payload.sourceWorktreeId,
      });
    }

    const groupIntent = resolveForkSessionGroupPlacement({
      snapshot,
      intent: payload.group,
      projectId: project.id,
      sourceWorktreeId: sourceRow.id,
    });
    const group = sessionSeedGroupPlacement(groupIntent, idFactory.sessionGroupId);

    const harnessProviderId =
      payload.harness?.provider ??
      (await rememberedHarnessProviderForWorktree({
        persistence: options.persistence,
        projectId: payload.projectId,
        worktreeId: sourceRow.id,
        worktreePath: sourceRow.path,
      })) ??
      project.defaults.harness;
    const harness = resolveHarnessProviderOrThrow(options.providers, harnessProviderId);
    await options.launchPreflight(harnessProviderId, {
      signal: context.signal,
      beginMutation: context.beginCommit,
    });

    const sessionId = idFactory.sessionId();
    const runtime = {
      clock: options.clock,
      signal: context.signal,
      trace: context.trace,
    };
    const copyDirty = payload.copyDirty ?? true;
    // Pin the new branch base to the source branch HEAD so the seeded apply is
    // conflict-free; an explicit base override may reintroduce conflicts.
    const base = payload.base ?? sourceRow.branch;

    let createdWorktree: WorktreeObservation | undefined;
    let sessionSeeded = false;
    let groupProvenance: SessionSeedGroupProvenance | undefined;
    let placementResult: ReturnType<typeof commandPlacementResult>;

    return worktreeCreates.run(project.id, payload.branch, context.signal, async (create) => {
      try {
        await runProviderMutation(
          {
            ...runtime,
            operation: `provider.${placementPort.id}.validatePlacement`,
            fallback: {
              tag: "TerminalProviderError",
              code: "TERMINAL_PLACEMENT_REJECTED",
              message: "The requested terminal placement is no longer valid.",
              provider: placementPort.id,
            },
          },
          () => placementPort.validatePlacement(payload.placement),
        );
        const worktree = await create(() =>
          runProviderMutation(
            {
              ...runtime,
              operation: `provider.${options.providers.worktree.id}.createWorktree`,
              fallback: {
                tag: "WorktreeProviderError",
                code: "WORKTREE_CREATE_FAILED",
                message: "The worktree provider failed to create the forked worktree.",
                provider: options.providers.worktree.id,
              },
            },
            () =>
              options.providers.worktree.createWorktree({
                project,
                branch: payload.branch,
                base,
                ...(copyDirty
                  ? { seedFrom: { path: sourceRow.path, worktreeId: sourceRow.id } }
                  : {}),
              }),
          ),
        );
        createdWorktree = worktree;
        throwIfAborted(context.signal);

        const seed = await seedSession({
          persistence: options.persistence,
          sessionId,
          projectId: project.id,
          worktreeId: worktree.id,
          initialTitle: payload.title ?? payload.branch,
          harness: harnessProviderId,
          terminalProvider: terminalProviderId,
          ...(group === undefined ? {} : { group }),
          clock: options.clock,
        });
        sessionSeeded = true;
        groupProvenance = seed.groupProvenance;
        throwIfAborted(context.signal);

        const resolvedPlacement = await ensureAgentWorkspace({
          terminal,
          harness,
          launchPreflight: options.launchPreflight,
          project,
          worktree,
          sessionId,
          harnessOptions: payload.harness,
          layout: payload.terminal.layout ?? project.defaults.layout,
          placementPort,
          placement: payload.placement,
          initialPrompt: payload.initialPrompt,
          context,
          clock: options.clock,
          logger: options.logger,
        });
        placementResult = commandPlacementResult(payload.placement, resolvedPlacement);
        throwIfAborted(context.signal);
      } catch (error) {
        if (isTerminalCleanupUncertain(error)) {
          try {
            await reconcileAndPublish({
              core: options.core,
              eventBus: options.eventBus,
              clock: options.clock,
              reason: "command:session.fork:cleanup-uncertain",
              trace: context.trace,
            });
          } catch (reconcileError) {
            await options.logger?.warn("Observer could not publish retained cleanup state.", {
              commandId: context.commandId,
              traceId: context.trace.traceId,
              operation: "session.fork.cleanup-uncertain.reconcile",
              error: reconcileError,
            });
          }
          throw error;
        }
        let worktreeRemoved = false;
        if (createdWorktree !== undefined) {
          worktreeRemoved = await removeWorktreeBestEffort({
            providers: options.providers,
            project,
            worktreeId: createdWorktree.id,
            expectedPath: createdWorktree.path,
            expectedBranch: createdWorktree.branch,
            expectedRegistrationIdentity: createdWorktree.registrationIdentity,
            context,
            logger: options.logger,
            clock: options.clock,
          });
        }
        if (sessionSeeded && worktreeRemoved) {
          await discardSessionSeedBestEffort({
            persistence: options.persistence,
            sessionId,
            ...(groupProvenance === undefined ? {} : { groupProvenance }),
            ...(worktreeRemoved && createdWorktree !== undefined
              ? { removedWorktree: { projectId: project.id, worktreeId: createdWorktree.id } }
              : {}),
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
        reason: "command:session.fork",
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
      const result: SessionForkCommandResult = {
        type: "session.fork",
        projectId: project.id,
        worktreeId: createdWorktree.id,
        sessionId,
        ...placementResult,
      };
      if (groupProvenance !== undefined) result.resolvedGroupId = groupProvenance.groupId;
      return result;
    });
  };
}

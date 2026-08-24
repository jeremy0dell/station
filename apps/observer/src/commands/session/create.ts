import type { ProviderProjectConfig, WorktreeObservation } from "@station/contracts";
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
  defaultSessionCommandIdFactory,
  discardSessionSeedBestEffort,
  findProjectOrThrow,
  isTerminalCleanupUncertain,
  publishSessionCreated,
  removeWorktreeBestEffort,
  runProviderMutation,
  type SessionCommandIdFactory,
  seedSession,
  sessionSeedGroupPlacement,
  throwIfAborted,
} from "./shared.js";

export type CreateSessionCreateHandlerOptions = {
  getProjects: () => readonly ProviderProjectConfig[];
  providers: ProviderRegistry;
  launchPreflight: HarnessLaunchPreflight;
  core: ObserverCore;
  persistence: SessionStore & EventJournal;
  eventBus?: ObserverEventBus | undefined;
  clock?: RuntimeClock | undefined;
  idFactory?: Partial<SessionCommandIdFactory> | undefined;
  logger?: StationLogger | undefined;
};

/**
 * USE CASE
 *
 * Preflights the selected harness, creates a session worktree on its generated branch, durably
 * seeds its independent title with optional atomic root Group placement or inline Group creation,
 * and launches its primary agent only after explicit placement authorization before
 * worktree mutation and revalidation before terminal mutation; rollback removes
 * only state owned by this command. Success returns the exact created identities
 * and the provider-resolved placement projection.
 */
export function createSessionCreateHandler(
  options: CreateSessionCreateHandlerOptions,
): CommandResultHandler<"session.create"> {
  const idFactory = {
    ...defaultSessionCommandIdFactory,
    ...options.idFactory,
  };

  return async (context) => {
    assertCommandType(context, "session.create");
    throwIfAborted(context.signal);

    const payload = context.command.payload;
    const project = findProjectOrThrow(options.getProjects(), payload.projectId);
    const terminal = resolveTerminalProviderOrThrow(options.providers, payload.terminal.provider);
    const placementPort = resolveTerminalPlacementPortOrThrow(
      options.providers,
      payload.terminal.provider,
      payload.placement,
    );
    const harness = resolveHarnessProviderOrThrow(options.providers, payload.harness.provider);
    await options.launchPreflight(payload.harness.provider, {
      signal: context.signal,
      beginMutation: context.beginCommit,
    });
    const sessionId = idFactory.sessionId();
    const group = sessionSeedGroupPlacement(payload.group, idFactory.sessionGroupId);
    const runtime = {
      clock: options.clock,
      signal: context.signal,
      trace: context.trace,
    };
    let createdWorktree: WorktreeObservation | undefined;
    let sessionSeeded = false;
    let groupProvenance: SessionSeedGroupProvenance | undefined;
    let placementResult: ReturnType<typeof commandPlacementResult>;

    try {
      // Authorization must be fresh at the first irreversible worktree mutation.
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
      const worktree = await runProviderMutation(
        {
          ...runtime,
          operation: `provider.${options.providers.worktree.id}.createWorktree`,
          fallback: {
            tag: "WorktreeProviderError",
            code: "WORKTREE_CREATE_FAILED",
            message: "The worktree provider failed to create the session worktree.",
            provider: options.providers.worktree.id,
          },
        },
        () =>
          options.providers.worktree.createWorktree({
            project,
            branch: payload.branch,
            ...(payload.base === undefined ? {} : { base: payload.base }),
          }),
      );
      createdWorktree = worktree;
      throwIfAborted(context.signal);

      const seed = await seedSession({
        persistence: options.persistence,
        sessionId,
        projectId: project.id,
        worktreeId: worktree.id,
        initialTitle: payload.title ?? payload.branch,
        harness: payload.harness.provider,
        terminalProvider: payload.terminal.provider,
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
            reason: "command:session.create:cleanup-uncertain",
            trace: context.trace,
          });
        } catch (reconcileError) {
          await options.logger?.warn("Observer could not publish retained cleanup state.", {
            commandId: context.commandId,
            traceId: context.trace.traceId,
            operation: "session.create.cleanup-uncertain.reconcile",
            error: reconcileError,
          });
        }
        throw error;
      }
      const worktreeRemoved =
        createdWorktree === undefined
          ? false
          : await removeWorktreeBestEffort({
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
          clock: options.clock,
        });
      }
      throw error;
    }

    const snapshot = await reconcileAndPublish({
      core: options.core,
      eventBus: options.eventBus,
      clock: options.clock,
      reason: "command:session.create",
      trace: context.trace,
    });
    await publishSessionCreated({
      snapshot,
      sessionId,
      persistence: options.persistence,
      eventBus: options.eventBus,
      context,
      clock: options.clock,
    });
    return {
      type: "session.create",
      projectId: project.id,
      worktreeId: createdWorktree.id,
      sessionId,
      ...placementResult,
    };
  };
}

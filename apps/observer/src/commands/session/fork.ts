import type { ProviderProjectConfig, WorktreeObservation } from "@station/contracts";
import type { RuntimeClock } from "@station/runtime";
import type { EventJournal, SessionStore } from "../../persistence/index.js";
import type { ProviderRegistry } from "../../providers/registry.js";
import type { ObserverCore } from "../../reconcile/core.js";
import type { ObserverEventBus } from "../../runtime/eventBus.js";
import type { StationLogger } from "../../stationLogger.js";
import { assertCommandType } from "../assertCommand.js";
import type { HarnessLaunchPreflight } from "../harnessLaunchPreflight.js";
import { resolveHarnessProviderOrThrow, resolveTerminalProviderOrThrow } from "../providers.js";
import type { CommandHandler } from "../queue.js";
import { reconcileAndPublish } from "../reconcile.js";
import { ensureAgentWorkspace } from "../terminalOperations.js";
import {
  commandValidationError,
  defaultSessionCommandIdFactory,
  discardSessionSeedBestEffort,
  findProjectOrThrow,
  publishSessionCreated,
  rememberedHarnessProviderForWorktree,
  removeWorktreeBestEffort,
  runProviderMutation,
  type SessionCommandIdFactory,
  seedSession,
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
};

/**
 * USE CASE
 *
 * Resolves and preflights the selected harness, forks an existing worktree onto an internal
 * branch, durably seeds its independent title, and launches a fresh agent; cleanup retires title
 * authority only after verified rollback.
 */
export function createSessionForkHandler(options: CreateSessionForkHandlerOptions): CommandHandler {
  const idFactory = {
    ...defaultSessionCommandIdFactory,
    ...options.idFactory,
  };

  return async (context) => {
    assertCommandType(context, "session.fork");
    throwIfAborted(context.signal);

    const payload = context.command.payload;
    const project = findProjectOrThrow(options.getProjects(), payload.projectId);
    const terminalProviderId = payload.terminal?.provider ?? project.defaults.terminal;
    const terminal = resolveTerminalProviderOrThrow(options.providers, terminalProviderId);

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
    await options.launchPreflight(harnessProviderId, context.signal);

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

    try {
      const worktree = await runProviderMutation(
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
            ...(copyDirty ? { seedFrom: { path: sourceRow.path, worktreeId: sourceRow.id } } : {}),
          }),
      );
      createdWorktree = worktree;
      throwIfAborted(context.signal);

      await seedSession({
        persistence: options.persistence,
        sessionId,
        projectId: project.id,
        worktreeId: worktree.id,
        initialTitle: payload.title ?? payload.branch,
        clock: options.clock,
      });
      sessionSeeded = true;
      throwIfAborted(context.signal);

      await ensureAgentWorkspace({
        terminal,
        harness,
        launchPreflight: options.launchPreflight,
        project,
        worktree,
        sessionId,
        harnessOptions: payload.harness,
        layout: payload.terminal?.layout ?? project.defaults.layout,
        focus: payload.terminal?.focus,
        origin: payload.terminal?.origin,
        initialPrompt: payload.initialPrompt,
        context,
        clock: options.clock,
        logger: options.logger,
      });
      throwIfAborted(context.signal);
    } catch (error) {
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
      if (sessionSeeded) {
        await discardSessionSeedBestEffort({
          persistence: options.persistence,
          sessionId,
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
  };
}

import type { ProviderProjectConfig, WorktreeObservation } from "@station/contracts";
import type { RuntimeClock } from "@station/runtime";
import type { EventJournal, SessionStore } from "../../persistence/index.js";
import type { ProviderRegistry } from "../../providers/registry.js";
import type { ObserverCore } from "../../reconcile/core.js";
import type { ObserverEventBus } from "../../runtime/eventBus.js";
import type { StationLogger } from "../../stationLogger.js";
import { assertCommandType } from "../assertCommand.js";
import type { CommandHandler } from "../queue.js";
import { reconcileAndPublish } from "../reconcile.js";
import type { TerminalIntentRunner } from "../terminalIntentRunner.js";
import {
  buildEnsureAgentWorkspaceIntent,
  commandValidationError,
  defaultSessionCommandIdFactory,
  deleteSessionTitleSeedBestEffort,
  findProjectOrThrow,
  publishSessionCreated,
  rememberedHarnessProviderForWorktree,
  removeWorktreeBestEffort,
  resolveHarnessProviderOrThrow,
  resolveTerminalProviderOrThrow,
  runProviderMutation,
  type SessionCommandIdFactory,
  seedSessionTitle,
  throwIfAborted,
  validateSnapshotRow,
} from "./shared.js";

export type CreateSessionForkHandlerOptions = {
  getProjects: () => readonly ProviderProjectConfig[];
  providers: ProviderRegistry;
  terminalIntentRunner: TerminalIntentRunner;
  core: ObserverCore;
  persistence: SessionStore & EventJournal;
  eventBus?: ObserverEventBus | undefined;
  clock?: RuntimeClock | undefined;
  idFactory?: Partial<SessionCommandIdFactory> | undefined;
  logger?: StationLogger | undefined;
  commandTimeoutMs?: number | undefined;
};

/**
 * Fork branches off an existing worktree: it creates a new worktree on a new branch
 * based on the source branch HEAD, copies the source's uncommitted working tree into
 * it (when copyDirty), then launches a fresh agent. It inherits the source worktree's
 * harness and reuses the same launch seam as session.create/startAgent. There is no
 * live-agent guard on the source — the source agent keeps running.
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
    resolveTerminalProviderOrThrow(options.providers, terminalProviderId);

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
    resolveHarnessProviderOrThrow(options.providers, harnessProviderId);

    const sessionId = idFactory.sessionId();
    const runtime = {
      clock: options.clock,
      commandTimeoutMs: options.commandTimeoutMs,
      signal: context.signal,
      trace: context.trace,
    };
    const copyDirty = payload.copyDirty ?? true;
    // Pin the new branch base to the source branch HEAD so the seeded apply is
    // conflict-free; an explicit base override may reintroduce conflicts.
    const base = payload.base ?? sourceRow.branch;

    let createdWorktree: WorktreeObservation | undefined;
    let seededSessionTitle = false;

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

      await seedSessionTitle({
        persistence: options.persistence,
        sessionId,
        projectId: project.id,
        worktreeId: worktree.id,
        title: payload.branch.trim(),
        clock: options.clock,
      });
      seededSessionTitle = true;
      throwIfAborted(context.signal);

      const receipt = await options.terminalIntentRunner.submitIntent(
        buildEnsureAgentWorkspaceIntent({
          commandId: context.commandId,
          project,
          worktree,
          sessionId,
          terminalProvider: terminalProviderId,
          harnessProvider: harnessProviderId,
          harness: payload.harness,
          layout: payload.terminal?.layout ?? project.defaults.layout,
          focus: payload.terminal?.focus,
          origin: payload.terminal?.origin,
          initialPrompt: payload.initialPrompt,
        }),
        {
          trace: context.trace,
          signal: context.signal,
          commandTimeoutMs: options.commandTimeoutMs,
        },
      );
      if (receipt.status === "rejected") {
        throw receipt.error;
      }
      throwIfAborted(context.signal);
    } catch (error) {
      if (seededSessionTitle) {
        await deleteSessionTitleSeedBestEffort({
          persistence: options.persistence,
          sessionId,
          context,
          logger: options.logger,
        });
      }
      if (createdWorktree !== undefined) {
        await removeWorktreeBestEffort({
          providers: options.providers,
          projectId: project.id,
          worktreeId: createdWorktree.id,
          expectedPath: createdWorktree.path,
          expectedBranch: createdWorktree.branch,
          context,
          logger: options.logger,
          clock: options.clock,
          commandTimeoutMs: options.commandTimeoutMs,
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

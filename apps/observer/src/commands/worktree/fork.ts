import type { CreateWorktreeRequest, ProviderProjectConfig } from "@station/contracts";
import type { JsonlLogger } from "@station/observability";
import type { RuntimeClock } from "@station/runtime";
import type { ProviderRegistry } from "../../providers/registry.js";
import type { ObserverCore } from "../../reconcile/core.js";
import type { ObserverEventBus } from "../../runtime/eventBus.js";
import { assertCommandType } from "../assertCommand.js";
import type { CommandHandler } from "../queue.js";
import { reconcileAndPublish } from "../reconcile.js";
import {
  commandValidationError,
  findProjectOrThrow,
  runProviderMutation,
  throwIfAborted,
  validateSnapshotRow,
} from "../session/shared.js";

export type WorktreeForkHandlerOptions = {
  getProjects: () => readonly ProviderProjectConfig[];
  providers: ProviderRegistry;
  core: ObserverCore;
  eventBus?: ObserverEventBus | undefined;
  clock?: RuntimeClock | undefined;
  commandTimeoutMs?: number | undefined;
  logger?: JsonlLogger | undefined;
};

/**
 * Worktree-only half of session.fork for Station: branch off the source
 * worktree's HEAD and seed its working tree (when copyDirty), then let Station
 * host the inherited harness itself via prepareExternalLaunch. Unlike
 * session.fork it mints no session and launches no terminal. There is no
 * live-agent guard on the source — the seed is a read-only snapshot.
 */
export function createWorktreeForkHandler(options: WorktreeForkHandlerOptions): CommandHandler {
  return async (context) => {
    assertCommandType(context, "worktree.fork");
    throwIfAborted(context.signal);

    const payload = context.command.payload;
    const project = findProjectOrThrow(options.getProjects(), payload.projectId);

    const sourceRow = options.core
      .getSnapshot()
      .rows.find((candidate) => candidate.id === payload.sourceWorktreeId);
    validateSnapshotRow(sourceRow, payload.projectId);
    if (sourceRow === undefined) {
      throw commandValidationError({
        code: "WORKTREE_NOT_FOUND",
        message: "The source worktree to fork is not visible in the current snapshot.",
        projectId: payload.projectId,
        worktreeId: payload.sourceWorktreeId,
      });
    }

    const copyDirty = payload.copyDirty ?? true;
    // Pin the new branch base to the source branch HEAD so the seeded apply is
    // conflict-free; an explicit base override may reintroduce conflicts.
    const request: CreateWorktreeRequest = {
      project,
      branch: payload.branch,
      base: payload.base ?? sourceRow.branch,
    };
    if (copyDirty) {
      request.seedFrom = { path: sourceRow.path, worktreeId: sourceRow.id };
    }

    await runProviderMutation(
      {
        clock: options.clock,
        commandTimeoutMs: options.commandTimeoutMs,
        signal: context.signal,
        trace: context.trace,
        operation: `provider.${options.providers.worktree.id}.createWorktree`,
        fallback: {
          tag: "WorktreeProviderError",
          code: "WORKTREE_CREATE_FAILED",
          message: "The worktree provider failed to create the forked worktree.",
          provider: options.providers.worktree.id,
        },
      },
      () => options.providers.worktree.createWorktree(request),
    );
    throwIfAborted(context.signal);

    await reconcileAndPublish({
      core: options.core,
      eventBus: options.eventBus,
      clock: options.clock,
      reason: "command:worktree.fork",
      trace: context.trace,
    });
  };
}

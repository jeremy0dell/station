import type { CreateWorktreeRequest, ProviderProjectConfig } from "@station/contracts";
import type { RuntimeClock } from "@station/runtime";
import type { ProviderRegistry } from "../../providers/registry.js";
import type { ObserverCore } from "../../reconcile/core.js";
import type { ObserverEventBus } from "../../runtime/eventBus.js";
import type { StationLogger } from "../../stationLogger.js";
import { assertCommandType } from "../assertCommand.js";
import type { HarnessLaunchPreflight } from "../harnessLaunchPreflight.js";
import type { CommandHandler } from "../queue.js";
import { reconcileAndPublish } from "../reconcile.js";
import {
  commandValidationError,
  findProjectOrThrow,
  throwIfAborted,
  validateSnapshotRow,
} from "../session/shared.js";
import { runCreateWorktreeMutation } from "./createMutation.js";

export type WorktreeForkHandlerOptions = {
  getProjects: () => readonly ProviderProjectConfig[];
  providers: ProviderRegistry;
  launchPreflight: HarnessLaunchPreflight;
  core: ObserverCore;
  eventBus?: ObserverEventBus | undefined;
  clock?: RuntimeClock | undefined;
  commandTimeoutMs?: number | undefined;
  logger?: StationLogger | undefined;
};

/**
 * USE CASE
 *
 * Worktree-only half of session.fork: branch off the source HEAD and seed its
 * working tree (when copyDirty), minting no session and launching no terminal so
 * Station can host the inherited harness itself. A selected launch harness is
 * preflighted before mutation. No live-agent guard on the source — the seed is a read-only snapshot.
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
    if (payload.launchHarness !== undefined) {
      await options.launchPreflight(payload.launchHarness, context.signal);
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

    await runCreateWorktreeMutation({
      providers: options.providers,
      request,
      failureMessage: "The worktree provider failed to create the forked worktree.",
      repairReason: "repair:command:worktree.fork",
      core: options.core,
      context,
      eventBus: options.eventBus,
      clock: options.clock,
      commandTimeoutMs: options.commandTimeoutMs,
      logger: options.logger,
    });
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

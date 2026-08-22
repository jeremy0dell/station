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
import { findProjectOrThrow, runProviderMutation, throwIfAborted } from "../session/shared.js";

export type CreateWorktreeCreateHandlerOptions = {
  getProjects: () => readonly ProviderProjectConfig[];
  providers: ProviderRegistry;
  launchPreflight: HarnessLaunchPreflight;
  core: ObserverCore;
  eventBus?: ObserverEventBus | undefined;
  clock?: RuntimeClock | undefined;
  logger?: StationLogger | undefined;
};

/**
 * USE CASE
 *
 * Worktree-only half of session.create for Station: create and publish the
 * worktree, preflighting the selected launch harness before mutation when Station
 * will immediately host an agent through prepareExternalLaunch.
 */
export function createWorktreeCreateHandler(
  options: CreateWorktreeCreateHandlerOptions,
): CommandHandler {
  return async (context) => {
    assertCommandType(context, "worktree.create");
    throwIfAborted(context.signal);

    const payload = context.command.payload;
    const project = findProjectOrThrow(options.getProjects(), payload.projectId);
    if (payload.launchHarness !== undefined) {
      await options.launchPreflight(payload.launchHarness, {
        signal: context.signal,
        beginMutation: context.beginCommit,
      });
    }

    const request: CreateWorktreeRequest = { project, branch: payload.branch };
    if (payload.base !== undefined) {
      request.base = payload.base;
    }
    if (payload.path !== undefined) {
      request.path = payload.path;
    }

    await runProviderMutation(
      {
        clock: options.clock,
        signal: context.signal,
        trace: context.trace,
        operation: `provider.${options.providers.worktree.id}.createWorktree`,
        fallback: {
          tag: "WorktreeProviderError",
          code: "WORKTREE_CREATE_FAILED",
          message: "The worktree provider failed to create the worktree.",
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
      reason: "command:worktree.create",
      trace: context.trace,
    });
  };
}

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
import { findProjectOrThrow, throwIfAborted } from "../session/shared.js";
import { runCreateWorktreeMutation } from "./createMutation.js";

export type CreateWorktreeCreateHandlerOptions = {
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
      await options.launchPreflight(payload.launchHarness, context.signal);
    }

    const request: CreateWorktreeRequest = { project, branch: payload.branch };
    if (payload.base !== undefined) {
      request.base = payload.base;
    }
    if (payload.path !== undefined) {
      request.path = payload.path;
    }

    await runCreateWorktreeMutation({
      providers: options.providers,
      request,
      failureMessage: "The worktree provider failed to create the worktree.",
      repairReason: "repair:command:worktree.create",
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
      reason: "command:worktree.create",
      trace: context.trace,
    });
  };
}

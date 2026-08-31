import type { CreateWorktreeRequest, ProviderProjectConfig } from "@station/contracts";
import { type RuntimeClock, safeErrorFromUnknown } from "@station/runtime";
import type { ProviderRegistry } from "../../providers/registry.js";
import type { ObserverCore } from "../../reconcile/core.js";
import type { ObserverEventBus } from "../../runtime/eventBus.js";
import type { StationLogger } from "../../stationLogger.js";
import { assertCommandType } from "../assertCommand.js";
import type { HarnessLaunchPreflight } from "../harnessLaunchPreflight.js";
import type { CommandResultHandler } from "../queue.js";
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
 * will immediately host an agent through prepareExternalLaunch. Exact provider-returned
 * launch evidence commits through the serialized snapshot writer before publication;
 * ambiguous evidence and worktree-only creation retain synchronous reconciliation.
 */
export function createWorktreeCreateHandler(
  options: CreateWorktreeCreateHandlerOptions,
): CommandResultHandler<"worktree.create"> {
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

    const worktree = await runProviderMutation(
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

    const result = {
      type: "worktree.create",
      projectId: project.id,
      worktreeId: worktree.id,
    } as const;
    let requiresReconcile = payload.launchHarness === undefined;
    if (payload.launchHarness !== undefined) {
      try {
        const projection = await options.core.commitCreatedWorktreeObservation({
          projectId: project.id,
          worktree,
        });
        if (projection.status === "rejected") {
          requiresReconcile = true;
          await options.logger
            ?.warn("Created worktree evidence required reconciliation fallback.", {
              projectId: project.id,
              worktreeId: worktree.id,
              reason: projection.reason,
            })
            .catch(() => undefined);
        } else {
          for (const event of projection.events) {
            options.eventBus?.publish(event);
          }
        }
      } catch (cause) {
        requiresReconcile = true;
        const error = safeErrorFromUnknown(cause, {
          tag: "ObserverProjectionError",
          code: "WORKTREE_CREATE_PROJECTION_FAILED",
          message: "Created worktree evidence could not be projected.",
        });
        await options.logger
          ?.warn("Created worktree evidence required reconciliation fallback.", {
            projectId: project.id,
            worktreeId: worktree.id,
            error,
          })
          .catch(() => undefined);
      }
    }

    if (requiresReconcile) {
      await reconcileAndPublish({
        core: options.core,
        eventBus: options.eventBus,
        clock: options.clock,
        reason: "command:worktree.create",
        trace: context.trace,
      });
    }
    // The external mutation is already complete; make its canonical visibility settle before
    // recording a late cancellation so clients never observe a cancelled-but-missing worktree.
    throwIfAborted(context.signal);
    return result;
  };
}

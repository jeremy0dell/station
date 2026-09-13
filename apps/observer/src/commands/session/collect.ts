import type { RuntimeClock } from "@station/runtime";
import type { ProviderRegistry } from "../../providers/registry.js";
import type { ObserverCore } from "../../reconcile/core.js";
import type { ObserverEventBus } from "../../runtime/eventBus.js";
import type { WorktreeMutationCoordinator } from "../../worktreeMutationCoordinator.js";
import { assertCommandType } from "../assertCommand.js";
import { resolveSessionOrThrow } from "../cleanup/index.js";
import type { CommandHandler } from "../queue.js";
import { reconcileAndPublish } from "../reconcile.js";

/**
 * USE CASE
 *
 * Retrieves a cloud session's changes into an isolated local result directory and publishes
 * its location. Collection never applies patches or changes the local worktree.
 */
export function createSessionCollectHandler(options: {
  core: ObserverCore;
  providers: ProviderRegistry;
  eventBus?: ObserverEventBus | undefined;
  clock?: RuntimeClock | undefined;
  worktreeMutations: WorktreeMutationCoordinator;
}): CommandHandler {
  return async (context) => {
    assertCommandType(context, "session.collect");
    const session = resolveSessionOrThrow(
      options.core.getSnapshot(),
      context.command.payload.sessionId,
    );
    const execution =
      session.execution === undefined
        ? undefined
        : options.providers.executions.get(session.execution.provider);
    if (execution === undefined)
      throw {
        tag: "AgentExecutionError",
        code: "EXECUTION_UNAVAILABLE",
        message: "Collection requires a configured cloud session.",
      };
    await options.worktreeMutations.run(session.projectId, session.worktreeId, async () => {
      context.beginCommit();
      await execution.collect(session.id);
      await reconcileAndPublish({
        core: options.core,
        eventBus: options.eventBus,
        clock: options.clock,
        reason: "command:session.collect",
        trace: context.trace,
      });
    });
  };
}

import type { CreateWorktreeRequest, WorktreeObservation } from "@station/contracts";
import { isSafeError, type RuntimeClock } from "@station/runtime";
import type { ProviderRegistry } from "../../providers/registry.js";
import type { ObserverCore } from "../../reconcile/core.js";
import type { ObserverEventBus } from "../../runtime/eventBus.js";
import type { StationLogger } from "../../stationLogger.js";
import type { CommandHandlerContext } from "../queue.js";
import { reconcileAndPublish } from "../reconcile.js";
import { runProviderMutation } from "../session/shared.js";

const outcomeUnknownCode = "WORKTREE_CREATE_OUTCOME_UNKNOWN";

export async function runCreateWorktreeMutation(input: {
  providers: ProviderRegistry;
  request: CreateWorktreeRequest;
  failureMessage: string;
  repairReason: string;
  core: ObserverCore;
  context: CommandHandlerContext;
  eventBus?: ObserverEventBus | undefined;
  clock?: RuntimeClock | undefined;
  commandTimeoutMs?: number | undefined;
  logger?: StationLogger | undefined;
}): Promise<WorktreeObservation> {
  try {
    return await runProviderMutation(
      {
        clock: input.clock,
        commandTimeoutMs: input.commandTimeoutMs,
        signal: input.context.signal,
        trace: input.context.trace,
        operation: `provider.${input.providers.worktree.id}.createWorktree`,
        fallback: {
          tag: "WorktreeProviderError",
          code: "WORKTREE_CREATE_FAILED",
          message: input.failureMessage,
          provider: input.providers.worktree.id,
        },
        timeoutFallback: {
          tag: "TimeoutError",
          code: outcomeUnknownCode,
          message: "The worktree provider timed out before confirming whether creation completed.",
          hint: "Refresh worktrees before retrying because the requested worktree may already exist.",
          provider: input.providers.worktree.id,
        },
      },
      (signal) => input.providers.worktree.createWorktree({ ...input.request, signal }),
    );
  } catch (error) {
    if (!isSafeError(error) || error.code !== outcomeUnknownCode) {
      throw error;
    }

    // A timeout can win after external mutation; repair without holding the response behind a full scan.
    void reconcileAndPublish({
      core: input.core,
      eventBus: input.eventBus,
      clock: input.clock,
      reason: input.repairReason,
      trace: input.context.trace,
    }).catch((repairError: unknown) => {
      const warning = input.logger?.warn("Worktree create timeout repair failed.", {
        commandId: input.context.commandId,
        traceId: input.context.trace.traceId,
        provider: input.providers.worktree.id,
        operation: "createWorktree.repair",
        error: repairError,
      });
      void warning?.catch(() => undefined);
    });
    throw error;
  }
}

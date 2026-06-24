import type { StationSnapshot } from "@station/contracts";
import type { RuntimeClock } from "@station/runtime";
import type { ObserverCore } from "../reconcile/core.js";
import type { ObserverEventBus } from "../runtime/eventBus.js";
import { assertCommandType } from "./assertCommand.js";
import type { CommandHandler } from "./queue.js";

export type ReconcileAndPublishOptions = {
  core: ObserverCore;
  eventBus?: ObserverEventBus | undefined;
  clock?: RuntimeClock | undefined;
};

export async function reconcileAndPublish(
  options: ReconcileAndPublishOptions & {
    reason: string;
    trace?: {
      traceId?: string | undefined;
      spanId?: string | undefined;
    };
  },
): Promise<StationSnapshot> {
  const snapshot = await options.core.reconcile(options.reason);
  options.eventBus?.publish({
    type: "observer.reconciled",
    at: snapshot.generatedAt,
    changed: 0,
    ...(options.trace?.traceId === undefined ? {} : { traceId: options.trace.traceId }),
    ...(options.trace?.spanId === undefined ? {} : { spanId: options.trace.spanId }),
  });
  return snapshot;
}

export function createObserverReconcileHandler(
  options: ReconcileAndPublishOptions,
): CommandHandler {
  return async (context) => {
    assertCommandType(context, "observer.reconcile");
    await reconcileAndPublish({
      ...options,
      reason: context.command.payload.reason ?? "command",
      trace: context.trace,
    });
  };
}

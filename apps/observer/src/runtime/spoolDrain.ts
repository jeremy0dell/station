import type { HarnessEventReport } from "@station/contracts";
import type { RuntimeBoundaryResult, RuntimeClock } from "@station/runtime";
import { runRuntimeBoundary } from "@station/runtime";
import type { HarnessIngressQueue } from "../hooks/harnessIngressQueue.js";
import type { ProviderHookIngress } from "../hooks/ingestion.js";
import {
  drainProviderIngressSpool,
  type ProviderIngressSpoolDrainResult,
  type ProviderIngressSpoolStore,
} from "../hooks/spool.js";
import type { EventJournal } from "../persistence/index.js";
import type { ObserverEventBus } from "./eventBus.js";
import type { HarnessReportProcessorDeps } from "./harnessReportProcessor.js";
import { processHarnessIngressReport } from "./harnessReportProcessor.js";

export type SpoolDrainDeps = {
  spoolStore?: ProviderIngressSpoolStore;
  persistence: EventJournal;
  eventBus: ObserverEventBus;
  clock: RuntimeClock;
  providerHookIngress: ProviderHookIngress;
  harnessIngressQueue: HarnessIngressQueue;
  harnessReportDeps: HarnessReportProcessorDeps;
};

// Bounds one replay pass so a large backlog cannot hold the startup reconcile or health answers for minutes.
const spoolReplayBatchRecords = 200;

/**
 * USE CASE
 *
 * Replays durable provider ingress in bounded batches before acknowledging spool records or queued reports.
 * A batch that leaves records behind schedules the next batch in the background while it makes progress.
 */
export function createSpoolDrainer(deps: SpoolDrainDeps) {
  let configuredSpoolDrain: Promise<void> | undefined;
  const drainRemainingInBackground = (): void => {
    setImmediate(() => {
      void drainConfiguredSpool().catch(() => undefined);
    });
  };

  const drainConfiguredSpool = async (): Promise<void> => {
    if (deps.spoolStore === undefined) {
      return;
    }
    if (configuredSpoolDrain !== undefined) {
      await configuredSpoolDrain;
      return;
    }
    const spoolStore = deps.spoolStore;

    const processReport = (report: HarnessEventReport) =>
      processHarnessIngressReport(deps.harnessReportDeps, report);

    configuredSpoolDrain = runRuntimeBoundary(
      {
        operation: "observer.hookSpool.drain",
        clock: deps.clock,
        error: {
          tag: "HookSpoolError",
          code: "HOOK_SPOOL_DRAIN_FAILED",
          message: "Observer could not drain the hook spool.",
        },
      },
      () =>
        drainProviderIngressSpool({
          store: spoolStore,
          persistence: deps.persistence,
          eventBus: deps.eventBus,
          clock: deps.clock,
          ingest: (event) =>
            deps.providerHookIngress.ingest(event, {
              triggerReconcile: false,
              reportHarnessEvent: processReport,
            }),
          report: processReport,
          maxRecords: spoolReplayBatchRecords,
        }),
    )
      .then((result: RuntimeBoundaryResult<ProviderIngressSpoolDrainResult>) => {
        if (!result.ok) {
          throw result.error;
        }
        deps.harnessIngressQueue.recordSpoolDrain(result.value);
        // Stopping when nothing drained keeps a permanently failing record from re-running the batch forever.
        if (result.value.remaining > 0 && result.value.drained > 0) {
          drainRemainingInBackground();
        }
      })
      .finally(() => {
        configuredSpoolDrain = undefined;
      });

    await configuredSpoolDrain;
  };

  const drainConfiguredSpoolAndQueue = async (): Promise<void> => {
    await drainConfiguredSpool();
    await deps.harnessIngressQueue.drain();
  };

  return { drainConfiguredSpool, drainConfiguredSpoolAndQueue };
}

import type { RuntimeBoundaryResult, RuntimeClock } from "@station/runtime";
import { runRuntimeBoundary } from "@station/runtime";
import type { HarnessIngressQueue } from "../hooks/harnessIngressQueue.js";
import type { ProviderHookIngress } from "../hooks/ingestion.js";
import { drainProviderIngressSpool, type ProviderIngressSpoolDrainResult } from "../hooks/spool.js";
import type { ObserverPersistence } from "../persistence/index.js";
import type { ObserverEventBus } from "./eventBus.js";
import type { HarnessReportProcessorDeps } from "./harnessReportProcessor.js";
import { processHarnessIngressReport } from "./harnessReportProcessor.js";
import type { ReconcileScheduler } from "./reconcileScheduler.js";

export type SpoolDrainDeps = {
  hookSpoolDir?: string;
  persistence: ObserverPersistence;
  eventBus: ObserverEventBus;
  clock: RuntimeClock;
  providerHookIngress: ProviderHookIngress;
  harnessIngressQueue: HarnessIngressQueue;
  harnessReportDeps: HarnessReportProcessorDeps;
  reconcileScheduler: ReconcileScheduler;
};

export function createSpoolDrainer(deps: SpoolDrainDeps) {
  let configuredSpoolDrain: Promise<void> | undefined;

  const drainConfiguredSpool = async (): Promise<void> => {
    if (deps.hookSpoolDir === undefined) {
      return;
    }
    if (configuredSpoolDrain !== undefined) {
      await configuredSpoolDrain;
      return;
    }
    const spoolDir = deps.hookSpoolDir;

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
          spoolDir,
          persistence: deps.persistence,
          eventBus: deps.eventBus,
          clock: deps.clock,
          ingest: (event) => deps.providerHookIngress.ingest(event, { triggerReconcile: false }),
          report: async (report) => {
            const result = await processHarnessIngressReport(deps.harnessReportDeps, report);
            if (result.reconcileReason !== undefined) {
              deps.reconcileScheduler.request(result.reconcileReason);
            }
            return result.receipt;
          },
        }),
    )
      .then((result: RuntimeBoundaryResult<ProviderIngressSpoolDrainResult>) => {
        if (!result.ok) {
          throw result.error;
        }
        deps.harnessIngressQueue.recordSpoolDrain(result.value);
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

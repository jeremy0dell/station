import { join } from "node:path";
import type {
  HarnessEventReport,
  HarnessEventReportReceipt,
  HarnessEventReportSpoolRecord,
  ProviderHookEvent,
  ProviderHookReceipt,
  ProviderHookSpoolRecord,
  StationEvent,
} from "@station/contracts";
import { ProviderHookEventSchema } from "@station/contracts";
import {
  type RuntimeClock,
  safeErrorFromUnknown,
  systemClock,
  toIsoTimestamp,
} from "@station/runtime";
import type { EventJournal } from "../persistence/index.js";
import type { ObserverEventBus } from "../runtime/eventBus.js";
import {
  createFilesystemProviderIngressSpoolStore,
  type ParsedProviderIngressSpoolRecord,
  type ProviderIngressSpoolEntry,
  type ProviderIngressSpoolStore,
} from "./spoolStore.js";

export {
  createFilesystemProviderIngressSpoolStore,
  type ProviderIngressSpoolStore,
  providerIngressSpoolDir,
} from "./spoolStore.js";

export type ProviderIngressSpoolDrainResult = {
  scanned: number;
  drained: number;
  failed: number;
};

export type DrainProviderIngressSpoolOptions = {
  store: ProviderIngressSpoolStore;
  ingest(event: ProviderHookEvent): Promise<ProviderHookReceipt>;
  report?(report: HarnessEventReport): Promise<HarnessEventReportReceipt>;
  persistence?: EventJournal;
  eventBus?: ObserverEventBus;
  clock?: RuntimeClock;
};

export async function listProviderIngressSpoolRecords(spoolDir: string): Promise<
  Array<{
    path: string;
    record: ProviderHookSpoolRecord | HarnessEventReportSpoolRecord;
  }>
> {
  const entries = await createFilesystemProviderIngressSpoolStore(spoolDir).list();
  return entries.flatMap((entry) =>
    entry.parsed === undefined
      ? []
      : [{ path: join(spoolDir, entry.id), record: entry.parsed.record }],
  );
}

export function providerIngressSpoolDepth(spoolDir: string): Promise<number> {
  return createFilesystemProviderIngressSpoolStore(spoolDir).depth();
}

export async function drainProviderIngressSpool(
  options: DrainProviderIngressSpoolOptions,
): Promise<ProviderIngressSpoolDrainResult> {
  const clock = options.clock ?? systemClock;
  const entries = await options.store.list();
  let drained = 0;
  let failed = 0;

  for (const entry of entries) {
    const parsed = entry.parsed;
    if (parsed === undefined) {
      failed += 1;
      continue;
    }
    const validEntry = { ...entry, parsed };
    try {
      const receipt = await drainSpoolRecord(validEntry, options);
      if (receipt.status === "drained") {
        // Removal is the durable acknowledgement that every direct processing step completed.
        await options.store.remove(entry.id);
        drained += 1;
      } else {
        await options.store.recordFailure(validEntry, receipt.error);
        failed += 1;
      }
    } catch (error) {
      await options.store.recordFailure(
        validEntry,
        safeErrorFromUnknown(error, {
          tag: "HookIngestionError",
          code: "HOOK_SPOOL_DRAIN_FAILED",
          message: "Hook spool record could not be delivered.",
          provider: spoolRecordProvider(parsed),
        }),
      );
      failed += 1;
    }
  }

  if (entries.length > 0) {
    const event: StationEvent = {
      type: "providerHook.spoolDrained",
      at: toIsoTimestamp(clock.now()),
      drained,
      failed,
    };
    await options.persistence?.recordEvent(event, {
      source: "provider-ingress-spool",
      createdAt: event.at,
    });
    options.eventBus?.publish(event);
  }

  return { scanned: entries.length, drained, failed };
}

async function drainSpoolRecord(
  entry: ProviderIngressSpoolEntry & { parsed: ParsedProviderIngressSpoolRecord },
  options: DrainProviderIngressSpoolOptions,
): Promise<
  | { status: "drained" }
  | {
      status: "failed";
      error:
        | ProviderHookSpoolRecord["lastError"]
        | HarnessEventReportSpoolRecord["lastError"]
        | undefined;
    }
> {
  if (entry.parsed.kind === "hook") {
    const record = entry.parsed.record;
    const event = ProviderHookEventSchema.parse({
      ...record.event,
      hookId: record.event.hookId ?? record.spoolId,
    });
    const receipt = await options.ingest(event);
    return (receipt.status === "ingested" || receipt.status === "ignored") &&
      receipt.error === undefined
      ? { status: "drained" }
      : { status: "failed", error: receipt.error };
  }

  if (options.report === undefined) {
    return {
      status: "failed",
      error: safeErrorFromUnknown(undefined, {
        tag: "HookIngestionError",
        code: "HOOK_REPORT_SPOOL_UNSUPPORTED",
        message: "Harness event report spool records are not supported by this drain path.",
        provider: entry.parsed.record.report.provider,
      }),
    };
  }

  const receipt = await options.report(entry.parsed.record.report);
  return receipt.status === "accepted" && receipt.error === undefined
    ? { status: "drained" }
    : { status: "failed", error: receipt.error };
}

function spoolRecordProvider(parsed: ParsedProviderIngressSpoolRecord): string {
  return parsed.kind === "hook" ? parsed.record.event.provider : parsed.record.report.provider;
}

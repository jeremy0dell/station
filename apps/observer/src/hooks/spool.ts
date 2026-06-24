import { readdir, readFile, unlink, writeFile } from "node:fs/promises";
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
import {
  HarnessEventReportSpoolRecordSchema,
  ProviderHookSpoolRecordSchema,
} from "@station/contracts";
import {
  type RuntimeClock,
  safeErrorFromUnknown,
  systemClock,
  toIsoTimestamp,
} from "@station/runtime";
import type { ObserverPersistence } from "../persistence/index.js";
import type { ObserverEventBus } from "../runtime/eventBus.js";

export type ProviderIngressSpoolDrainResult = {
  scanned: number;
  drained: number;
  failed: number;
};

export type DrainProviderIngressSpoolOptions = {
  spoolDir: string;
  ingest(event: ProviderHookEvent): Promise<ProviderHookReceipt>;
  report?(report: HarnessEventReport): Promise<HarnessEventReportReceipt>;
  persistence?: ObserverPersistence;
  eventBus?: ObserverEventBus;
  clock?: RuntimeClock;
};

type ParsedSpoolRecord =
  | {
      kind: "hook";
      record: ProviderHookSpoolRecord;
    }
  | {
      kind: "report";
      record: HarnessEventReportSpoolRecord;
    };

export function providerIngressSpoolDir(stateDir: string): string {
  return join(stateDir, "spool", "hooks");
}

export async function listProviderIngressSpoolRecords(spoolDir: string): Promise<
  Array<{
    path: string;
    record: ProviderHookSpoolRecord | HarnessEventReportSpoolRecord;
  }>
> {
  let entries: string[];
  try {
    entries = await readdir(spoolDir);
  } catch {
    return [];
  }

  const records: Array<{
    path: string;
    record: ProviderHookSpoolRecord | HarnessEventReportSpoolRecord;
  }> = [];
  for (const entry of entries.filter((name) => name.endsWith(".json")).sort()) {
    const path = join(spoolDir, entry);
    try {
      const raw = JSON.parse(await readFile(path, "utf8"));
      const parsed = parseSpoolRecord(raw);
      records.push({
        path,
        record: parsed.record,
      });
    } catch {
      // Invalid spool files are left in place for later diagnostics.
    }
  }
  return records;
}

export async function providerIngressSpoolDepth(spoolDir: string): Promise<number> {
  try {
    return (await readdir(spoolDir)).filter((name) => name.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

export async function drainProviderIngressSpool(
  options: DrainProviderIngressSpoolOptions,
): Promise<ProviderIngressSpoolDrainResult> {
  const clock = options.clock ?? systemClock;
  let entries: string[];
  try {
    entries = await readdir(options.spoolDir);
  } catch {
    entries = [];
  }
  const paths = entries
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((entry) => join(options.spoolDir, entry));
  let drained = 0;
  let failed = 0;

  for (const path of paths) {
    let parsed: ParsedSpoolRecord;
    try {
      const raw = JSON.parse(await readFile(path, "utf8"));
      parsed = parseSpoolRecord(raw);
    } catch {
      failed += 1;
      continue;
    }

    try {
      const receipt = await drainSpoolRecord(parsed, options);
      if (receipt.status === "drained") {
        await unlink(path);
        drained += 1;
      } else {
        await updateFailedSpoolRecord(path, parsed, receipt.error);
        failed += 1;
      }
    } catch (error) {
      await updateFailedSpoolRecord(
        path,
        parsed,
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

  if (paths.length > 0) {
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

  return {
    scanned: paths.length,
    drained,
    failed,
  };
}

async function drainSpoolRecord(
  parsed: ParsedSpoolRecord,
  options: DrainProviderIngressSpoolOptions,
): Promise<
  | {
      status: "drained";
    }
  | {
      status: "failed";
      error:
        | ProviderHookSpoolRecord["lastError"]
        | HarnessEventReportSpoolRecord["lastError"]
        | undefined;
    }
> {
  if (parsed.kind === "hook") {
    const receipt = await options.ingest(parsed.record.event);
    return receipt.status === "ingested"
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
        provider: parsed.record.report.provider,
      }),
    };
  }

  const receipt = await options.report(parsed.record.report);
  return receipt.status === "accepted"
    ? { status: "drained" }
    : { status: "failed", error: receipt.error };
}

function parseSpoolRecord(input: unknown): ParsedSpoolRecord {
  const hook = ProviderHookSpoolRecordSchema.safeParse(input);
  if (hook.success) {
    return { kind: "hook", record: hook.data };
  }
  return { kind: "report", record: HarnessEventReportSpoolRecordSchema.parse(input) };
}

async function updateFailedSpoolRecord(
  path: string,
  parsed: ParsedSpoolRecord,
  error:
    | ProviderHookSpoolRecord["lastError"]
    | HarnessEventReportSpoolRecord["lastError"]
    | undefined,
): Promise<void> {
  const updated = {
    ...parsed.record,
    attempts: parsed.record.attempts + 1,
  };
  if (error !== undefined) {
    updated.lastError = error;
  }
  const schema =
    parsed.kind === "hook" ? ProviderHookSpoolRecordSchema : HarnessEventReportSpoolRecordSchema;
  await writeFile(path, JSON.stringify(schema.parse(updated), null, 2), {
    mode: 0o600,
  });
}

function spoolRecordProvider(parsed: ParsedSpoolRecord): string {
  return parsed.kind === "hook" ? parsed.record.event.provider : parsed.record.report.provider;
}

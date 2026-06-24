import { randomUUID } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  HarnessEventReport,
  HarnessEventReportReceipt,
  HarnessEventReportSpoolRecord,
  ProviderHookEvent,
  ProviderHookReceipt,
  ProviderHookSpoolRecord,
  SafeError,
} from "@station/contracts";
import {
  HarnessEventReportReceiptSchema,
  HarnessEventReportSpoolRecordSchema,
  ProviderHookReceiptSchema,
  ProviderHookSpoolRecordSchema,
  STATION_SCHEMA_VERSION,
} from "@station/contracts";
import {
  type RuntimeClock,
  runRuntimeBoundary,
  systemClock,
  toIsoTimestamp,
} from "@station/runtime";

export type WriteProviderHookSpoolRecordOptions = {
  spoolDir: string;
  event: ProviderHookEvent;
  error?: SafeError;
  clock?: RuntimeClock;
  spoolId?: () => string;
};
export type WriteHookSpoolRecordOptions = WriteProviderHookSpoolRecordOptions;

export type WriteHarnessEventReportSpoolRecordOptions = {
  spoolDir: string;
  report: HarnessEventReport;
  error?: SafeError;
  clock?: RuntimeClock;
  spoolId?: () => string;
};

const defaultSpoolId = () => `spool_${Date.now()}_${randomUUID()}`;

export async function writeProviderHookSpoolRecord(
  options: WriteProviderHookSpoolRecordOptions,
): Promise<ProviderHookReceipt> {
  const clock = options.clock ?? systemClock;
  const spoolId = (options.spoolId ?? defaultSpoolId)();
  const result = await runRuntimeBoundary(
    {
      operation: "providerHooks.hookSpool.write",
      clock,
      error: {
        tag: "HookSpoolError",
        code: "HOOK_SPOOL_WRITE_FAILED",
        message: "Provider hook event could not be written to the provider ingress spool.",
        provider: options.event.provider,
      },
    },
    async () => {
      await mkdir(options.spoolDir, { recursive: true, mode: 0o700 });
      await chmod(options.spoolDir, 0o700);

      const record: ProviderHookSpoolRecord = ProviderHookSpoolRecordSchema.parse({
        schemaVersion: STATION_SCHEMA_VERSION,
        spoolId,
        createdAt: toIsoTimestamp(clock.now()),
        event: options.event,
        attempts: 0,
        ...(options.error === undefined ? {} : { lastError: options.error }),
      });
      await writeFile(join(options.spoolDir, `${spoolId}.json`), JSON.stringify(record, null, 2), {
        mode: 0o600,
        flag: "wx",
      });
    },
  );

  if (!result.ok) {
    throw result.error;
  }

  return ProviderHookReceiptSchema.parse({
    schemaVersion: STATION_SCHEMA_VERSION,
    hookId: options.event.hookId ?? spoolId,
    provider: options.event.provider,
    event: options.event.event,
    accepted: true,
    status: "spooled",
    receivedAt: options.event.receivedAt,
    spooled: true,
    ...(options.error === undefined ? {} : { error: options.error }),
  });
}

export const writeHookSpoolRecord = writeProviderHookSpoolRecord;

export async function writeHarnessEventReportSpoolRecord(
  options: WriteHarnessEventReportSpoolRecordOptions,
): Promise<HarnessEventReportReceipt> {
  const clock = options.clock ?? systemClock;
  const spoolId = (options.spoolId ?? defaultSpoolId)();
  const result = await runRuntimeBoundary(
    {
      operation: "providerHooks.harnessEventReportSpool.write",
      clock,
      error: {
        tag: "HookSpoolError",
        code: "HOOK_REPORT_SPOOL_WRITE_FAILED",
        message: "Harness event report could not be written to the hook spool.",
        provider: options.report.provider,
      },
    },
    async () => {
      await mkdir(options.spoolDir, { recursive: true, mode: 0o700 });
      await chmod(options.spoolDir, 0o700);

      const record: HarnessEventReportSpoolRecord = HarnessEventReportSpoolRecordSchema.parse({
        schemaVersion: STATION_SCHEMA_VERSION,
        spoolId,
        createdAt: toIsoTimestamp(clock.now()),
        report: options.report,
        attempts: 0,
        ...(options.error === undefined ? {} : { lastError: options.error }),
      });
      await writeFile(join(options.spoolDir, `${spoolId}.json`), JSON.stringify(record, null, 2), {
        mode: 0o600,
        flag: "wx",
      });
    },
  );

  if (!result.ok) {
    throw result.error;
  }

  return HarnessEventReportReceiptSchema.parse({
    schemaVersion: STATION_SCHEMA_VERSION,
    reportId: options.report.reportId,
    provider: options.report.provider,
    eventType: options.report.eventType,
    accepted: true,
    status: "spooled",
    receivedAt: options.report.observedAt,
    projected: false,
    scheduledReconcile: false,
    ...(options.error === undefined ? {} : { error: options.error }),
  });
}

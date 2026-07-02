import { randomUUID } from "node:crypto";
import {
  claudeHookPayloadReportId,
  claudeHookPayloadToHarnessEventReport,
  compactClaudeHookPayload,
  isClaudeForwardedEventType,
} from "@station/claude";
import {
  codexHookPayloadReportId,
  codexHookPayloadToHarnessEventReport,
  compactCodexHookPayload,
} from "@station/codex";
import type { ObserverPaths } from "@station/config";
import type {
  HarnessEventReport,
  HarnessEventReportReceipt,
  ProviderHookEvent,
  ProviderHookPayloadSummary,
  ProviderHookReceipt,
  SafeError,
} from "@station/contracts";
import {
  enrichStationHookIdentityPayload,
  ProviderHookEventSchema,
  ProviderHookReceiptSchema,
  parseProviderHookEventName,
  parseStationHookIdentityPayload,
  STATION_SCHEMA_VERSION,
} from "@station/contracts";
import {
  compactCursorProviderHookPayload,
  cursorProviderHookPayloadToHarnessEventReport,
} from "@station/cursor";
import { componentLogPath, createJsonlLogger, type JsonlLogger } from "@station/observability";
import { compactPiHookPayload, piHookPayloadToHarnessEventReport } from "@station/pi";
import { createObserverClient } from "@station/protocol";
import {
  type RuntimeClock,
  runRuntimeBoundaryWithTimeout,
  safeErrorFromUnknown,
  systemClock,
  toIsoTimestamp,
} from "@station/runtime";
import { normalizeWorktrunkLifecycleEvent } from "@station/worktrunk";
import { deliverProviderHookWithSpooling, type ProviderDeliveryAttempt } from "./deliveryPolicy.js";
import type { ProviderHookObserverStartupDeps } from "./observerStartup.js";
import { writeHarnessEventReportSpoolRecord, writeProviderHookSpoolRecord } from "./spool.js";

export type ProviderHookSenderOptions = {
  paths: ObserverPaths;
  configPath?: string;
  observerEntryPath?: string;
  autoStart?: boolean;
  deliveryTimeoutMs?: number;
  startupTimeoutMs?: number;
  rateLimitMs?: number;
};

type ProviderHookClientFactoryOptions = {
  timeoutMs: number;
};

export type ProviderHookSenderDeps = ProviderHookObserverStartupDeps & {
  clientFactory?: (
    socketPath: string,
    options: ProviderHookClientFactoryOptions,
  ) => ReturnType<typeof createObserverClient>;
  clock?: RuntimeClock;
  writeSpool?: typeof writeProviderHookSpoolRecord;
  writeReportSpool?: typeof writeHarnessEventReportSpoolRecord;
  hookId?: () => string;
  logger?: JsonlLogger;
};

export type SendProviderHookEventInput = ProviderHookSenderOptions & {
  provider: string;
  kind: ProviderHookEvent["kind"];
  event: string;
  payload?: unknown;
};

export type SendClaudeHookInput = ProviderHookSenderOptions & {
  payload: unknown;
  env?: NodeJS.ProcessEnv;
};

export type SendCodexHookInput = ProviderHookSenderOptions & {
  payload: unknown;
  env?: NodeJS.ProcessEnv;
};

export type SendCursorHookInput = ProviderHookSenderOptions & {
  payload: unknown;
  env?: NodeJS.ProcessEnv;
};

export type SendPiHookInput = ProviderHookSenderOptions & {
  eventType: string;
  payload: unknown;
  env?: NodeJS.ProcessEnv;
};

const defaultHookId = () => `hook_${Date.now()}_${randomUUID()}`;
const defaultDeliveryTimeoutMs = 2000;

export async function sendWorktrunkHookEvent(
  input: ProviderHookSenderOptions & { event: string; payload?: unknown },
  deps: ProviderHookSenderDeps = {},
): Promise<ProviderHookReceipt> {
  return sendProviderHookEvent(
    {
      ...input,
      provider: "worktrunk",
      kind: "worktree",
      event: normalizeWorktrunkLifecycleEvent(input.event),
    },
    deps,
  );
}

export async function sendProviderHookEvent(
  input: SendProviderHookEventInput,
  deps: ProviderHookSenderDeps = {},
): Promise<ProviderHookReceipt> {
  const clock = deps.clock ?? systemClock;
  const event = ProviderHookEventSchema.parse({
    schemaVersion: STATION_SCHEMA_VERSION,
    hookId: deps.hookId?.() ?? defaultHookId(),
    provider: input.provider,
    kind: input.kind,
    event: input.event,
    receivedAt: toIsoTimestamp(clock.now()),
    ...(input.payload === undefined ? {} : { payload: input.payload }),
  });
  const payloadSummary = payloadSummaryFor(input.payload);

  const deliveryInput: Parameters<typeof deliverProviderHookWithSpooling>[0] = {
    paths: input.paths,
    event,
    payloadSummary,
    autoStart: input.autoStart ?? true,
    startupTimeoutMs: input.startupTimeoutMs ?? 1500,
    rateLimitMs: input.rateLimitMs ?? 2000,
    deps,
    deliver: () =>
      attemptHookDelivery(
        input.paths,
        event,
        input.deliveryTimeoutMs ?? defaultDeliveryTimeoutMs,
        deps,
      ),
    spoolReceipt: (error) => spool(input.paths, event, error, deps),
    recordReceipt: ({ paths, event, payloadSummary, receipt }) =>
      logAndReturn(paths, event, receipt, payloadSummary, deps),
  };
  if (input.configPath !== undefined) {
    deliveryInput.configPath = input.configPath;
  }
  if (input.observerEntryPath !== undefined) {
    deliveryInput.observerEntryPath = input.observerEntryPath;
  }
  return deliverProviderHookWithSpooling(deliveryInput);
}

export async function sendClaudeHookPayload(
  input: SendClaudeHookInput,
  deps: ProviderHookSenderDeps = {},
): Promise<ProviderHookReceipt> {
  const clock = deps.clock ?? systemClock;
  const enrichedPayload = enrichStationHookIdentityPayload({
    payload: input.payload,
    env: input.env ?? process.env,
  });
  const eventName = parseProviderHookEventName(enrichedPayload) ?? "unknown";
  if (!hasStationOwnership(enrichedPayload)) {
    return ignoredProviderHookReceipt({
      provider: "claude",
      event: eventName,
      clock,
      hookId: deps.hookId,
    });
  }
  // Claude installs only rule-derived hook events, but a fallback global install can
  // surface user-added events; unlisted event types are dropped, never errors.
  if (!isClaudeForwardedEventType(eventName)) {
    return ignoredProviderHookReceipt({
      provider: "claude",
      event: eventName,
      clock,
      hookId: deps.hookId,
    });
  }

  const compaction = compactClaudeHookPayload(enrichedPayload);
  try {
    const observedAt = toIsoTimestamp(clock.now());
    const reportId = deps.hookId?.() ?? claudeHookPayloadReportId(compaction.payload, observedAt);
    const report = claudeHookPayloadToHarnessEventReport({
      reportId,
      observedAt,
      payload: compaction.payload,
      diagnostics: diagnosticsFromCompaction(compaction),
    });
    return providerHookReceiptFromHarnessReportReceipt(
      await sendHarnessEventReport(input, report, compactionSummary(compaction), deps),
    );
  } catch (error) {
    return rejectedProviderHookReceipt({
      provider: "claude",
      event: eventName,
      clock,
      error,
      hookId: deps.hookId,
    });
  }
}

export async function sendCodexHookPayload(
  input: SendCodexHookInput,
  deps: ProviderHookSenderDeps = {},
): Promise<ProviderHookReceipt> {
  const clock = deps.clock ?? systemClock;
  const enrichedPayload = enrichStationHookIdentityPayload({
    payload: input.payload,
    env: input.env ?? process.env,
  });
  const eventName = parseProviderHookEventName(enrichedPayload) ?? "unknown";
  if (!hasStationOwnership(enrichedPayload)) {
    return ignoredProviderHookReceipt({
      provider: "codex",
      event: eventName,
      clock,
      hookId: deps.hookId,
    });
  }

  const compaction = compactCodexHookPayload(enrichedPayload);
  try {
    const observedAt = toIsoTimestamp(clock.now());
    const reportId = deps.hookId?.() ?? codexHookPayloadReportId(compaction.payload, observedAt);
    const report = codexHookPayloadToHarnessEventReport({
      reportId,
      observedAt,
      payload: compaction.payload,
      diagnostics: diagnosticsFromCompaction(compaction),
    });
    return providerHookReceiptFromHarnessReportReceipt(
      await sendHarnessEventReport(input, report, compactionSummary(compaction), deps),
    );
  } catch (error) {
    return rejectedProviderHookReceipt({
      provider: "codex",
      event: eventName,
      clock,
      error,
      hookId: deps.hookId,
    });
  }
}

export async function sendCursorHookPayload(
  input: SendCursorHookInput,
  deps: ProviderHookSenderDeps = {},
): Promise<ProviderHookReceipt> {
  const clock = deps.clock ?? systemClock;
  const enrichedPayload = enrichStationHookIdentityPayload({
    payload: input.payload,
    env: input.env ?? process.env,
  });
  const eventName = parseProviderHookEventName(enrichedPayload) ?? "unknown";
  if (!hasStationOwnership(enrichedPayload)) {
    return ignoredProviderHookReceipt({
      provider: "cursor",
      event: eventName,
      clock,
      hookId: deps.hookId,
    });
  }

  const compaction = compactCursorProviderHookPayload(enrichedPayload);
  try {
    const report = cursorProviderHookPayloadToHarnessEventReport({
      reportId: deps.hookId?.() ?? defaultHookId(),
      observedAt: toIsoTimestamp(clock.now()),
      payload: compaction.payload,
      diagnostics: diagnosticsFromCompaction(compaction),
    });
    return providerHookReceiptFromHarnessReportReceipt(
      await sendHarnessEventReport(input, report, compactionSummary(compaction), deps),
    );
  } catch (error) {
    return rejectedProviderHookReceipt({
      provider: "cursor",
      event: eventName,
      clock,
      error,
      hookId: deps.hookId,
    });
  }
}

export async function sendPiHookPayload(
  input: SendPiHookInput,
  deps: ProviderHookSenderDeps = {},
): Promise<ProviderHookReceipt> {
  const clock = deps.clock ?? systemClock;
  const enrichedPayload = enrichStationHookIdentityPayload({
    payload: input.payload,
    env: input.env ?? process.env,
  });
  if (!hasStationOwnership(enrichedPayload)) {
    return ignoredProviderHookReceipt({
      provider: "pi",
      event: input.eventType,
      clock,
      hookId: deps.hookId,
    });
  }

  const compaction = compactPiHookPayload(input.eventType, enrichedPayload);
  try {
    const report = piHookPayloadToHarnessEventReport({
      reportId: deps.hookId?.() ?? defaultHookId(),
      eventType: input.eventType,
      observedAt: toIsoTimestamp(clock.now()),
      payload: compaction.payload,
      diagnostics: diagnosticsFromCompaction(compaction),
    });
    return providerHookReceiptFromHarnessReportReceipt(
      await sendHarnessEventReport(input, report, compactionSummary(compaction), deps),
    );
  } catch (error) {
    return rejectedProviderHookReceipt({
      provider: "pi",
      event: input.eventType,
      clock,
      error,
      hookId: deps.hookId,
    });
  }
}

export async function sendHarnessEventReport(
  options: ProviderHookSenderOptions,
  report: HarnessEventReport,
  payloadSummary: ProviderHookPayloadSummary,
  deps: ProviderHookSenderDeps = {},
): Promise<HarnessEventReportReceipt> {
  const syntheticEvent = ProviderHookEventSchema.parse({
    schemaVersion: STATION_SCHEMA_VERSION,
    hookId: report.reportId,
    provider: report.provider,
    kind: "harness",
    event: report.eventType,
    receivedAt: report.observedAt,
    ...(report.providerData === undefined ? {} : { payload: report.providerData }),
  });
  const deliveryInput: Parameters<typeof deliverProviderHookWithSpooling>[0] = {
    paths: options.paths,
    event: syntheticEvent,
    payloadSummary,
    autoStart: options.autoStart ?? true,
    startupTimeoutMs: options.startupTimeoutMs ?? 1500,
    rateLimitMs: options.rateLimitMs ?? 2000,
    deps,
    deliver: () =>
      attemptHarnessEventReportDelivery(
        options.paths,
        report,
        options.deliveryTimeoutMs ?? defaultDeliveryTimeoutMs,
        deps,
      ),
    spoolReceipt: async (error) =>
      providerHookReceiptFromHarnessReportReceipt(
        await spoolHarnessEventReport(options.paths, report, error, deps),
      ),
    recordReceipt: ({ paths, event, payloadSummary, receipt }) =>
      logAndReturn(paths, event, receipt, payloadSummary, deps),
  };
  if (options.configPath !== undefined) {
    deliveryInput.configPath = options.configPath;
  }
  if (options.observerEntryPath !== undefined) {
    deliveryInput.observerEntryPath = options.observerEntryPath;
  }
  const receipt = await deliverProviderHookWithSpooling(deliveryInput);
  return harnessReportReceiptFromProviderHookReceipt(report, receipt);
}

async function attemptHookDelivery(
  paths: ObserverPaths,
  event: ProviderHookEvent,
  timeoutMs: number,
  deps: ProviderHookSenderDeps,
): Promise<ProviderDeliveryAttempt> {
  const delivery = await deliverHook(paths, event, timeoutMs, deps);
  if (delivery.ok && delivery.value.status === "ingested") {
    return { receipt: delivery.value };
  }
  if (delivery.ok) {
    const attempt: ProviderDeliveryAttempt = {};
    if (delivery.value.error !== undefined) {
      attempt.error = delivery.value.error;
    }
    return attempt;
  }
  return { error: delivery.error };
}

async function attemptHarnessEventReportDelivery(
  paths: ObserverPaths,
  report: HarnessEventReport,
  timeoutMs: number,
  deps: ProviderHookSenderDeps,
): Promise<ProviderDeliveryAttempt> {
  const delivery = await deliverHarnessEventReport(paths, report, timeoutMs, deps);
  if (delivery.ok && delivery.value.status === "accepted") {
    return { receipt: providerHookReceiptFromHarnessReportReceipt(delivery.value) };
  }
  if (delivery.ok) {
    const attempt: ProviderDeliveryAttempt = {};
    if (delivery.value.error !== undefined) {
      attempt.error = delivery.value.error;
    }
    return attempt;
  }
  return { error: delivery.error };
}

async function deliverHook(
  paths: ObserverPaths,
  event: ProviderHookEvent,
  timeoutMs: number,
  deps: ProviderHookSenderDeps,
) {
  return runRuntimeBoundaryWithTimeout(
    {
      operation: "providerHooks.hook.deliver",
      clock: deps.clock,
      timeoutMs,
      error: {
        tag: "HookDeliveryError",
        code: "HOOK_DELIVERY_FAILED",
        message: "Hook event could not be delivered to the observer.",
        provider: event.provider,
      },
      timeoutError: {
        tag: "TimeoutError",
        code: "HOOK_DELIVERY_TIMEOUT",
        message: "Hook event delivery timed out.",
        provider: event.provider,
      },
    },
    async () => {
      const client = observerClient(paths.socketPath, timeoutMs, deps);
      const receipt = await client.ingestProviderHookEvent(event);
      if (receipt.status !== "ingested") {
        throw (
          receipt.error ??
          safeErrorFromUnknown(receipt, {
            tag: "HookDeliveryError",
            code: "HOOK_REJECTED",
            message: "Observer rejected the hook event.",
            provider: event.provider,
          })
        );
      }
      return receipt;
    },
  );
}

async function deliverHarnessEventReport(
  paths: ObserverPaths,
  report: HarnessEventReport,
  timeoutMs: number,
  deps: ProviderHookSenderDeps,
) {
  return runRuntimeBoundaryWithTimeout(
    {
      operation: "providerHooks.harnessEventReport.deliver",
      clock: deps.clock,
      timeoutMs,
      error: {
        tag: "HookDeliveryError",
        code: "HOOK_REPORT_DELIVERY_FAILED",
        message: "Harness event report could not be delivered to the observer.",
        provider: report.provider,
      },
      timeoutError: {
        tag: "TimeoutError",
        code: "HOOK_REPORT_DELIVERY_TIMEOUT",
        message: "Harness event report delivery timed out.",
        provider: report.provider,
      },
    },
    async () => {
      const client = observerClient(paths.socketPath, timeoutMs, deps);
      const receipt = await client.reportHarnessEvent(report);
      if (receipt.status !== "accepted") {
        throw (
          receipt.error ??
          safeErrorFromUnknown(receipt, {
            tag: "HookDeliveryError",
            code: "HOOK_REPORT_REJECTED",
            message: "Observer rejected the harness event report.",
            provider: report.provider,
          })
        );
      }
      return receipt;
    },
  );
}

async function spool(
  paths: ObserverPaths,
  event: ProviderHookEvent,
  error: SafeError | undefined,
  deps: ProviderHookSenderDeps,
): Promise<ProviderHookReceipt> {
  return (deps.writeSpool ?? writeProviderHookSpoolRecord)({
    spoolDir: paths.hookSpoolDir,
    event,
    ...(error === undefined ? {} : { error }),
    ...(deps.clock === undefined ? {} : { clock: deps.clock }),
  });
}

async function spoolHarnessEventReport(
  paths: ObserverPaths,
  report: HarnessEventReport,
  error: SafeError | undefined,
  deps: ProviderHookSenderDeps,
): Promise<HarnessEventReportReceipt> {
  return (deps.writeReportSpool ?? writeHarnessEventReportSpoolRecord)({
    spoolDir: paths.hookSpoolDir,
    report,
    ...(error === undefined ? {} : { error }),
    ...(deps.clock === undefined ? {} : { clock: deps.clock }),
  });
}

async function logAndReturn(
  paths: ObserverPaths,
  event: ProviderHookEvent,
  receipt: ProviderHookReceipt,
  payloadSummary: ProviderHookPayloadSummary,
  deps: ProviderHookSenderDeps,
): Promise<ProviderHookReceipt> {
  const logger =
    deps.logger ??
    createJsonlLogger({
      component: "hook",
      path: componentLogPath(paths.stateDir, "hook"),
      ...(deps.clock === undefined ? {} : { clock: deps.clock }),
    });
  try {
    const level =
      receipt.status === "ingested" ? "info" : receipt.status === "spooled" ? "warn" : "error";
    await logger.log({
      level,
      message:
        receipt.status === "ingested"
          ? "Provider hook delivered to observer."
          : receipt.status === "spooled"
            ? "Provider hook spooled for later delivery."
            : "Provider hook rejected.",
      provider: event.provider,
      attributes: {
        hookId: receipt.hookId,
        status: receipt.status,
        event: event.event,
        kind: event.kind,
        payloadSummary,
        ...(receipt.error === undefined ? {} : { error: receipt.error }),
      },
    });
  } catch {
    // Hook logging must never block provider hook completion.
  }
  return receipt;
}

function providerHookReceiptFromHarnessReportReceipt(
  receipt: HarnessEventReportReceipt,
): ProviderHookReceipt {
  const status = receipt.status === "accepted" ? "ingested" : receipt.status;
  const hookReceipt: ProviderHookReceipt = {
    schemaVersion: STATION_SCHEMA_VERSION,
    hookId: receipt.reportId,
    provider: receipt.provider,
    event: receipt.eventType,
    accepted: receipt.accepted,
    status,
    receivedAt: receipt.receivedAt,
  };
  if (status === "ingested") {
    hookReceipt.reconciled = false;
  }
  if (status === "spooled") {
    hookReceipt.spooled = true;
  }
  if (receipt.deduped !== undefined) {
    hookReceipt.deduped = receipt.deduped;
  }
  if (receipt.error !== undefined) {
    hookReceipt.error = receipt.error;
  }
  return ProviderHookReceiptSchema.parse(hookReceipt);
}

function harnessReportReceiptFromProviderHookReceipt(
  report: HarnessEventReport,
  receipt: ProviderHookReceipt,
): HarnessEventReportReceipt {
  return {
    schemaVersion: STATION_SCHEMA_VERSION,
    reportId: report.reportId,
    provider: report.provider,
    eventType: report.eventType,
    accepted: receipt.accepted,
    status:
      receipt.status === "ingested"
        ? "accepted"
        : receipt.status === "spooled"
          ? "spooled"
          : "rejected",
    receivedAt: receipt.receivedAt,
    projected: false,
    scheduledReconcile: false,
    ...(receipt.deduped === undefined ? {} : { deduped: receipt.deduped }),
    ...(receipt.error === undefined ? {} : { error: receipt.error }),
  };
}

function ignoredProviderHookReceipt(input: {
  provider: string;
  event: string;
  clock: RuntimeClock;
  hookId?: (() => string) | undefined;
}): ProviderHookReceipt {
  return ProviderHookReceiptSchema.parse({
    schemaVersion: STATION_SCHEMA_VERSION,
    hookId: input.hookId?.() ?? defaultHookId(),
    provider: input.provider,
    event: input.event,
    accepted: false,
    status: "ignored",
    receivedAt: toIsoTimestamp(input.clock.now()),
  });
}

function rejectedProviderHookReceipt(input: {
  provider: string;
  event: string;
  clock: RuntimeClock;
  error: unknown;
  hookId?: (() => string) | undefined;
}): ProviderHookReceipt {
  return ProviderHookReceiptSchema.parse({
    schemaVersion: STATION_SCHEMA_VERSION,
    hookId: input.hookId?.() ?? defaultHookId(),
    provider: input.provider,
    event: input.event,
    accepted: false,
    status: "rejected",
    receivedAt: toIsoTimestamp(input.clock.now()),
    error: safeErrorFromUnknown(input.error, {
      tag: "HookPayloadError",
      code: "HOOK_REPORT_INVALID",
      message: "Provider hook payload could not be normalized to a harness event report.",
      provider: input.provider,
    }),
  });
}

function payloadSummaryFor(payload: unknown): ProviderHookPayloadSummary {
  if (payload === undefined) {
    return {
      present: false,
      originalBytes: null,
      compactedBytes: null,
      compacted: false,
      omittedFieldNames: [],
    };
  }
  const bytes = jsonByteCount(payload);
  return {
    present: true,
    originalBytes: bytes,
    compactedBytes: bytes,
    compacted: false,
    omittedFieldNames: [],
  };
}

function compactionSummary(compaction: {
  originalByteCount: number | null;
  compactedByteCount: number | null;
  compacted: boolean;
  omittedFieldNames: string[];
}): ProviderHookPayloadSummary {
  return {
    present: true,
    originalBytes: compaction.originalByteCount,
    compactedBytes: compaction.compactedByteCount,
    compacted: compaction.compacted,
    omittedFieldNames: compaction.omittedFieldNames,
  };
}

function diagnosticsFromCompaction(compaction: {
  originalByteCount: number | null;
  compactedByteCount: number | null;
  compacted: boolean;
  omittedFieldNames: string[];
}) {
  return {
    payloadBytes: compaction.originalByteCount,
    compactedBytes: compaction.compactedByteCount,
    compacted: compaction.compacted,
    truncated: false,
    omittedFieldNames: compaction.omittedFieldNames,
  };
}

function hasStationOwnership(payload: unknown): boolean {
  const identity = parseStationHookIdentityPayload(payload);
  return identity?.station_session_id !== undefined && identity.station_worktree_id !== undefined;
}

function jsonByteCount(value: unknown): number | null {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      return null;
    }
    return Buffer.byteLength(serialized, "utf8");
  } catch {
    return null;
  }
}

function observerClient(
  socketPath: string,
  timeoutMs: number,
  deps: ProviderHookSenderDeps,
): ReturnType<typeof createObserverClient> {
  return (
    deps.clientFactory?.(socketPath, { timeoutMs }) ??
    createObserverClient({ socketPath, timeoutMs })
  );
}

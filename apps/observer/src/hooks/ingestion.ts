import { randomUUID } from "node:crypto";
import type { ObservabilityRetentionConfig } from "@station/config";
import type {
  HarnessEventObservation,
  HarnessEventReport,
  HarnessEventReportReceipt,
  ProviderHookAdapter,
  ProviderHookEvent,
  ProviderHookReceipt,
  ProviderProjectConfig,
  SessionRecoveryHandle,
  StationEvent,
} from "@station/contracts";
import {
  HarnessEventObservationSchema,
  HarnessEventReportReceiptSchema,
  HarnessEventReportSchema,
  ProviderHookEventSchema,
  ProviderHookReceiptSchema,
  STATION_SCHEMA_VERSION,
} from "@station/contracts";
import {
  type RuntimeClock,
  runRuntimeBoundary,
  safeErrorFromUnknown,
  systemClock,
  toIsoTimestamp,
} from "@station/runtime";
import type { IngressJournal, ObservationStore, SessionStore } from "../persistence/index.js";
import {
  providerObservationExpiresAt,
  providerObservationRetentionDays,
} from "../persistence/retention.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { ObserverEventBus } from "../runtime/eventBus.js";
import { ingestProviderHookEvent } from "./providerHookIngress.js";
import { persistTurnReadinessFromHarnessObservation } from "./turnReadiness.js";

export type ProviderHookIngress = {
  ingest(
    event: ProviderHookEvent,
    options?: ProviderHookIngressOptions,
  ): Promise<ProviderHookReceipt>;
};

export type HarnessEventReportIngestion = {
  ingest(
    report: HarnessEventReport,
    options?: ProviderHookIngressOptions,
  ): Promise<HarnessEventReportReceipt>;
};

export type ProviderHookIngressOptions = {
  triggerReconcile?: boolean;
};

export type CreateProviderHookIngressOptions = {
  persistence: IngressJournal & ObservationStore & SessionStore;
  providers?: ProviderRegistry;
  projects?: ProviderProjectConfig[];
  eventBus?: ObserverEventBus;
  clock?: RuntimeClock;
  hookId?: () => string;
  requestReconcile?: (reason: string) => void;
  retention?: ObservabilityRetentionConfig;
  /**
   * Harness report handoff for adapter-normalized hook events. Raw payloads are
   * normalized here (observer-side) so exactly one code version computes status.
   */
  reportHarnessEvent?: (report: HarnessEventReport) => Promise<HarnessEventReportReceipt>;
};

export type CreateHarnessEventReportIngestionOptions = {
  persistence: IngressJournal & SessionStore;
  eventBus?: ObserverEventBus;
  clock?: RuntimeClock;
  requestReconcile?: (reason: string) => void;
  retention?: ObservabilityRetentionConfig;
};

const defaultHookId = () => `hook_${randomUUID()}`;

export function createProviderHookIngress(
  options: CreateProviderHookIngressOptions,
): ProviderHookIngress {
  const clock = options.clock ?? systemClock;
  const hookId = options.hookId ?? defaultHookId;

  return {
    ingest: async (inputEvent, ingestOptions = {}) => {
      const parsedEvent = ProviderHookEventSchema.parse(inputEvent);
      const id = parsedEvent.hookId ?? hookId();
      const event = ProviderHookEventSchema.parse({
        ...parsedEvent,
        hookId: id,
      });
      const hookEvent: StationEvent = {
        type: "providerHook.ingested",
        at: event.receivedAt,
        hookId: id,
        provider: event.provider,
        event: event.event,
      };

      const persistResult = await runRuntimeBoundary(
        {
          operation: "observer.hook.persist",
          clock,
          error: {
            tag: "HookIngestionError",
            code: "HOOK_INGESTION_FAILED",
            message: "Observer could not persist the hook event.",
            provider: event.provider,
          },
        },
        async () => {
          const result = await options.persistence.recordEventWithIngressDedupe(hookEvent, {
            source: "provider-hook",
            createdAt: event.receivedAt,
            dedupe: { kind: "hook", id },
          });
          if (result.deduped) {
            return { deduped: true };
          }
          options.eventBus?.publish(hookEvent);
          return { deduped: false };
        },
      );

      if (!persistResult.ok) {
        const receipt: ProviderHookReceipt = {
          schemaVersion: STATION_SCHEMA_VERSION,
          hookId: id,
          provider: event.provider,
          event: event.event,
          accepted: false,
          status: "rejected",
          receivedAt: event.receivedAt,
          error: persistResult.error,
        };
        return ProviderHookReceiptSchema.parse(receipt);
      }

      if (persistResult.value.deduped) {
        return ProviderHookReceiptSchema.parse({
          schemaVersion: STATION_SCHEMA_VERSION,
          hookId: id,
          provider: event.provider,
          event: event.event,
          accepted: true,
          status: "ingested",
          receivedAt: event.receivedAt,
          reconciled: false,
          deduped: true,
        });
      }

      const adapter =
        event.kind === "harness" ? options.providers?.hookAdapters.get(event.provider) : undefined;
      if (adapter?.toHarnessEventReport !== undefined && options.reportHarnessEvent !== undefined) {
        return ingestViaHookAdapter({
          event,
          adapter,
          reportHarnessEvent: options.reportHarnessEvent,
        });
      }

      const providerIngestResult =
        options.providers === undefined
          ? undefined
          : await ingestProviderHookEvent({
              event,
              providers: options.providers,
              projects: options.projects ?? [],
              persistence: options.persistence,
              clock,
              ...(options.retention === undefined ? {} : { retention: options.retention }),
            });

      const shouldReconcile = ingestOptions.triggerReconcile ?? true;
      if (shouldReconcile && options.requestReconcile !== undefined) {
        options.requestReconcile(`hook:${event.provider}:${event.event}`);
      }

      const receipt: ProviderHookReceipt = {
        schemaVersion: STATION_SCHEMA_VERSION,
        hookId: id,
        provider: event.provider,
        event: event.event,
        accepted: true,
        status: "ingested",
        receivedAt: event.receivedAt,
        reconciled: false,
        deduped: false,
      };
      if (providerIngestResult?.error !== undefined) {
        receipt.error = providerIngestResult.error;
      }
      return ProviderHookReceiptSchema.parse(receipt);
    },
  };
}

type IngestViaHookAdapterInput = {
  event: ProviderHookEvent;
  adapter: ProviderHookAdapter;
  reportHarnessEvent: (report: HarnessEventReport) => Promise<HarnessEventReportReceipt>;
};

async function ingestViaHookAdapter(
  input: IngestViaHookAdapterInput,
): Promise<ProviderHookReceipt> {
  const event =
    input.adapter.normalizeEventName === undefined
      ? input.event
      : ProviderHookEventSchema.parse({
          ...input.event,
          event: input.adapter.normalizeEventName(input.event.event),
        });

  const scope = input.adapter.decideScope?.(event);
  if (scope?.action === "ignore") {
    return ProviderHookReceiptSchema.parse({
      schemaVersion: STATION_SCHEMA_VERSION,
      hookId: event.hookId,
      provider: event.provider,
      event: event.event,
      accepted: false,
      status: "ignored",
      receivedAt: event.receivedAt,
    });
  }

  const compaction = input.adapter.compactPayload?.(event) ?? {
    event,
    payloadSummary: {
      present: event.payload !== undefined,
      originalBytes: null,
      compactedBytes: null,
      compacted: false,
      omittedFieldNames: [],
    },
  };

  const result = input.adapter.toHarnessEventReport?.({
    event: compaction.event,
    payloadSummary: compaction.payloadSummary,
    // hookId is stamped once at the ingress writer, so retries of a spooled
    // event resolve to the same report id and dedupe instead of duplicating.
    fallbackReportId: () => event.hookId ?? `hook_${randomUUID()}`,
  });
  if (result === undefined || !result.ok) {
    return ProviderHookReceiptSchema.parse({
      schemaVersion: STATION_SCHEMA_VERSION,
      hookId: event.hookId,
      provider: event.provider,
      event: event.event,
      accepted: false,
      status: "rejected",
      receivedAt: event.receivedAt,
      error: safeErrorFromUnknown(result === undefined ? undefined : result.error, {
        tag: "HookPayloadError",
        code: "HOOK_REPORT_INVALID",
        message: "Provider hook payload could not be normalized to a harness event report.",
        provider: event.provider,
      }),
    });
  }

  const receipt = await input.reportHarnessEvent(result.report);
  const status =
    receipt.status === "accepted"
      ? "ingested"
      : receipt.status === "spooled"
        ? "spooled"
        : receipt.status;
  const hookReceipt: ProviderHookReceipt = {
    schemaVersion: STATION_SCHEMA_VERSION,
    hookId: event.hookId ?? receipt.reportId,
    provider: event.provider,
    event: event.event,
    accepted: receipt.accepted,
    status,
    receivedAt: event.receivedAt,
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

export function createHarnessEventReportIngestion(
  options: CreateHarnessEventReportIngestionOptions,
): HarnessEventReportIngestion {
  const clock = options.clock ?? systemClock;

  return {
    ingest: async (inputReport, ingestOptions = {}) => {
      const report = HarnessEventReportSchema.parse(inputReport);
      const receivedAt = toIsoTimestamp(clock.now());
      const observation = harnessEventObservationFromReport(report);

      const reportedEvent: StationEvent = {
        type: "harness.eventReported",
        at: report.observedAt,
        reportId: report.reportId,
        provider: report.provider,
        eventType: report.eventType,
      };
      const retentionDays = providerObservationRetentionDays(options.retention);

      const persistResult = await runRuntimeBoundary(
        {
          operation: "observer.harnessEventReport.persist",
          clock,
          error: {
            tag: "HarnessEventReportIngestionError",
            code: "HARNESS_EVENT_REPORT_INGESTION_FAILED",
            message: "Observer could not persist the harness event report.",
            provider: report.provider,
          },
        },
        async () => {
          const result =
            await options.persistence.recordEventAndProviderObservationWithIngressDedupe({
              event: reportedEvent,
              eventOptions: {
                source: "hook",
                createdAt: report.observedAt,
              },
              dedupe: { kind: "harness_report", id: report.reportId },
              observation: {
                provider: report.provider,
                providerType: "harness",
                entityKind: "harness_event",
                entityKey: harnessEventReportEntityKey(report),
                payload: observation,
                observedAt: report.observedAt,
                expiresAt: providerObservationExpiresAt(report.observedAt, retentionDays),
              },
            });
          if (result.deduped) {
            return { deduped: true };
          }
          const recoveryHandle = sessionRecoveryHandleFromReport(report);
          if (recoveryHandle !== undefined) {
            await options.persistence.upsertSessionRecoveryHandle(recoveryHandle);
          }
          await persistTurnReadinessFromHarnessObservation({
            persistence: options.persistence,
            observation,
            updatedAt: receivedAt,
          });
          options.eventBus?.publish(reportedEvent);
          return { deduped: false };
        },
      );

      if (!persistResult.ok) {
        return HarnessEventReportReceiptSchema.parse({
          schemaVersion: STATION_SCHEMA_VERSION,
          reportId: report.reportId,
          provider: report.provider,
          eventType: report.eventType,
          accepted: false,
          status: "rejected",
          receivedAt,
          projected: false,
          scheduledReconcile: false,
          error: persistResult.error,
        });
      }

      if (persistResult.value.deduped) {
        return HarnessEventReportReceiptSchema.parse({
          schemaVersion: STATION_SCHEMA_VERSION,
          reportId: report.reportId,
          provider: report.provider,
          eventType: report.eventType,
          accepted: true,
          status: "accepted",
          receivedAt,
          projected: false,
          scheduledReconcile: false,
          deduped: true,
        });
      }

      const shouldReconcile = ingestOptions.triggerReconcile ?? true;
      if (shouldReconcile && options.requestReconcile !== undefined) {
        options.requestReconcile(`harness-report:${report.provider}:${report.eventType}`);
      }

      return HarnessEventReportReceiptSchema.parse({
        schemaVersion: STATION_SCHEMA_VERSION,
        reportId: report.reportId,
        provider: report.provider,
        eventType: report.eventType,
        accepted: true,
        status: "accepted",
        receivedAt,
        projected: false,
        scheduledReconcile: shouldReconcile && options.requestReconcile !== undefined,
        deduped: false,
      });
    },
  };
}

function harnessEventObservationFromReport(report: HarnessEventReport): HarnessEventObservation {
  const observation: HarnessEventObservation = {
    provider: report.provider,
    reportId: report.reportId,
    eventType: report.eventType,
    observedAt: report.observedAt,
  };
  if (report.correlation?.projectId !== undefined) {
    observation.projectId = report.correlation.projectId;
  }
  if (report.correlation?.sessionId !== undefined) {
    observation.sessionId = report.correlation.sessionId;
  }
  if (report.correlation?.worktreeId !== undefined) {
    observation.worktreeId = report.correlation.worktreeId;
  }
  if (report.correlation?.terminalTargetId !== undefined) {
    observation.terminalTargetId = report.correlation.terminalTargetId;
  }
  if (report.correlation?.harnessRunId !== undefined) {
    observation.harnessRunId = report.correlation.harnessRunId;
  }
  if (report.correlation?.nativeSessionId !== undefined) {
    observation.nativeSessionId = report.correlation.nativeSessionId;
  }
  if (report.correlation?.nativeSessionFile !== undefined) {
    observation.nativeSessionFile = report.correlation.nativeSessionFile;
  }
  if (report.correlation?.cwd !== undefined) {
    observation.cwd = report.correlation.cwd;
  }
  if (report.correlation?.pid !== undefined) {
    observation.pid = report.correlation.pid;
  }
  if (report.status !== undefined) {
    observation.status = report.status;
  }
  if (report.turn !== undefined) {
    observation.turn = report.turn;
  }
  if (report.diagnostics?.rawEventType !== undefined) {
    observation.rawEventType = report.diagnostics.rawEventType;
  }
  if (report.diagnostics !== undefined) {
    observation.diagnostics = report.diagnostics;
  }
  if (report.providerData !== undefined) {
    observation.providerData = report.providerData;
  }
  return HarnessEventObservationSchema.parse(observation);
}

function sessionRecoveryHandleFromReport(
  report: HarnessEventReport,
): SessionRecoveryHandle | undefined {
  const correlation = report.correlation;
  if (
    correlation?.projectId === undefined ||
    correlation.worktreeId === undefined ||
    (correlation.nativeSessionId === undefined && correlation.nativeSessionFile === undefined)
  ) {
    return undefined;
  }

  // Provider adapters normalize native ids/files into correlation fields, so
  // observer ingestion never scrapes providerData for recovery metadata.
  const target =
    correlation.nativeSessionFile !== undefined
      ? ({ kind: "session-file", path: correlation.nativeSessionFile } as const)
      : nativeSessionTarget(correlation.nativeSessionId);
  const handle: SessionRecoveryHandle = {
    id: report.reportId,
    provider: report.provider,
    projectId: correlation.projectId,
    worktreeId: correlation.worktreeId,
    target,
    observedAt: report.observedAt,
    lastSeenAt: report.observedAt,
  };
  if (correlation.sessionId !== undefined) handle.sessionId = correlation.sessionId;
  if (correlation.cwd !== undefined) handle.cwd = correlation.cwd;
  if (correlation.terminalTargetId !== undefined) {
    handle.terminalTargetId = correlation.terminalTargetId;
  }
  if (correlation.harnessRunId !== undefined) handle.harnessRunId = correlation.harnessRunId;
  return handle;
}

function nativeSessionTarget(id: string | undefined): { kind: "native-session"; id: string } {
  if (id === undefined) {
    throw new Error("Expected a native session id after recovery correlation validation.");
  }
  return { kind: "native-session", id };
}

function harnessEventReportEntityKey(report: HarnessEventReport): string {
  return (
    report.correlation?.harnessRunId ??
    report.correlation?.sessionId ??
    report.correlation?.worktreeId ??
    report.reportId
  );
}

export function providerHookEvent(input: {
  provider: string;
  kind: ProviderHookEvent["kind"];
  event: string;
  clock?: RuntimeClock;
  projectId?: string;
  worktreeId?: string;
  sessionId?: string;
  payload?: unknown;
}): ProviderHookEvent {
  const clock = input.clock ?? systemClock;
  const event: ProviderHookEvent = {
    schemaVersion: STATION_SCHEMA_VERSION,
    provider: input.provider,
    kind: input.kind,
    event: input.event,
    receivedAt: toIsoTimestamp(clock.now()),
  };
  if (input.projectId !== undefined) event.projectId = input.projectId;
  if (input.worktreeId !== undefined) event.worktreeId = input.worktreeId;
  if (input.sessionId !== undefined) event.sessionId = input.sessionId;
  if (input.payload !== undefined) event.payload = input.payload;
  return ProviderHookEventSchema.parse(event);
}

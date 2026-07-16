import type {
  HarnessEventReportResult,
  ProviderHookAdapter,
  ProviderHookEvent,
  ProviderHookPayloadCompactionResult,
  ProviderHookReportInput,
  ProviderHookScopeDecision,
} from "@station/contracts";
import {
  enrichStationHookIdentityPayload,
  ProviderHookEventSchema,
  parseStationHookIdentityPayload,
} from "@station/contracts";
import { compactOpenCodeHookPayload } from "./compaction.js";
import {
  normalizeOpenCodeEventType,
  openCodeHookPayloadToHarnessEventReport,
  parseOpenCodeCompactEvent,
} from "./events.js";
import { isOpenCodeForwardedEventType } from "./ingressRules.js";

/**
 * ADAPTER
 *
 * Normalizes OpenCode plugin hooks into shared provider-event and harness-report contracts.
 */
export const openCodeHookAdapter: ProviderHookAdapter = {
  provider: "opencode",
  kind: "harness",
  normalizeEventName: normalizeOpenCodeEventType,
  enrichPayload: enrichStationHookIdentityPayload,
  decideScope: decideOpenCodeHookScope,
  compactPayload: compactOpenCodeHookEventPayload,
  toHarnessEventReport: openCodeHookEventReport,
};

function decideOpenCodeHookScope(event: ProviderHookEvent): ProviderHookScopeDecision {
  if (event.kind !== "harness") {
    return { action: "accept", reason: "not-required" };
  }
  if (!isOpenCodeForwardedEventType(event.event)) {
    return { action: "ignore", reason: "event-not-forwarded" };
  }

  const payload = parseStationHookIdentityPayload(event.payload);
  if (payload?.station_session_id !== undefined && payload.station_worktree_id !== undefined) {
    return { action: "accept", reason: "station-env" };
  }
  return { action: "ignore", reason: "missing-station-env" };
}

function compactOpenCodeHookEventPayload(
  event: ProviderHookEvent,
): ProviderHookPayloadCompactionResult {
  const compaction = compactOpenCodeHookPayload(event.payload);
  const compactedEvent = ProviderHookEventSchema.parse({
    ...event,
    payload: compaction.payload,
  });
  return {
    event: compactedEvent,
    payloadSummary: {
      present: true,
      originalBytes: compaction.originalByteCount,
      compactedBytes: compaction.compactedByteCount,
      compacted: compaction.compacted,
      omittedFieldNames: compaction.omittedFieldNames,
    },
  };
}

function openCodeHookEventReport(input: ProviderHookReportInput): HarnessEventReportResult {
  try {
    const event = parseOpenCodeCompactEvent(input.event.payload);
    return {
      ok: true,
      report: openCodeHookPayloadToHarnessEventReport({
        reportId: input.event.hookId ?? input.fallbackReportId(),
        eventType: input.event.event,
        observedAt: event.observed_at ?? input.event.receivedAt,
        payload: input.event.payload,
        diagnostics: {
          payloadBytes: input.payloadSummary.originalBytes,
          compactedBytes: input.payloadSummary.compactedBytes,
          compacted: input.payloadSummary.compacted,
          truncated: false,
          omittedFieldNames: input.payloadSummary.omittedFieldNames,
        },
      }),
    };
  } catch (error) {
    return { ok: false, error };
  }
}

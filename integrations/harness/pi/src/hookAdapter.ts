// Adapts Pi hook delivery into STATION ProviderHookEvent / HarnessEventReport.
// Contract: STATION-native (first-party Pi harness, no external upstream) — see packages/contracts.
// STATION ingress flow: docs/harness-ingress.md.
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
import { normalizePiEventType } from "./event/compactEvent.js";
import { compactPiHookPayload } from "./event/compaction.js";
import { piHookPayloadToHarnessEventReport } from "./event/mapping.js";

export const piHookAdapter: ProviderHookAdapter = {
  provider: "pi",
  kind: "harness",
  normalizeEventName: normalizePiEventName,
  enrichPayload: enrichStationHookIdentityPayload,
  decideScope: decidePiHookScope,
  compactPayload: compactPiHookEventPayload,
  toHarnessEventReport: piHookEventReport,
};

function normalizePiEventName(event: string): string {
  return normalizePiEventType(event);
}

function decidePiHookScope(event: ProviderHookEvent): ProviderHookScopeDecision {
  if (event.kind !== "harness") {
    return { action: "accept", reason: "not-required" };
  }
  const payload = parseStationHookIdentityPayload(event.payload);
  if (payload === undefined) {
    return { action: "ignore", reason: "missing-station-env" };
  }

  if (payload.station_session_id !== undefined && payload.station_worktree_id !== undefined) {
    return { action: "accept", reason: "station-env" };
  }
  return { action: "ignore", reason: "missing-station-env" };
}

function compactPiHookEventPayload(event: ProviderHookEvent): ProviderHookPayloadCompactionResult {
  const compaction = compactPiHookPayload(event.event, event.payload);
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

function piHookEventReport(input: ProviderHookReportInput): HarnessEventReportResult {
  try {
    return {
      ok: true,
      report: piHookPayloadToHarnessEventReport({
        reportId: input.event.hookId ?? input.fallbackReportId(),
        eventType: input.event.event,
        observedAt: input.event.receivedAt,
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

// Adapts Cursor hook delivery into STATION ProviderHookEvent / HarnessEventReport.
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
import { compactCursorProviderHookPayload } from "./compaction.js";
import { cursorProviderHookPayloadToHarnessEventReport } from "./events.js";

export const cursorHookAdapter: ProviderHookAdapter = {
  provider: "cursor",
  kind: "harness",
  enrichPayload: enrichStationHookIdentityPayload,
  decideScope: decideCursorHookScope,
  compactPayload: compactCursorHookEventPayload,
  toHarnessEventReport: cursorHookEventReport,
};

function decideCursorHookScope(event: ProviderHookEvent): ProviderHookScopeDecision {
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

function compactCursorHookEventPayload(
  event: ProviderHookEvent,
): ProviderHookPayloadCompactionResult {
  const compaction = compactCursorProviderHookPayload(event.payload);
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

function cursorHookEventReport(input: ProviderHookReportInput): HarnessEventReportResult {
  try {
    return {
      ok: true,
      report: cursorProviderHookPayloadToHarnessEventReport({
        reportId: input.event.hookId ?? input.fallbackReportId(),
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

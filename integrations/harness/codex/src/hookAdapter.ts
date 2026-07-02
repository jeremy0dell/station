// Adapts Codex hook delivery into STATION ProviderHookEvent / HarnessEventReport.
// Upstream hook contract: https://developers.openai.com/codex/hooks
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
import { compactCodexHookPayload } from "./compaction.js";
import { codexHookPayloadReportId, codexHookPayloadToHarnessEventReport } from "./events.js";

export const codexHookAdapter: ProviderHookAdapter = {
  provider: "codex",
  kind: "harness",
  enrichPayload: enrichStationHookIdentityPayload,
  decideScope: decideCodexHookScope,
  compactPayload: compactCodexHookEventPayload,
  toHarnessEventReport: codexHookEventReport,
};

function decideCodexHookScope(event: ProviderHookEvent): ProviderHookScopeDecision {
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

function compactCodexHookEventPayload(
  event: ProviderHookEvent,
): ProviderHookPayloadCompactionResult {
  const compaction = compactCodexHookPayload(event.payload);
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

function codexHookEventReport(input: ProviderHookReportInput): HarnessEventReportResult {
  try {
    return {
      ok: true as const,
      report: codexHookPayloadToHarnessEventReport({
        observedAt: input.event.receivedAt,
        reportId: codexHookPayloadReportId(input.event.payload, input.event.receivedAt),
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
    return { ok: false as const, error };
  }
}

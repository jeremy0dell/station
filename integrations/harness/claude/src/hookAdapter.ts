// Adapts Claude Code hook delivery into STATION ProviderHookEvent / HarnessEventReport.
// Upstream hook contract: https://docs.anthropic.com/en/docs/claude-code/hooks
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
import { compactClaudeHookPayload } from "./compaction.js";
import { claudeHookPayloadReportId, claudeHookPayloadToHarnessEventReport } from "./events.js";
import { isClaudeForwardedEventType } from "./ingressRules.js";

export const claudeHookAdapter: ProviderHookAdapter = {
  provider: "claude",
  kind: "harness",
  enrichPayload: enrichStationHookIdentityPayload,
  decideScope: decideClaudeHookScope,
  compactPayload: compactClaudeHookEventPayload,
  toHarnessEventReport: claudeHookEventReport,
};

function decideClaudeHookScope(event: ProviderHookEvent): ProviderHookScopeDecision {
  if (event.kind !== "harness") {
    return { action: "accept", reason: "not-required" };
  }

  const payload = parseStationHookIdentityPayload(event.payload);
  if (payload === undefined) {
    return { action: "ignore", reason: "missing-station-env" };
  }
  if (payload.station_session_id === undefined || payload.station_worktree_id === undefined) {
    return { action: "ignore", reason: "missing-station-env" };
  }
  // A fallback global install can surface user-added hook events; unlisted
  // event types are dropped, never errors.
  if (!isClaudeForwardedEventType(event.event)) {
    return { action: "ignore", reason: "event-not-forwarded" };
  }
  return { action: "accept", reason: "station-env" };
}

function compactClaudeHookEventPayload(
  event: ProviderHookEvent,
): ProviderHookPayloadCompactionResult {
  const compaction = compactClaudeHookPayload(event.payload);
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

function claudeHookEventReport(input: ProviderHookReportInput): HarnessEventReportResult {
  try {
    return {
      ok: true,
      report: claudeHookPayloadToHarnessEventReport({
        reportId: claudeHookPayloadReportId(input.event.payload, input.event.receivedAt),
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

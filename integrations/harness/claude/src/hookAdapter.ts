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
import { z } from "zod";
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

// Pre-parse probe for the scope decision only; the full event schema validates
// later in toHarnessEventReport.
const hookCwdProbeSchema = z.object({ cwd: z.string().min(1) }).loose();

function decideClaudeHookScope(event: ProviderHookEvent): ProviderHookScopeDecision {
  if (event.kind !== "harness") {
    return { action: "accept", reason: "not-required" };
  }
  // A fallback global install can surface user-added hook events; unlisted
  // event types are dropped, never errors.
  if (!isClaudeForwardedEventType(event.event)) {
    return { action: "ignore", reason: "event-not-forwarded" };
  }
  const payload = parseStationHookIdentityPayload(event.payload);
  if (payload?.station_session_id !== undefined && payload.station_worktree_id !== undefined) {
    return { action: "accept", reason: "station-env" };
  }
  // Sessions Station did not launch carry no station env; the observer
  // correlates their events by cwd (dropped there when ambiguous).
  if (hookCwdProbeSchema.safeParse(event.payload).success) {
    return { action: "accept", reason: "cwd" };
  }
  return { action: "ignore", reason: "missing-station-env" };
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

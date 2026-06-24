// Adapts Pi hook delivery into STATION ProviderHookEvent / HarnessEventReport.
// Contract: STATION-native (first-party Pi harness, no external upstream) — see packages/contracts.
// STATION ingress flow: docs/harness-ingress.md.
import type {
  HarnessEventReportResult,
  ProviderHookAdapter,
  ProviderHookEvent,
  ProviderHookPayloadCompactionResult,
  ProviderHookPayloadEnrichmentInput,
  ProviderHookReportInput,
  ProviderHookScopeDecision,
} from "@station/contracts";
import { ProviderHookEventSchema, parseStationHookIdentityPayload } from "@station/contracts";
import {
  compactPiHookPayload,
  normalizePiEventType,
  piHookPayloadToHarnessEventReport,
} from "./event/index.js";

export const piHookAdapter: ProviderHookAdapter = {
  provider: "pi",
  kind: "harness",
  normalizeEventName: normalizePiEventName,
  enrichPayload: enrichPiHookPayload,
  decideScope: decidePiHookScope,
  compactPayload: compactPiHookEventPayload,
  toHarnessEventReport: piHookEventReport,
};

function normalizePiEventName(event: string): string {
  return normalizePiEventType(event);
}

function enrichPiHookPayload(input: ProviderHookPayloadEnrichmentInput): unknown {
  const payload = parseStationHookIdentityPayload(input.payload);
  if (payload === undefined) {
    return input.payload;
  }

  const next: Record<string, unknown> = { ...payload };
  assignEnvField(next, "station_project_id", input.env.STATION_PROJECT_ID);
  assignEnvField(next, "station_worktree_id", input.env.STATION_WORKTREE_ID);
  assignEnvField(next, "station_worktree_path", input.env.STATION_WORKTREE_PATH);
  assignEnvField(next, "station_session_id", input.env.STATION_SESSION_ID);
  assignEnvField(next, "station_terminal_provider", input.env.STATION_TERMINAL_PROVIDER);
  assignEnvField(next, "station_terminal_target_id", input.env.STATION_TERMINAL_TARGET_ID);
  return next;
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

function assignEnvField(
  target: Record<string, unknown>,
  key: string,
  value: string | undefined,
): void {
  if (target[key] !== undefined || value === undefined || value.length === 0) {
    return;
  }
  target[key] = value;
}

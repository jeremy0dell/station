// Adapts Codex hook delivery into STATION ProviderHookEvent / HarnessEventReport.
// Upstream hook contract: https://developers.openai.com/codex/hooks
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
import { ProviderHookEventSchema } from "@station/contracts";
import { compactCodexHookPayload } from "./compaction.js";
import { codexHookPayloadReportId, codexHookPayloadToHarnessEventReport } from "./events.js";
import { extractCodexHookScopeContext } from "./scope.js";

export const codexHookAdapter: ProviderHookAdapter = {
  provider: "codex",
  kind: "harness",
  enrichPayload: enrichCodexHookPayload,
  decideScope: decideCodexHookScope,
  compactPayload: compactCodexHookEventPayload,
  toHarnessEventReport: codexHookEventReport,
};

function enrichCodexHookPayload(input: ProviderHookPayloadEnrichmentInput): unknown {
  if (!isRecord(input.payload)) {
    return input.payload;
  }

  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input.payload)) {
    next[key] = value;
  }
  assignEnvField(next, "station_project_id", input.env.STATION_PROJECT_ID);
  assignEnvField(next, "station_worktree_id", input.env.STATION_WORKTREE_ID);
  assignEnvField(next, "station_worktree_path", input.env.STATION_WORKTREE_PATH);
  assignEnvField(next, "station_session_id", input.env.STATION_SESSION_ID);
  assignEnvField(next, "station_terminal_provider", input.env.STATION_TERMINAL_PROVIDER);
  assignEnvField(next, "station_terminal_target_id", input.env.STATION_TERMINAL_TARGET_ID);
  return next;
}

function decideCodexHookScope(event: ProviderHookEvent): ProviderHookScopeDecision {
  if (event.kind !== "harness") {
    return { action: "accept", reason: "not-required" };
  }

  const context = extractCodexHookScopeContext(event.payload);
  if (context.stationSessionId !== undefined && context.stationWorktreeId !== undefined) {
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
        reportId: codexHookPayloadReportId(input.event.payload),
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
    return { ok: false as const, error };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

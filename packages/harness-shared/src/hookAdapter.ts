import type {
  HarnessEventReport,
  ProviderHookAdapter,
  ProviderHookEvent,
  ProviderHookReportInput,
  ProviderId,
} from "@station/contracts";
import {
  enrichStationHookIdentityPayload,
  ProviderHookEventSchema,
  parseProviderHookCwd,
  parseStationHookIdentityPayload,
} from "@station/contracts";
import type { PayloadCompactionResult } from "./compaction.js";

export type HarnessHookReportMapperInput = {
  reportId: string;
  eventType: string;
  observedAt: string;
  payload: unknown;
  diagnostics: {
    payloadBytes: number | null;
    compactedBytes: number | null;
    compacted: boolean;
    truncated: boolean;
    omittedFieldNames: string[];
  };
};

export type HarnessHookAdapterSpec = {
  /** Provider identity assigned to the adapter and every normalized report. */
  provider: ProviderId;
  /** Returns whether a native event type belongs on Observer ingress. */
  isForwardedEventType?: (eventType: string) => boolean;
  /** Allows provider-native cwd to admit sessions that Station did not launch. */
  acceptCwdFallback?: boolean;
  /** Compacts one native hook payload while preserving provider-required fields. */
  compactHookPayload: (event: ProviderHookEvent) => PayloadCompactionResult;
  /** Derives stable report identity when provider-native identity is available. */
  hookPayloadReportId?: (event: ProviderHookEvent, fallbackReportId: () => string) => string;
  /** Maps the compact provider payload into the shared harness report contract. */
  hookPayloadToHarnessEventReport: (input: HarnessHookReportMapperInput) => HarnessEventReport;
  /** Normalizes transport event aliases before adapter admission and mapping. */
  normalizeEventName?: (eventType: string) => string;
  /** Resolves a provider-native observation timestamp when it outranks receipt time. */
  hookPayloadObservedAt?: (event: ProviderHookEvent) => string;
  /** Returns true when provider cwd contradicts inherited Station worktree identity. */
  corroborateCwdMismatch?: (
    cwd: string,
    stationWorktreePath: string,
    stationWorktreeManagedRoot: string | undefined,
  ) => boolean;
};

/**
 * ADAPTER
 *
 * Builds provider hook adapters that share ingress admission, compaction, and
 * report error translation while retaining provider-owned payload semantics.
 */
export function createHarnessHookAdapter(spec: HarnessHookAdapterSpec): ProviderHookAdapter {
  const adapter: ProviderHookAdapter = {
    provider: spec.provider,
    kind: "harness",
    enrichPayload: enrichStationHookIdentityPayload,
    decideScope: (event) => decideHookScope(spec, event),
    compactPayload: (event) => compactHookPayload(spec, event),
    toHarnessEventReport: (input) => hookEventReport(spec, input),
  };
  if (spec.normalizeEventName !== undefined) {
    adapter.normalizeEventName = spec.normalizeEventName;
  }
  return adapter;
}

function decideHookScope(spec: HarnessHookAdapterSpec, event: ProviderHookEvent) {
  if (event.kind !== "harness") {
    return { action: "accept", reason: "not-required" } as const;
  }
  // A fallback global install can surface user-added hook events; unlisted event types are dropped, never errors.
  if (spec.isForwardedEventType !== undefined && !spec.isForwardedEventType(event.event)) {
    return { action: "ignore", reason: "event-not-forwarded" } as const;
  }

  const identity = parseStationHookIdentityPayload(event.payload);
  const cwd = parseProviderHookCwd(event.payload);
  const cwdMismatch =
    identity?.station_worktree_path !== undefined &&
    spec.corroborateCwdMismatch !== undefined &&
    (cwd === undefined ||
      spec.corroborateCwdMismatch(
        cwd,
        identity.station_worktree_path,
        identity.station_worktree_managed_root,
      ));
  if (
    !cwdMismatch &&
    identity?.station_session_id !== undefined &&
    identity.station_worktree_id !== undefined
  ) {
    return { action: "accept", reason: "station-env" } as const;
  }
  // Cwd-only evidence is admitted here; Observer correlation still drops it when ambiguous.
  if (spec.acceptCwdFallback === true && cwd !== undefined) {
    return { action: "accept", reason: "cwd" } as const;
  }
  return { action: "ignore", reason: "missing-station-env" } as const;
}

function compactHookPayload(spec: HarnessHookAdapterSpec, event: ProviderHookEvent) {
  const compaction = spec.compactHookPayload(event);
  return {
    event: ProviderHookEventSchema.parse({
      ...event,
      payload: compaction.payload,
    }),
    payloadSummary: {
      present: true,
      originalBytes: compaction.originalByteCount,
      compactedBytes: compaction.compactedByteCount,
      compacted: compaction.compacted,
      omittedFieldNames: compaction.omittedFieldNames,
    },
  };
}

function hookEventReport(spec: HarnessHookAdapterSpec, input: ProviderHookReportInput) {
  try {
    const reportId =
      spec.hookPayloadReportId?.(input.event, input.fallbackReportId) ??
      input.event.hookId ??
      input.fallbackReportId();
    const observedAt = spec.hookPayloadObservedAt?.(input.event) ?? input.event.receivedAt;
    return {
      ok: true,
      report: spec.hookPayloadToHarnessEventReport({
        reportId,
        eventType: input.event.event,
        observedAt,
        payload: input.event.payload,
        diagnostics: {
          payloadBytes: input.payloadSummary.originalBytes,
          compactedBytes: input.payloadSummary.compactedBytes,
          compacted: input.payloadSummary.compacted,
          truncated: false,
          omittedFieldNames: input.payloadSummary.omittedFieldNames,
        },
      }),
    } as const;
  } catch (error) {
    return { ok: false, error } as const;
  }
}

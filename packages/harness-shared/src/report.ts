import type {
  HarnessEventDiagnostics,
  HarnessEventReport,
  ObservedStatus,
  ProviderId,
  StationHookIdentityPayload,
} from "@station/contracts";
import {
  HarnessEventReportSchema,
  harnessRunIdForTerminalTarget,
  STATION_SCHEMA_VERSION,
} from "@station/contracts";
import { type HarnessEventCorrelation, harnessEventDiagnostics } from "./events.js";

/** Loose normalizer input; the hook adapter always supplies diagnostics counters. */
export type HarnessEventReportInput = {
  reportId: string;
  eventType?: string;
  observedAt: string;
  payload: unknown;
  diagnostics?: {
    payloadBytes?: number | null;
    compactedBytes?: number | null;
    compacted?: boolean;
    truncated?: boolean;
    omittedFieldNames?: string[];
  };
};

export type HarnessEventReportFields = {
  provider: ProviderId;
  eventType: string;
  status?: ObservedStatus | undefined;
  turn?: HarnessEventReport["turn"] | undefined;
  correlation?: HarnessEventReport["correlation"] | undefined;
  diagnostics?: HarnessEventDiagnostics | undefined;
  coalesceKey?: string | undefined;
  providerData?: Record<string, unknown> | undefined;
};

/** Assembles and validates one report; undefined optional fields stay absent. Providers that
 * annotate diagnostics (a correlation issue, say) pass the finished object in `fields`. */
export function buildHarnessEventReport(
  input: Pick<HarnessEventReportInput, "reportId" | "observedAt" | "diagnostics">,
  fields: HarnessEventReportFields,
): HarnessEventReport {
  const report: HarnessEventReport = {
    schemaVersion: STATION_SCHEMA_VERSION,
    reportId: input.reportId,
    provider: fields.provider,
    kind: "harness",
    eventType: fields.eventType,
    observedAt: input.observedAt,
  };
  if (fields.status !== undefined) {
    report.status = fields.status;
  }
  if (fields.turn !== undefined) {
    report.turn = fields.turn;
  }
  if (fields.correlation !== undefined) {
    report.correlation = fields.correlation;
  }
  report.diagnostics =
    fields.diagnostics ?? harnessEventDiagnostics(fields.eventType, input.diagnostics);
  if (fields.coalesceKey !== undefined) {
    report.coalesceKey = fields.coalesceKey;
  }
  if (fields.providerData !== undefined) {
    report.providerData = fields.providerData;
  }
  return HarnessEventReportSchema.parse(report);
}

export type StationIdentityProviderData = {
  stationProjectId?: string;
  stationWorktreeId?: string;
  stationWorktreePath?: string;
  stationWorktreeManagedRoot?: string;
  stationSessionId?: string;
  stationTerminalProvider?: string;
  stationTerminalTargetId?: string;
};

/** Copies inherited station_* identity into camelCase providerData keys. Key order is part of
 * the contract: providerData is stored verbatim, so callers merge this in a fixed position. */
export function stationIdentityProviderData(
  event: StationHookIdentityPayload,
): StationIdentityProviderData {
  const data: StationIdentityProviderData = {};
  if (event.station_project_id !== undefined) {
    data.stationProjectId = event.station_project_id;
  }
  if (event.station_worktree_id !== undefined) {
    data.stationWorktreeId = event.station_worktree_id;
  }
  if (event.station_worktree_path !== undefined) {
    data.stationWorktreePath = event.station_worktree_path;
  }
  if (event.station_worktree_managed_root !== undefined) {
    data.stationWorktreeManagedRoot = event.station_worktree_managed_root;
  }
  if (event.station_session_id !== undefined) {
    data.stationSessionId = event.station_session_id;
  }
  if (event.station_terminal_provider !== undefined) {
    data.stationTerminalProvider = event.station_terminal_provider;
  }
  if (event.station_terminal_target_id !== undefined) {
    data.stationTerminalTargetId = event.station_terminal_target_id;
  }
  return data;
}

/** Station correlation ids, plus the pane-stable harnessRunId unless the provider mints none. */
export function stationIdentityCorrelation(
  provider: ProviderId,
  event: StationHookIdentityPayload,
  options: { harnessRunId?: boolean } = {},
): HarnessEventCorrelation {
  const correlation: HarnessEventCorrelation = {
    projectId: event.station_project_id,
    worktreeId: event.station_worktree_id,
    sessionId: event.station_session_id,
    terminalTargetId: event.station_terminal_target_id,
  };
  if (options.harnessRunId !== false && event.station_terminal_target_id !== undefined) {
    correlation.harnessRunId = harnessRunIdForTerminalTarget(
      provider,
      event.station_terminal_target_id,
    );
  }
  return correlation;
}

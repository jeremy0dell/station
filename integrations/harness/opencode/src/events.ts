// OpenCode plugin events -> STATION HarnessEventObservation, normalized at the provider boundary.
// Upstream contract: https://opencode.ai/docs/plugins/
// STATION ingress flow: docs/harness-ingress.md. Keep the parsed payload shape in sync with upstream.
import type {
  HarnessEventContext,
  HarnessEventObservation,
  HarnessEventReport,
  ObservedStatus,
  RawHarnessEvent,
} from "@station/contracts";
import { HarnessEventReportSchema, STATION_SCHEMA_VERSION } from "@station/contracts";
import {
  applyCorrelation,
  correlateTerminalBoundHarnessEvent,
  harnessEventDiagnostics,
  reportCorrelation,
} from "@station/harness-shared";
import { compactOpenCodeHookPayload } from "./compaction.js";
import { openCodeHarnessError } from "./errors.js";
import {
  type OpenCodeCompactEvent,
  OpenCodeCompactEventSchema,
  OpenCodeEventTypeSchema,
} from "./eventSchemas.js";
import { openCodeIngressRuleForEventType } from "./ingressRules.js";

export type OpenCodeHarnessEventReportInput = {
  reportId: string;
  eventType: string;
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

export function parseOpenCodeCompactEvent(input: unknown): OpenCodeCompactEvent {
  const result = OpenCodeCompactEventSchema.safeParse(input);
  if (!result.success) {
    throw openCodeHarnessError(
      "HARNESS_OPENCODE_EVENT_INVALID",
      "OpenCode event payload did not match the supported compact strict schema.",
      result.error,
    );
  }
  return result.data;
}

export function normalizeOpenCodeEventType(input: string): string {
  const result = OpenCodeEventTypeSchema.safeParse(input);
  if (!result.success) {
    throw openCodeHarnessError(
      "HARNESS_OPENCODE_EVENT_INVALID",
      `Unsupported OpenCode event type: ${input}.`,
      result.error,
    );
  }
  return result.data;
}

export function normalizeOpenCodeRawEvent(
  raw: RawHarnessEvent,
  context: HarnessEventContext,
): HarnessEventObservation[] {
  const compaction = compactOpenCodeHookPayload(raw.event);
  const event = parseOpenCodeCompactEvent(compaction.payload);
  const observedAt = event.observed_at ?? raw.observedAt ?? new Date().toISOString();
  const correlation = correlateTerminalBoundHarnessEvent({
    provider: "opencode",
    identity: event,
    context,
    cwd: event.cwd,
    nativeSessionId: event.opencode_session_id,
    pid: event.pid,
    includeProjectId: true,
    includeTerminalTargetId: true,
    includeCwd: true,
  });
  const observation: HarnessEventObservation = {
    provider: "opencode",
    rawEventType: event.event_type,
    observedAt,
    providerData: providerDataFromOpenCodeEvent(event),
  };
  const status =
    openCodeIngressRuleForEventType(event.event_type) !== undefined
      ? statusFromOpenCodeEvent(event, observedAt)
      : undefined;
  if (status !== undefined) {
    observation.status = status;
  }
  const turn = turnFromOpenCodeEvent(event);
  if (turn !== undefined) {
    observation.turn = turn;
  }
  applyCorrelation(observation, correlation);
  if (compaction.omittedFieldNames.length > 0) {
    observation.diagnostics = harnessEventDiagnostics(event.event_type, {
      compacted: compaction.compacted,
      omittedFieldNames: compaction.omittedFieldNames,
      payloadBytes: compaction.originalByteCount,
      compactedBytes: compaction.compactedByteCount,
    });
  }
  return [observation];
}

export function openCodeHookPayloadToHarnessEventReport(
  input: OpenCodeHarnessEventReportInput,
): HarnessEventReport {
  const event = parseOpenCodeCompactEvent(input.payload);
  const eventType = normalizeOpenCodeEventType(input.eventType);
  if (event.event_type !== eventType) {
    throw openCodeHarnessError(
      "HARNESS_OPENCODE_EVENT_INVALID",
      `OpenCode hook event name ${eventType} did not match payload event_type ${event.event_type}.`,
    );
  }

  const report: HarnessEventReport = {
    schemaVersion: STATION_SCHEMA_VERSION,
    reportId: input.reportId,
    provider: "opencode",
    kind: "harness",
    eventType: event.event_type,
    observedAt: input.observedAt,
  };
  const status =
    openCodeIngressRuleForEventType(event.event_type) !== undefined
      ? statusFromOpenCodeEvent(event, input.observedAt)
      : undefined;
  if (status !== undefined) {
    report.status = status;
  }
  const turn = turnFromOpenCodeEvent(event);
  if (turn !== undefined) {
    report.turn = turn;
  }
  const correlation = reportCorrelationFromOpenCodeEvent(event);
  if (correlation !== undefined) {
    report.correlation = correlation;
  }
  report.diagnostics = harnessEventDiagnostics(event.event_type, input.diagnostics);
  const coalesceKey = reportCoalesceKeyFromOpenCodeEvent(event);
  if (coalesceKey !== undefined) {
    report.coalesceKey = coalesceKey;
  }
  report.providerData = providerDataFromOpenCodeEvent(event);
  return HarnessEventReportSchema.parse(report);
}

export function statusFromOpenCodeEvent(
  event: OpenCodeCompactEvent,
  observedAt: string,
): ObservedStatus | undefined {
  switch (event.event_type) {
    case "permission.asked":
      return {
        ...status("needs_attention", "high", permissionAskedReason(event), observedAt),
        attention: "tool_approval",
      };
    case "question.asked":
      return {
        ...status("needs_attention", "high", "OpenCode asked a question.", observedAt),
        attention: "question",
      };
    case "permission.replied":
      return event.permission_reply === "reject"
        ? status("idle", "medium", "OpenCode permission request was rejected.", observedAt)
        : status("working", "high", "OpenCode permission request was approved.", observedAt);
    case "question.replied":
      return status("working", "high", "OpenCode question was answered.", observedAt);
    case "question.rejected":
      return status("idle", "medium", "OpenCode question was rejected.", observedAt);
    case "session.created":
      return status("starting", "medium", "OpenCode session was created.", observedAt);
    case "session.deleted":
      return status("exited", "high", "OpenCode session was deleted.", observedAt);
    case "session.error":
      return status("needs_attention", "high", "OpenCode reported a session error.", observedAt);
    case "session.idle":
      return status("idle", "high", "OpenCode session is idle.", observedAt);
    case "session.status":
      return statusFromSessionStatus(event, observedAt);
    case "session.compacted":
    case "session.next.compaction.started":
    case "session.next.compaction.delta":
    case "session.next.compaction.ended":
      return status("working", "medium", "OpenCode is compacting the session.", observedAt);
    case "command.executed":
    case "session.next.prompted":
    case "session.next.synthetic":
    case "session.next.shell.started":
    case "session.next.shell.ended":
    case "session.next.step.started":
    case "session.next.step.ended":
    case "session.next.step.failed":
    case "session.next.tool.called":
    case "session.next.tool.progress":
    case "session.next.tool.success":
    case "session.next.tool.failed":
    case "session.next.tool.input.started":
    case "session.next.tool.input.delta":
    case "session.next.tool.input.ended":
    case "tool.execute.before":
    case "tool.execute.after":
      return status("working", "medium", workingReason(event), observedAt);
    case "tui.command.execute":
      return event.command_name === "session.interrupt"
        ? status("idle", "medium", "OpenCode session was interrupted.", observedAt)
        : undefined;
    default:
      return undefined;
  }
}

function turnFromOpenCodeEvent(
  event: OpenCodeCompactEvent,
): HarnessEventReport["turn"] | undefined {
  return event.event_type === "session.idle" ? { kind: "turn_completed" } : undefined;
}

function statusFromSessionStatus(
  event: OpenCodeCompactEvent,
  observedAt: string,
): ObservedStatus | undefined {
  if (event.status_type === "idle") {
    return status("idle", "high", "OpenCode session status is idle.", observedAt);
  }
  if (event.status_type === "busy") {
    return status("working", "high", "OpenCode session status is busy.", observedAt);
  }
  if (event.status_type === "retry") {
    return status("working", "medium", "OpenCode is retrying a session step.", observedAt);
  }
  return undefined;
}

function status(
  value: ObservedStatus["value"],
  confidence: ObservedStatus["confidence"],
  reason: string,
  observedAt: string,
): ObservedStatus {
  return {
    value,
    confidence,
    reason,
    source: "harness_event",
    updatedAt: observedAt,
  };
}

function permissionAskedReason(event: OpenCodeCompactEvent): string {
  return event.tool_name === undefined
    ? "OpenCode requested permission."
    : `OpenCode requested permission for ${event.tool_name}.`;
}

function workingReason(event: OpenCodeCompactEvent): string {
  if (event.tool_name !== undefined) {
    return `OpenCode is using ${event.tool_name}.`;
  }
  if (event.command_name !== undefined) {
    return `OpenCode executed command ${event.command_name}.`;
  }
  return "OpenCode session is working.";
}

function providerDataFromOpenCodeEvent(event: OpenCodeCompactEvent): Record<string, unknown> {
  const providerData: Record<string, unknown> = {
    openCodeEventType: event.event_type,
  };
  if (event.event_id !== undefined) providerData.openCodeEventId = event.event_id;
  if (event.opencode_session_id !== undefined) {
    providerData.openCodeSessionId = event.opencode_session_id;
  }
  if (event.status_type !== undefined) providerData.statusType = event.status_type;
  if (event.permission_reply !== undefined) providerData.permissionReply = event.permission_reply;
  if (event.question_reply !== undefined) providerData.questionReply = event.question_reply;
  if (event.request_id !== undefined) providerData.requestId = event.request_id;
  if (event.message_id !== undefined) providerData.messageId = event.message_id;
  if (event.part_id !== undefined) providerData.partId = event.part_id;
  if (event.tool_call_id !== undefined) providerData.toolCallId = event.tool_call_id;
  if (event.tool_name !== undefined) providerData.toolName = event.tool_name;
  if (event.command_name !== undefined) providerData.commandName = event.command_name;
  if (event.file_path !== undefined) providerData.filePath = event.file_path;
  if (event.error_name !== undefined) providerData.errorName = event.error_name;
  if (event.property_keys !== undefined) providerData.propertyKeys = event.property_keys;
  if (event.station_project_id !== undefined)
    providerData.stationProjectId = event.station_project_id;
  if (event.station_worktree_id !== undefined)
    providerData.stationWorktreeId = event.station_worktree_id;
  if (event.station_worktree_path !== undefined) {
    providerData.stationWorktreePath = event.station_worktree_path;
  }
  if (event.station_session_id !== undefined)
    providerData.stationSessionId = event.station_session_id;
  if (event.station_terminal_provider !== undefined) {
    providerData.stationTerminalProvider = event.station_terminal_provider;
  }
  if (event.station_terminal_target_id !== undefined) {
    providerData.stationTerminalTargetId = event.station_terminal_target_id;
  }
  if (event.station_integration_id !== undefined) {
    providerData.stationIntegrationId = event.station_integration_id;
  }
  if (event.station_integration_version !== undefined) {
    providerData.stationIntegrationVersion = event.station_integration_version;
  }
  return providerData;
}

function reportCorrelationFromOpenCodeEvent(
  event: OpenCodeCompactEvent,
): HarnessEventReport["correlation"] | undefined {
  return reportCorrelation({
    cwd: event.cwd,
    nativeSessionId: event.opencode_session_id,
    pid: event.pid,
    projectId: event.station_project_id,
    worktreeId: event.station_worktree_id,
    sessionId: event.station_session_id,
    terminalTargetId: event.station_terminal_target_id,
    harnessRunId:
      event.station_terminal_target_id === undefined
        ? undefined
        : `opencode:${event.station_terminal_target_id}`,
  });
}

function reportCoalesceKeyFromOpenCodeEvent(event: OpenCodeCompactEvent): string | undefined {
  const parts: string[] = [];
  if (event.opencode_session_id !== undefined) parts.push(`native:${event.opencode_session_id}`);
  if (event.message_id !== undefined) parts.push(`message:${event.message_id}`);
  if (event.part_id !== undefined) parts.push(`part:${event.part_id}`);
  if (event.tool_call_id !== undefined) parts.push(`tool:${event.tool_call_id}`);
  if (event.request_id !== undefined) parts.push(`request:${event.request_id}`);
  return parts.length === 0 ? undefined : parts.join(":");
}

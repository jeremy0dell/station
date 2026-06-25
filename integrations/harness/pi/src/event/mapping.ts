// Pi events -> STATION HarnessEventObservation, normalized at the provider boundary.
// Contract: STATION-native (first-party Pi harness, no external upstream) — see packages/contracts (HarnessEventReport).
// STATION ingress flow: docs/harness-ingress.md.
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
import { piHarnessError } from "../errors.js";
import { normalizePiEventType, type PiCompactEvent, parsePiCompactEvent } from "./compactEvent.js";

export type PiHarnessEventReportInput = {
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

function turnFromPiEvent(event: PiCompactEvent): HarnessEventReport["turn"] | undefined {
  return event.event_type === "agent_end" ? { kind: "turn_completed" } : undefined;
}

function providerDataFromPiEvent(event: PiCompactEvent): Record<string, unknown> {
  const providerData: Record<string, unknown> = {};
  assignProviderData(providerData, "piSessionId", event.pi_session_id);
  assignProviderData(providerData, "piSessionFile", event.pi_session_file);
  assignProviderData(providerData, "model", event.model);
  switch (event.event_type) {
    case "session_start":
      assignProviderData(providerData, "sessionStartReason", event.reason);
      assignProviderData(providerData, "previousSessionFile", event.previous_session_file);
      break;
    case "session_shutdown":
      assignProviderData(providerData, "shutdownReason", event.reason);
      assignProviderData(providerData, "targetSessionFile", event.target_session_file);
      break;
    case "turn_start":
      assignProviderData(providerData, "turnIndex", event.turn_index);
      break;
    case "tool_execution_start":
      assignProviderData(providerData, "toolCallId", event.tool_call_id);
      assignProviderData(providerData, "toolName", event.tool_name);
      break;
    case "tool_execution_end":
      assignProviderData(providerData, "toolCallId", event.tool_call_id);
      assignProviderData(providerData, "toolName", event.tool_name);
      assignProviderData(providerData, "isError", event.is_error);
      break;
    case "message_end":
      assignProviderData(providerData, "messageRole", event.message_role);
      break;
    case "agent_end":
      assignProviderData(providerData, "messageCount", event.message_count);
      break;
    case "session_compact":
      assignProviderData(providerData, "fromExtension", event.from_extension);
      assignProviderData(providerData, "compactionEntryId", event.compaction_entry_id);
      break;
    case "agent_start":
      break;
    default:
      assertNever(event);
  }
  return providerData;
}

function reportCorrelationFromPiEvent(
  event: PiCompactEvent,
): HarnessEventReport["correlation"] | undefined {
  return reportCorrelation({
    cwd: event.cwd,
    projectId: event.station_project_id,
    worktreeId: event.station_worktree_id,
    sessionId: event.station_session_id,
    terminalTargetId: event.station_terminal_target_id,
    harnessRunId:
      event.station_terminal_target_id === undefined
        ? undefined
        : `pi:${event.station_terminal_target_id}`,
    nativeSessionFile: event.pi_session_file,
    nativeSessionId: event.pi_session_file === undefined ? event.pi_session_id : undefined,
    pid: event.pid,
  });
}

function reportCoalesceKeyFromPiEvent(event: PiCompactEvent): string | undefined {
  const parts: string[] = [];
  if (event.event_type === "turn_start" && event.turn_index !== undefined) {
    parts.push(`turn:${event.turn_index}`);
  }
  if (event.event_type === "tool_execution_start" || event.event_type === "tool_execution_end") {
    if (event.tool_call_id !== undefined) {
      parts.push(`tool:${event.tool_call_id}`);
    } else if (event.tool_name !== undefined) {
      parts.push(`tool:${event.tool_name}`);
    }
  }
  return parts.length === 0 ? undefined : parts.join(":");
}

function assignProviderData(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

function assertNever(value: never): never {
  throw piHarnessError("HARNESS_PI_EVENT_INVALID", `Unhandled Pi event: ${String(value)}.`);
}

export function normalizePiRawEvent(
  raw: RawHarnessEvent,
  context: HarnessEventContext,
): HarnessEventObservation[] {
  const event = parsePiCompactEvent(raw.event);
  const observedAt = raw.observedAt ?? new Date().toISOString();
  const correlation = correlateTerminalBoundHarnessEvent({
    provider: "pi",
    identity: event,
    context,
    cwd: event.cwd,
    nativeSessionFile: event.pi_session_file,
    nativeSessionId: event.pi_session_file === undefined ? event.pi_session_id : undefined,
    includeTerminalTargetId: true,
  });
  const observation: HarnessEventObservation = {
    provider: "pi",
    rawEventType: event.event_type,
    status: statusFromPiEvent(event, observedAt),
    observedAt,
    providerData: providerDataFromPiEvent(event),
  };
  const turn = turnFromPiEvent(event);
  if (turn !== undefined) {
    observation.turn = turn;
  }
  applyCorrelation(observation, correlation);
  return [observation];
}

export function piHookPayloadToHarnessEventReport(
  input: PiHarnessEventReportInput,
): HarnessEventReport {
  const event = parsePiCompactEvent(input.payload);
  const eventType = normalizePiEventType(input.eventType);
  if (event.event_type !== eventType) {
    throw piHarnessError(
      "HARNESS_PI_EVENT_INVALID",
      `Pi hook event name ${eventType} did not match payload event_type ${event.event_type}.`,
    );
  }

  const report: HarnessEventReport = {
    schemaVersion: STATION_SCHEMA_VERSION,
    reportId: input.reportId,
    provider: "pi",
    kind: "harness",
    eventType: event.event_type,
    observedAt: input.observedAt,
    status: statusFromPiEvent(event, input.observedAt),
  };
  const turn = turnFromPiEvent(event);
  if (turn !== undefined) {
    report.turn = turn;
  }
  const correlation = reportCorrelationFromPiEvent(event);
  if (correlation !== undefined) {
    report.correlation = correlation;
  }
  report.diagnostics = harnessEventDiagnostics(event.event_type, input.diagnostics);
  const coalesceKey = reportCoalesceKeyFromPiEvent(event);
  if (coalesceKey !== undefined) {
    report.coalesceKey = coalesceKey;
  }
  report.providerData = providerDataFromPiEvent(event);
  return HarnessEventReportSchema.parse(report);
}

export function statusFromPiEvent(event: PiCompactEvent, observedAt: string): ObservedStatus {
  switch (event.event_type) {
    case "session_start":
      return {
        value: "starting",
        confidence: "high",
        reason:
          event.reason === undefined
            ? "Pi session started."
            : `Pi session started from ${event.reason}.`,
        source: "harness_event",
        updatedAt: observedAt,
      };
    case "agent_start":
      return {
        value: "working",
        confidence: "high",
        reason: "Pi agent started.",
        source: "harness_event",
        updatedAt: observedAt,
      };
    case "agent_end":
      return {
        value: "idle",
        confidence: "medium",
        reason: "Pi agent turn completed.",
        source: "harness_event",
        updatedAt: observedAt,
      };
    case "session_shutdown":
      if (event.reason === "quit") {
        return {
          value: "exited",
          confidence: "high",
          reason: "Pi session quit.",
          source: "harness_event",
          updatedAt: observedAt,
        };
      }
      return {
        value: "working",
        confidence: "medium",
        reason:
          event.reason === undefined
            ? "Pi session is shutting down."
            : `Pi session is shutting down for ${event.reason}.`,
        source: "harness_event",
        updatedAt: observedAt,
      };
    case "session_compact":
      return {
        value: "working",
        confidence: "medium",
        reason: "Pi compacted the session.",
        source: "harness_event",
        updatedAt: observedAt,
      };
    case "tool_execution_start":
      return {
        value: "working",
        confidence: "medium",
        reason:
          event.tool_name === undefined
            ? "Pi started a tool execution."
            : `Pi started ${event.tool_name}.`,
        source: "harness_event",
        updatedAt: observedAt,
      };
    case "tool_execution_end":
      return {
        value: "working",
        confidence: "medium",
        reason:
          event.tool_name === undefined
            ? "Pi completed a tool execution."
            : `Pi completed ${event.tool_name}.`,
        source: "harness_event",
        updatedAt: observedAt,
      };
    case "message_end":
      return {
        value: "working",
        confidence: "medium",
        reason:
          event.message_role === undefined
            ? "Pi completed a message."
            : `Pi completed a ${event.message_role} message.`,
        source: "harness_event",
        updatedAt: observedAt,
      };
    case "turn_start":
      return {
        value: "working",
        confidence: "medium",
        reason:
          event.turn_index === undefined
            ? "Pi turn started."
            : `Pi turn ${event.turn_index} started.`,
        source: "harness_event",
        updatedAt: observedAt,
      };
    default:
      return assertNever(event);
  }
}

// Pi events -> STATION HarnessEventObservation, normalized at the provider boundary.
// Contract: STATION-native (first-party Pi harness, no external upstream) — see packages/contracts (HarnessEventReport).
// STATION ingress flow: docs/harness-ingress.md.
import type { HarnessEventReport, ObservedStatus } from "@station/contracts";
import {
  assignDefined,
  buildHarnessEventReport,
  type HarnessEventReportInput,
  harnessEventStatus,
  reportCorrelation,
  stationIdentityCorrelation,
} from "@station/harness-shared";
import { piHarnessError } from "../errors.js";
import { normalizePiEventType, type PiCompactEvent, parsePiCompactEvent } from "./compactEvent.js";

function usesSettledEvent(event: PiCompactEvent): boolean {
  return event.station_extension_protocol === 2;
}

function turnFromPiEvent(event: PiCompactEvent): HarnessEventReport["turn"] | undefined {
  if (
    event.event_type === "agent_settled" ||
    (event.event_type === "agent_end" && !usesSettledEvent(event))
  ) {
    return { kind: "turn_completed" };
  }
  return undefined;
}

function providerDataFromPiEvent(event: PiCompactEvent): Record<string, unknown> {
  const providerData: Record<string, unknown> = {};
  assignDefined(providerData, "piSessionId", event.pi_session_id);
  assignDefined(providerData, "piSessionFile", event.pi_session_file);
  assignDefined(providerData, "model", event.model);
  assignDefined(providerData, "stationExtensionProtocol", event.station_extension_protocol);
  switch (event.event_type) {
    case "session_start":
      assignDefined(providerData, "sessionStartReason", event.reason);
      assignDefined(providerData, "previousSessionFile", event.previous_session_file);
      break;
    case "session_shutdown":
      assignDefined(providerData, "shutdownReason", event.reason);
      assignDefined(providerData, "targetSessionFile", event.target_session_file);
      break;
    case "turn_start":
      assignDefined(providerData, "turnIndex", event.turn_index);
      break;
    case "tool_execution_start":
      assignDefined(providerData, "toolCallId", event.tool_call_id);
      assignDefined(providerData, "toolName", event.tool_name);
      assignDefined(providerData, "activeQuestionCallId", event.active_question_call_id);
      break;
    case "tool_execution_end":
      assignDefined(providerData, "toolCallId", event.tool_call_id);
      assignDefined(providerData, "toolName", event.tool_name);
      assignDefined(providerData, "isError", event.is_error);
      assignDefined(providerData, "activeQuestionCallId", event.active_question_call_id);
      break;
    case "question_prompt_open":
      assignDefined(providerData, "toolCallId", event.tool_call_id);
      assignDefined(providerData, "toolName", event.tool_name);
      break;
    case "message_end":
      assignDefined(providerData, "messageRole", event.message_role);
      break;
    case "agent_end":
      assignDefined(providerData, "messageCount", event.message_count);
      break;
    case "session_compact":
      assignDefined(providerData, "fromExtension", event.from_extension);
      assignDefined(providerData, "compactionEntryId", event.compaction_entry_id);
      assignDefined(providerData, "compactionReason", event.reason);
      assignDefined(providerData, "willRetry", event.will_retry);
      break;
    case "agent_start":
    case "agent_settled":
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
    ...stationIdentityCorrelation("pi", event),
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
  if (
    event.event_type === "tool_execution_start" ||
    event.event_type === "tool_execution_end" ||
    event.event_type === "question_prompt_open"
  ) {
    if (event.tool_call_id !== undefined) {
      parts.push(`tool:${event.tool_call_id}`);
    } else if (event.tool_name !== undefined) {
      parts.push(`tool:${event.tool_name}`);
    }
  }
  return parts.length === 0 ? undefined : parts.join(":");
}

function assertNever(value: never): never {
  throw piHarnessError("HARNESS_PI_EVENT_INVALID", `Unhandled Pi event: ${String(value)}.`);
}

export function piHookPayloadToHarnessEventReport(
  input: HarnessEventReportInput & { eventType: string },
): HarnessEventReport {
  const event = parsePiCompactEvent(input.payload);
  const eventType = normalizePiEventType(input.eventType);
  if (event.event_type !== eventType) {
    throw piHarnessError(
      "HARNESS_PI_EVENT_INVALID",
      `Pi hook event name ${eventType} did not match payload event_type ${event.event_type}.`,
    );
  }

  return buildHarnessEventReport(input, {
    provider: "pi",
    eventType: event.event_type,
    status: statusFromPiEvent(event, input.observedAt),
    turn: turnFromPiEvent(event),
    correlation: reportCorrelationFromPiEvent(event),
    coalesceKey: reportCoalesceKeyFromPiEvent(event),
    providerData: providerDataFromPiEvent(event),
  });
}

function statusForPiShutdown(
  event: Extract<PiCompactEvent, { event_type: "session_shutdown" }>,
  observedAt: string,
): ObservedStatus {
  if (event.reason === "quit") {
    return harnessEventStatus("exited", "high", "Pi session quit.", observedAt);
  }
  return harnessEventStatus(
    "working",
    "medium",
    event.reason === undefined
      ? "Pi session is shutting down."
      : `Pi session is shutting down for ${event.reason}.`,
    observedAt,
  );
}

function statusForPiCompaction(
  event: Extract<PiCompactEvent, { event_type: "session_compact" }>,
  observedAt: string,
): ObservedStatus {
  // Only an explicitly completed manual /compact is idle; every other form may continue.
  if (event.reason === "manual" && event.will_retry === false) {
    return harnessEventStatus(
      "idle",
      "high",
      "Pi completed manual session compaction.",
      observedAt,
    );
  }
  return harnessEventStatus(
    "working",
    "medium",
    event.reason === undefined
      ? "Pi compacted the session; continuation state is unknown."
      : `Pi completed ${event.reason} session compaction and may continue.`,
    observedAt,
  );
}

function piQuestionAttention(observedAt: string): ObservedStatus {
  return harnessEventStatus(
    "needs_attention",
    "high",
    "Pi is waiting for a question response.",
    observedAt,
    { attention: "question" },
  );
}

function statusForPiToolStart(
  event: Extract<PiCompactEvent, { event_type: "tool_execution_start" }>,
  observedAt: string,
): ObservedStatus {
  if (event.active_question_call_id !== undefined) {
    return piQuestionAttention(observedAt);
  }
  return harnessEventStatus(
    "working",
    "medium",
    event.tool_name === undefined
      ? "Pi started a tool execution."
      : `Pi started ${event.tool_name}.`,
    observedAt,
  );
}

function statusForPiToolEnd(
  event: Extract<PiCompactEvent, { event_type: "tool_execution_end" }>,
  observedAt: string,
): ObservedStatus {
  if (event.active_question_call_id !== undefined) {
    return piQuestionAttention(observedAt);
  }
  if (event.tool_name === "ask_user_question") {
    return harnessEventStatus("working", "high", "Pi question execution ended.", observedAt);
  }
  return harnessEventStatus(
    "working",
    "medium",
    event.tool_name === undefined
      ? "Pi completed a tool execution."
      : `Pi completed ${event.tool_name}.`,
    observedAt,
  );
}

/**
 * Maps one strict compact Pi event to provider-neutral status without retaining cross-event state.
 */
export function statusFromPiEvent(event: PiCompactEvent, observedAt: string): ObservedStatus {
  switch (event.event_type) {
    case "session_start":
      return harnessEventStatus(
        "starting",
        "high",
        event.reason === undefined
          ? "Pi session started."
          : `Pi session started from ${event.reason}.`,
        observedAt,
      );
    case "agent_start":
      return harnessEventStatus("working", "high", "Pi agent started.", observedAt);
    case "agent_end":
      if (!usesSettledEvent(event)) {
        return harnessEventStatus("idle", "medium", "Legacy Pi agent turn completed.", observedAt);
      }
      // A low-level run can still be followed by retry, compaction, or queued continuation.
      return harnessEventStatus(
        "working",
        "medium",
        "Pi agent run ended and may continue automatically.",
        observedAt,
      );
    case "agent_settled":
      // Pi emits settlement only after automatic continuation paths are exhausted.
      return harnessEventStatus("idle", "high", "Pi agent settled.", observedAt);
    case "session_shutdown":
      return statusForPiShutdown(event, observedAt);
    case "session_compact":
      return statusForPiCompaction(event, observedAt);
    case "tool_execution_start":
      return statusForPiToolStart(event, observedAt);
    case "tool_execution_end":
      return statusForPiToolEnd(event, observedAt);
    case "question_prompt_open":
      return piQuestionAttention(observedAt);
    case "message_end":
      return harnessEventStatus(
        "working",
        "medium",
        event.message_role === undefined
          ? "Pi completed a message."
          : `Pi completed a ${event.message_role} message.`,
        observedAt,
      );
    case "turn_start":
      return harnessEventStatus(
        "working",
        "medium",
        event.turn_index === undefined
          ? "Pi turn started."
          : `Pi turn ${event.turn_index} started.`,
        observedAt,
      );
    default:
      return assertNever(event);
  }
}

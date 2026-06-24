// Pi events -> STATION HarnessEventObservation, normalized at the provider boundary.
// Contract: STATION-native (first-party Pi harness, no external upstream) — see packages/contracts (HarnessEventReport).
// STATION ingress flow: docs/harness-ingress.md.
import type {
  HarnessEventContext,
  HarnessEventObservation,
  HarnessEventReport,
  ObservedStatus,
  RawHarnessEvent,
  TerminalTargetObservation,
  WorktreeObservation,
} from "@station/contracts";
import {
  HarnessEventReportSchema,
  observedPathIsSameOrInside,
  STATION_SCHEMA_VERSION,
} from "@station/contracts";
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

export function normalizePiRawEvent(
  raw: RawHarnessEvent,
  context: HarnessEventContext,
): HarnessEventObservation[] {
  const event = parsePiCompactEvent(raw.event);
  const observedAt = raw.observedAt ?? new Date().toISOString();
  const correlation = correlatePiEvent(event, context);
  const observation: HarnessEventObservation = {
    provider: "pi",
    rawEventType: event.event_type,
    status: statusFromPiEvent(event, observedAt),
    observedAt,
    providerData: providerDataFromPiEvent(event),
  };
  if (correlation.sessionId !== undefined) {
    observation.sessionId = correlation.sessionId;
  }
  if (correlation.worktreeId !== undefined) {
    observation.worktreeId = correlation.worktreeId;
  }
  if (correlation.harnessRunId !== undefined) {
    observation.harnessRunId = correlation.harnessRunId;
  }
  if (event.pi_session_id !== undefined) {
    observation.nativeSessionId = event.pi_session_id;
  }
  if (event.pi_session_file !== undefined) {
    observation.nativeSessionFile = event.pi_session_file;
  }
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
  const correlation = reportCorrelationFromPiEvent(event);
  if (correlation !== undefined) {
    report.correlation = correlation;
  }
  const diagnostics = reportDiagnosticsFromPiEvent(event, input.diagnostics);
  if (diagnostics !== undefined) {
    report.diagnostics = diagnostics;
  }
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
  const correlation: NonNullable<HarnessEventReport["correlation"]> = {
    cwd: event.cwd,
  };
  if (event.station_project_id !== undefined) {
    correlation.projectId = event.station_project_id;
  }
  if (event.station_worktree_id !== undefined) {
    correlation.worktreeId = event.station_worktree_id;
  }
  if (event.station_session_id !== undefined) {
    correlation.sessionId = event.station_session_id;
  }
  if (event.station_terminal_target_id !== undefined) {
    correlation.terminalTargetId = event.station_terminal_target_id;
    correlation.harnessRunId = `pi:${event.station_terminal_target_id}`;
  }
  if (event.pi_session_file !== undefined) {
    correlation.nativeSessionFile = event.pi_session_file;
  } else if (event.pi_session_id !== undefined) {
    correlation.nativeSessionId = event.pi_session_id;
  }
  if (event.pid !== undefined) {
    correlation.pid = event.pid;
  }
  return correlation;
}

function reportDiagnosticsFromPiEvent(
  event: PiCompactEvent,
  input: PiHarnessEventReportInput["diagnostics"],
): HarnessEventReport["diagnostics"] | undefined {
  const diagnostics: NonNullable<HarnessEventReport["diagnostics"]> = {
    rawEventType: event.event_type,
  };
  if (typeof input?.payloadBytes === "number") {
    diagnostics.payloadBytes = input.payloadBytes;
  }
  if (typeof input?.compactedBytes === "number") {
    diagnostics.compactedBytes = input.compactedBytes;
  }
  if (input?.compacted !== undefined) {
    diagnostics.compacted = input.compacted;
  }
  if (input?.truncated !== undefined) {
    diagnostics.truncated = input.truncated;
  }
  if (input?.omittedFieldNames !== undefined && input.omittedFieldNames.length > 0) {
    diagnostics.omittedFieldNames = input.omittedFieldNames;
  }
  return diagnostics;
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

function correlatePiEvent(
  event: PiCompactEvent,
  context: HarnessEventContext,
): {
  sessionId?: string;
  worktreeId?: string;
  harnessRunId?: string;
} {
  const terminal =
    terminalForId(event.station_terminal_target_id, context.terminalTargets) ??
    terminalForCwd(event.cwd, context.terminalTargets);
  const worktree =
    worktreeForId(event.station_worktree_id, context.worktrees) ??
    worktreeForPath(event.station_worktree_path, context.worktrees) ??
    worktreeForCwd(event.cwd, context.worktrees);
  const result: {
    sessionId?: string;
    worktreeId?: string;
    harnessRunId?: string;
  } = {};
  if (event.station_session_id !== undefined) {
    result.sessionId = event.station_session_id;
  } else if (terminal?.sessionId !== undefined) {
    result.sessionId = terminal.sessionId;
  }
  if (event.station_worktree_id !== undefined) {
    result.worktreeId = event.station_worktree_id;
  } else if (terminal?.worktreeId !== undefined) {
    result.worktreeId = terminal.worktreeId;
  } else if (worktree !== undefined) {
    result.worktreeId = worktree.id;
  }
  if (event.station_terminal_target_id !== undefined) {
    result.harnessRunId = `pi:${event.station_terminal_target_id}`;
  } else if (terminal?.harnessRunId !== undefined) {
    result.harnessRunId = terminal.harnessRunId;
  } else if (terminal !== undefined) {
    result.harnessRunId = `pi:${terminal.id}`;
  }
  return result;
}

function terminalForId(
  id: string | undefined,
  terminals: TerminalTargetObservation[],
): TerminalTargetObservation | undefined {
  if (id === undefined) {
    return undefined;
  }
  return terminals.find((terminal) => terminal.id === id);
}

function terminalForCwd(
  cwd: string,
  terminals: TerminalTargetObservation[],
): TerminalTargetObservation | undefined {
  return terminals.find((terminal) => {
    if (terminal.cwd === undefined) {
      return false;
    }
    return observedPathIsSameOrInside(cwd, terminal.cwd);
  });
}

function worktreeForId(
  id: string | undefined,
  worktrees: WorktreeObservation[],
): WorktreeObservation | undefined {
  if (id === undefined) {
    return undefined;
  }
  return worktrees.find((worktree) => worktree.id === id);
}

function worktreeForPath(
  path: string | undefined,
  worktrees: WorktreeObservation[],
): WorktreeObservation | undefined {
  if (path === undefined) {
    return undefined;
  }
  return worktrees.find((worktree) => observedPathIsSameOrInside(path, worktree.path));
}

function worktreeForCwd(
  cwd: string,
  worktrees: WorktreeObservation[],
): WorktreeObservation | undefined {
  return worktrees.find((worktree) => observedPathIsSameOrInside(cwd, worktree.path));
}

function assignProviderData(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

function assertNever(value: never): never {
  throw piHarnessError("HARNESS_PI_EVENT_INVALID", `Unhandled Pi event: ${String(value)}.`);
}

// Cursor hook events -> STATION HarnessEventObservation, normalized at the provider boundary.
// Upstream hook contract: https://cursor.com/docs/hooks
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
import { z } from "zod";
import { compactCursorProviderHookPayload } from "./compaction.js";
import { cursorHarnessError } from "./errors.js";

export type CursorProviderHookPayloadReportInput = {
  reportId: string;
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

export type CursorProviderHookPayload = z.infer<typeof CursorProviderHookPayloadSchema>;

const nonEmptyStringSchema = z.string().min(1);
const nullableStringSchema = z.string().nullable();
const cursorStopStatusSchema = z.enum(["completed", "aborted", "error"]);

export const CursorProviderHookPayloadSchema = z
  .object({
    hook_event_name: nonEmptyStringSchema,
    session_id: nonEmptyStringSchema.optional(),
    conversation_id: nonEmptyStringSchema.optional(),
    generation_id: nonEmptyStringSchema.optional(),
    transcript_path: nullableStringSchema.optional(),
    cwd: nonEmptyStringSchema.optional(),
    workspace_roots: z.array(nonEmptyStringSchema).optional(),
    model: nonEmptyStringSchema.optional(),
    cursor_version: nonEmptyStringSchema.optional(),
    status: cursorStopStatusSchema.optional(),
    tool_name: nonEmptyStringSchema.optional(),
    tool_use_id: nonEmptyStringSchema.optional(),
    request_id: nonEmptyStringSchema.optional(),
    message_id: nonEmptyStringSchema.optional(),
    station_project_id: nonEmptyStringSchema.optional(),
    station_worktree_id: nonEmptyStringSchema.optional(),
    station_worktree_path: nonEmptyStringSchema.optional(),
    station_session_id: nonEmptyStringSchema.optional(),
    station_terminal_provider: nonEmptyStringSchema.optional(),
    station_terminal_target_id: nonEmptyStringSchema.optional(),
  })
  .strict();

function cursorWorkingReason(event: CursorProviderHookPayload, verb: string): string {
  return event.tool_name === undefined
    ? `Cursor ${verb} a tool.`
    : `Cursor ${verb} ${event.tool_name}.`;
}

function statusFromCursorStopEvent(
  event: CursorProviderHookPayload,
  observedAt: string,
): ObservedStatus {
  if (event.status === "error") {
    return {
      value: "needs_attention",
      confidence: "high",
      reason: "Cursor turn ended with an error.",
      source: "harness_event",
      updatedAt: observedAt,
    };
  }
  if (event.status === "aborted") {
    return {
      value: "idle",
      confidence: "medium",
      reason: "Cursor turn was aborted.",
      source: "harness_event",
      updatedAt: observedAt,
    };
  }
  return {
    value: "idle",
    confidence: "high",
    reason: "Cursor turn completed.",
    source: "harness_event",
    updatedAt: observedAt,
  };
}

function providerDataFromCursorEvent(event: CursorProviderHookPayload): Record<string, unknown> {
  const providerData: Record<string, unknown> = {
    hookEventName: event.hook_event_name,
  };
  if (event.session_id !== undefined) providerData.cursorSessionId = event.session_id;
  if (event.conversation_id !== undefined) {
    providerData.cursorConversationId = event.conversation_id;
  }
  if (event.generation_id !== undefined) providerData.cursorGenerationId = event.generation_id;
  if (event.transcript_path !== undefined) providerData.transcriptPath = event.transcript_path;
  const cwd = cursorEventCwd(event);
  if (cwd !== undefined) providerData.cwd = cwd;
  if (event.workspace_roots !== undefined) providerData.workspaceRoots = event.workspace_roots;
  if (event.model !== undefined) providerData.model = event.model;
  if (event.cursor_version !== undefined) providerData.cursorVersion = event.cursor_version;
  if (event.status !== undefined) providerData.cursorStopStatus = event.status;
  if (event.tool_name !== undefined) providerData.toolName = event.tool_name;
  if (event.tool_use_id !== undefined) providerData.toolUseId = event.tool_use_id;
  if (event.request_id !== undefined) providerData.requestId = event.request_id;
  if (event.message_id !== undefined) providerData.messageId = event.message_id;
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
  return providerData;
}

function reportCorrelationFromCursorEvent(
  event: CursorProviderHookPayload,
): HarnessEventReport["correlation"] | undefined {
  const cwd = cursorEventCwd(event);
  const nativeSessionId = cursorNativeSessionId(event);
  return reportCorrelation({
    cwd,
    nativeSessionId,
    projectId: event.station_project_id,
    worktreeId: event.station_worktree_id,
    sessionId: event.station_session_id,
    terminalTargetId: event.station_terminal_target_id,
    harnessRunId:
      event.station_terminal_target_id === undefined
        ? undefined
        : `cursor:${event.station_terminal_target_id}`,
  });
}

function reportCoalesceKeyFromCursorEvent(event: CursorProviderHookPayload): string | undefined {
  const parts: string[] = [];
  const nativeSessionId = cursorNativeSessionId(event);
  if (nativeSessionId !== undefined) parts.push(`native:${nativeSessionId}`);
  if (event.generation_id !== undefined) parts.push(`generation:${event.generation_id}`);
  if (event.tool_use_id !== undefined) {
    parts.push(`tool:${event.tool_use_id}`);
  } else if (event.tool_name !== undefined) {
    parts.push(`tool:${event.tool_name}`);
  }
  return parts.length === 0 ? undefined : parts.join(":");
}

function cursorEventCwd(event: CursorProviderHookPayload): string | undefined {
  return event.cwd ?? event.station_worktree_path ?? event.workspace_roots?.[0];
}

function cursorNativeSessionId(event: CursorProviderHookPayload): string | undefined {
  return event.session_id ?? event.conversation_id;
}

export function parseCursorProviderHookPayload(input: unknown): CursorProviderHookPayload {
  const compacted = compactCursorProviderHookPayload(input);
  const result = CursorProviderHookPayloadSchema.safeParse(compacted.payload);
  if (!result.success) {
    throw cursorHarnessError(
      "HARNESS_CURSOR_EVENT_INVALID",
      "Cursor hook event did not match a supported strict schema.",
      result.error,
    );
  }
  return result.data;
}

export function normalizeCursorRawEvent(
  raw: RawHarnessEvent,
  context: HarnessEventContext,
): HarnessEventObservation[] {
  const event = parseCursorProviderHookPayload(raw.event);
  const observedAt = raw.observedAt ?? new Date().toISOString();
  const correlation = correlateTerminalBoundHarnessEvent({
    provider: "cursor",
    identity: event,
    context,
    cwd: cursorEventCwd(event),
    nativeSessionId: cursorNativeSessionId(event),
    includeProjectId: true,
    includeTerminalTargetId: true,
    includeCwd: true,
  });
  const observation: HarnessEventObservation = {
    provider: "cursor",
    rawEventType: event.hook_event_name,
    status: statusFromCursorProviderHookPayload(event, observedAt),
    observedAt,
    providerData: providerDataFromCursorEvent(event),
  };
  applyCorrelation(observation, correlation);
  return [observation];
}

export function cursorProviderHookPayloadToHarnessEventReport(
  input: CursorProviderHookPayloadReportInput,
): HarnessEventReport {
  const event = parseCursorProviderHookPayload(input.payload);
  const report: HarnessEventReport = {
    schemaVersion: STATION_SCHEMA_VERSION,
    reportId: input.reportId,
    provider: "cursor",
    kind: "harness",
    eventType: event.hook_event_name,
    observedAt: input.observedAt,
    status: statusFromCursorProviderHookPayload(event, input.observedAt),
    providerData: providerDataFromCursorEvent(event),
  };
  const correlation = reportCorrelationFromCursorEvent(event);
  if (correlation !== undefined) {
    report.correlation = correlation;
  }
  report.diagnostics = harnessEventDiagnostics(event.hook_event_name, input.diagnostics);
  const coalesceKey = reportCoalesceKeyFromCursorEvent(event);
  if (coalesceKey !== undefined) {
    report.coalesceKey = coalesceKey;
  }
  return HarnessEventReportSchema.parse(report);
}

export function statusFromCursorProviderHookPayload(
  event: CursorProviderHookPayload,
  observedAt: string,
): ObservedStatus {
  const eventName = event.hook_event_name;
  if (eventName === "sessionStart") {
    return {
      value: "starting",
      confidence: "high",
      reason: "Cursor session started.",
      source: "harness_event",
      updatedAt: observedAt,
    };
  }
  if (eventName === "sessionEnd") {
    return {
      value: "exited",
      confidence: "high",
      reason: "Cursor session ended.",
      source: "harness_event",
      updatedAt: observedAt,
    };
  }
  if (eventName === "stop") {
    return statusFromCursorStopEvent(event, observedAt);
  }
  if (
    eventName === "beforeShellExecution" ||
    eventName === "preToolUse" ||
    eventName === "beforeMCPExecution" ||
    eventName === "beforeReadFile" ||
    eventName === "beforeTabFileRead"
  ) {
    return {
      value: "working",
      confidence: "medium",
      reason: cursorWorkingReason(event, "is about to use"),
      source: "harness_event",
      updatedAt: observedAt,
    };
  }
  if (
    eventName === "afterShellExecution" ||
    eventName === "afterMCPExecution" ||
    eventName === "afterFileEdit" ||
    eventName === "afterTabFileEdit" ||
    eventName === "postToolUse" ||
    eventName === "postToolUseFailure"
  ) {
    return {
      value: "working",
      confidence: "medium",
      reason: cursorWorkingReason(event, "completed"),
      source: "harness_event",
      updatedAt: observedAt,
    };
  }
  if (
    eventName === "beforeSubmitPrompt" ||
    eventName === "afterAgentResponse" ||
    eventName === "afterAgentThought" ||
    eventName === "preCompact" ||
    eventName === "subagentStart" ||
    eventName === "subagentStop"
  ) {
    return {
      value: "working",
      confidence: "medium",
      reason: `Cursor emitted ${eventName}.`,
      source: "harness_event",
      updatedAt: observedAt,
    };
  }
  return {
    value: "working",
    confidence: "low",
    reason: `Cursor emitted ${eventName}.`,
    source: "harness_event",
    updatedAt: observedAt,
  };
}

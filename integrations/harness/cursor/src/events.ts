// Cursor hook events -> STATION HarnessEventObservation, normalized at the provider boundary.
// Upstream hook contract: https://cursor.com/docs/hooks
// STATION ingress flow: docs/harness-ingress.md. Keep the parsed payload shape in sync with upstream.
import type { HarnessEventReport, ObservedStatus } from "@station/contracts";
import { harnessRunIdForTerminalTarget } from "@station/contracts";
import {
  buildHarnessEventReport,
  type HarnessEventReportInput,
  harnessEventStatus,
  reportCorrelation,
  stationIdentityCorrelation,
  stationIdentityProviderData,
} from "@station/harness-shared";
import { z } from "zod";
import { compactCursorProviderHookPayload } from "./compaction.js";
import { cursorHarnessError } from "./errors.js";

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
    return harnessEventStatus(
      "needs_attention",
      "high",
      "Cursor turn ended with an error.",
      observedAt,
    );
  }
  if (event.status === "aborted") {
    return harnessEventStatus("idle", "medium", "Cursor turn was aborted.", observedAt);
  }
  return harnessEventStatus("idle", "high", "Cursor turn completed.", observedAt);
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
  Object.assign(providerData, stationIdentityProviderData(event));
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
    ...stationIdentityCorrelation("cursor", event),
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

function cursorHarnessRunId(event: CursorProviderHookPayload): string | undefined {
  if (event.station_terminal_target_id === undefined) return undefined;
  return harnessRunIdForTerminalTarget("cursor", event.station_terminal_target_id);
}

function cursorNativeSessionId(event: CursorProviderHookPayload): string | undefined {
  // Cursor prompt/stop hooks and tool hooks disagree on session_id/conversation_id
  // for one user turn (they share generation_id). Station-launched panes are one
  // execution, so native identity follows the terminal run rather than those ids.
  return cursorHarnessRunId(event) ?? event.session_id ?? event.conversation_id;
}

function turnFromCursorProviderHookPayload(
  event: CursorProviderHookPayload,
): HarnessEventReport["turn"] | undefined {
  return event.hook_event_name === "stop" && event.status === "completed"
    ? { kind: "turn_completed" }
    : undefined;
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

export function cursorProviderHookPayloadToHarnessEventReport(
  input: HarnessEventReportInput,
): HarnessEventReport {
  const event = parseCursorProviderHookPayload(input.payload);
  return buildHarnessEventReport(input, {
    provider: "cursor",
    eventType: event.hook_event_name,
    status: statusFromCursorProviderHookPayload(event, input.observedAt),
    turn: turnFromCursorProviderHookPayload(event),
    correlation: reportCorrelationFromCursorEvent(event),
    coalesceKey: reportCoalesceKeyFromCursorEvent(event),
    providerData: providerDataFromCursorEvent(event),
  });
}

export function statusFromCursorProviderHookPayload(
  event: CursorProviderHookPayload,
  observedAt: string,
): ObservedStatus {
  const eventName = event.hook_event_name;
  if (eventName === "sessionStart") {
    return harnessEventStatus("starting", "high", "Cursor session started.", observedAt);
  }
  if (eventName === "sessionEnd") {
    // Cursor sessionEnd ends a composer conversation, not the Station pane process.
    return harnessEventStatus("idle", "high", "Cursor session ended.", observedAt);
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
    return harnessEventStatus(
      "working",
      "medium",
      cursorWorkingReason(event, "is about to use"),
      observedAt,
    );
  }
  if (
    eventName === "afterShellExecution" ||
    eventName === "afterMCPExecution" ||
    eventName === "afterFileEdit" ||
    eventName === "afterTabFileEdit" ||
    eventName === "postToolUse" ||
    eventName === "postToolUseFailure"
  ) {
    return harnessEventStatus(
      "working",
      "medium",
      cursorWorkingReason(event, "completed"),
      observedAt,
    );
  }
  if (
    eventName === "beforeSubmitPrompt" ||
    eventName === "afterAgentResponse" ||
    eventName === "afterAgentThought" ||
    eventName === "preCompact" ||
    eventName === "subagentStart" ||
    eventName === "subagentStop"
  ) {
    return harnessEventStatus("working", "medium", `Cursor emitted ${eventName}.`, observedAt);
  }
  return harnessEventStatus("working", "low", `Cursor emitted ${eventName}.`, observedAt);
}

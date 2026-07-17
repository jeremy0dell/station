// Codex hook events -> STATION HarnessEventObservation, normalized at the provider boundary.
// Upstream hook contract: https://developers.openai.com/codex/hooks
// STATION ingress flow: docs/harness-ingress.md. Keep the parsed payload shape in sync with upstream.
import type {
  HarnessEventContext,
  HarnessEventObservation,
  HarnessEventReport,
  ObservedStatus,
  RawHarnessEvent,
} from "@station/contracts";
import {
  HarnessEventReportSchema,
  observedPathIsSameOrInside,
  STATION_SCHEMA_VERSION,
} from "@station/contracts";
import {
  applyCorrelation,
  correlateTerminalBoundHarnessEvent,
  harnessEventDiagnostics,
  reportCorrelation,
} from "@station/harness-shared";
import { z } from "zod";
import {
  codexAppServerEventToHarnessEventObservation,
  isCodexAppServerMessage,
} from "./appServer/index.js";
import { codexHarnessError } from "./errors.js";
import { isCodexForwardedEventType } from "./ingressRules.js";

const nonEmptyStringSchema = z.string().min(1);
const hookEventNameProbeSchema = z.object({ hook_event_name: nonEmptyStringSchema }).loose();
const USER_INPUT_TOOL = "request_user_input";
const nullableStringSchema = z.string().nullable();
const permissionModeSchema = z
  .enum(["default", "acceptEdits", "plan", "dontAsk", "bypassPermissions"])
  .optional();

const CodexHookProviderDataSchema = z
  .object({
    codexSessionId: nonEmptyStringSchema,
    hookEventName: nonEmptyStringSchema,
    cwd: nonEmptyStringSchema,
    model: nonEmptyStringSchema,
    permissionMode: permissionModeSchema,
    codexTurnId: nonEmptyStringSchema.optional(),
    source: z.enum(["startup", "resume", "clear", "compact"]).optional(),
    toolName: nonEmptyStringSchema.optional(),
    toolUseId: nonEmptyStringSchema.optional(),
    agentId: nonEmptyStringSchema.optional(),
    agentType: nonEmptyStringSchema.optional(),
    trigger: z.enum(["manual", "auto"]).optional(),
    stationProjectId: nonEmptyStringSchema.optional(),
    stationWorktreeId: nonEmptyStringSchema.optional(),
    stationWorktreePath: nonEmptyStringSchema.optional(),
    stationSessionId: nonEmptyStringSchema.optional(),
    stationTerminalProvider: nonEmptyStringSchema.optional(),
    stationTerminalTargetId: nonEmptyStringSchema.optional(),
  })
  .strict();

type CodexHookProviderData = z.infer<typeof CodexHookProviderDataSchema>;

const commonFields = {
  session_id: nonEmptyStringSchema,
  transcript_path: nullableStringSchema,
  cwd: nonEmptyStringSchema,
  model: nonEmptyStringSchema,
  permission_mode: permissionModeSchema,
  station_project_id: nonEmptyStringSchema.optional(),
  station_worktree_id: nonEmptyStringSchema.optional(),
  station_worktree_path: nonEmptyStringSchema.optional(),
  station_session_id: nonEmptyStringSchema.optional(),
  station_terminal_provider: nonEmptyStringSchema.optional(),
  station_terminal_target_id: nonEmptyStringSchema.optional(),
};

const optionalSubagentFields = {
  agent_id: nonEmptyStringSchema.optional(),
  agent_type: nonEmptyStringSchema.optional(),
};

const turnFields = {
  ...commonFields,
  turn_id: nonEmptyStringSchema,
  ...optionalSubagentFields,
};

const SessionStartEventSchema = z
  .object({
    ...commonFields,
    hook_event_name: z.literal("SessionStart"),
    source: z.enum(["startup", "resume", "clear", "compact"]),
  })
  .strict();

const UserPromptSubmitEventSchema = z
  .object({
    ...turnFields,
    hook_event_name: z.literal("UserPromptSubmit"),
    prompt: nonEmptyStringSchema,
  })
  .strict();

const PreToolUseEventSchema = z
  .object({
    ...turnFields,
    hook_event_name: z.literal("PreToolUse"),
    tool_name: nonEmptyStringSchema,
    tool_input: z.unknown(),
    tool_use_id: nonEmptyStringSchema,
  })
  .strict();

const PermissionRequestEventSchema = z
  .object({
    ...turnFields,
    hook_event_name: z.literal("PermissionRequest"),
    tool_name: nonEmptyStringSchema,
    tool_input: z.unknown(),
  })
  .strict();

const PostToolUseEventSchema = z
  .object({
    ...turnFields,
    hook_event_name: z.literal("PostToolUse"),
    tool_name: nonEmptyStringSchema,
    tool_use_id: nonEmptyStringSchema,
    tool_input: z.unknown(),
    tool_response: z.unknown(),
  })
  .strict();

const PreCompactEventSchema = z
  .object({
    ...turnFields,
    hook_event_name: z.literal("PreCompact"),
    trigger: z.enum(["manual", "auto"]),
  })
  .strict();

const PostCompactEventSchema = z
  .object({
    ...turnFields,
    hook_event_name: z.literal("PostCompact"),
    trigger: z.enum(["manual", "auto"]),
  })
  .strict();

const SubagentStartEventSchema = z
  .object({
    ...commonFields,
    hook_event_name: z.literal("SubagentStart"),
    turn_id: nonEmptyStringSchema,
    agent_id: nonEmptyStringSchema,
    agent_type: nonEmptyStringSchema,
  })
  .strict();

const StopEventSchema = z
  .object({
    ...commonFields,
    hook_event_name: z.literal("Stop"),
    turn_id: nonEmptyStringSchema,
    stop_hook_active: z.boolean(),
    last_assistant_message: nullableStringSchema,
  })
  .strict();

export const CodexHookEventSchema = z.discriminatedUnion("hook_event_name", [
  SessionStartEventSchema,
  UserPromptSubmitEventSchema,
  PreToolUseEventSchema,
  PermissionRequestEventSchema,
  PostToolUseEventSchema,
  PreCompactEventSchema,
  PostCompactEventSchema,
  SubagentStartEventSchema,
  StopEventSchema,
]);

export type CodexHookEvent = z.infer<typeof CodexHookEventSchema>;

export type CodexHarnessEventReportInput = {
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

export function parseCodexHookEvent(input: unknown): CodexHookEvent {
  const result = CodexHookEventSchema.safeParse(input);
  if (!result.success) {
    throw codexHarnessError(
      "HARNESS_CODEX_EVENT_INVALID",
      "Codex hook event did not match a supported strict schema.",
      result.error,
    );
  }
  return result.data;
}

export function normalizeCodexRawEvent(
  raw: RawHarnessEvent,
  context: HarnessEventContext,
): HarnessEventObservation[] {
  const observedAt = raw.observedAt ?? new Date().toISOString();
  const eventNameProbe = hookEventNameProbeSchema.safeParse(raw.event);
  if (eventNameProbe.success && !isCodexForwardedEventType(eventNameProbe.data.hook_event_name)) {
    return [];
  }
  const hookEvent = CodexHookEventSchema.safeParse(raw.event);
  if (!hookEvent.success) {
    if (isCodexAppServerMessage(raw.event)) {
      return codexAppServerEventToHarnessEventObservation(raw.event, { observedAt });
    }
    throw codexHarnessError(
      "HARNESS_CODEX_EVENT_INVALID",
      "Codex hook event did not match a supported strict schema.",
      hookEvent.error,
    );
  }
  const event = hookEvent.data;
  const stationIdentityCwdMismatch = codexStationIdentityCwdMismatch(
    event.cwd,
    event.station_worktree_path,
  );
  const correlation = stationIdentityCwdMismatch
    ? { cwd: event.cwd }
    : correlateTerminalBoundHarnessEvent({
        provider: "codex",
        identity: event,
        context,
        cwd: event.cwd,
      });
  const observation: HarnessEventObservation = {
    provider: "codex",
    rawEventType: event.hook_event_name,
    status: statusFromCodexHookEvent(event, observedAt),
    observedAt,
    providerData: providerDataFromCodexEvent(event),
  };
  const turn = turnFromCodexHookEvent(event);
  if (turn !== undefined) {
    observation.turn = turn;
  }
  if (stationIdentityCwdMismatch) {
    observation.diagnostics = {
      correlationIssue: "station_identity_cwd_mismatch",
    };
  }
  applyCorrelation(observation, correlation);
  observation.nativeSessionId = event.session_id;
  return [observation];
}

export function codexHookPayloadToHarnessEventReport(
  input: CodexHarnessEventReportInput,
): HarnessEventReport {
  const event = parseCodexHookEvent(input.payload);
  const report: HarnessEventReport = {
    schemaVersion: STATION_SCHEMA_VERSION,
    reportId: input.reportId,
    provider: "codex",
    kind: "harness",
    eventType: event.hook_event_name,
    observedAt: input.observedAt,
    status: statusFromCodexHookEvent(event, input.observedAt),
  };
  const turn = turnFromCodexHookEvent(event);
  if (turn !== undefined) {
    report.turn = turn;
  }
  const correlation = reportCorrelationFromCodexEvent(event);
  if (correlation !== undefined) {
    report.correlation = correlation;
  }
  const diagnostics = harnessEventDiagnostics(event.hook_event_name, input.diagnostics);
  if (codexStationIdentityCwdMismatch(event.cwd, event.station_worktree_path)) {
    diagnostics.correlationIssue = "station_identity_cwd_mismatch";
  }
  report.diagnostics = diagnostics;
  const coalesceKey = reportCoalesceKeyFromCodexEvent(event, input.reportId);
  if (coalesceKey !== undefined) {
    report.coalesceKey = coalesceKey;
  }
  report.providerData = providerDataFromCodexEvent(event);
  return HarnessEventReportSchema.parse(report);
}

export function codexHookPayloadReportId(payload: unknown, observedAt: string): string {
  return codexHookEventReportId(parseCodexHookEvent(payload), observedAt);
}

export function statusFromCodexHookEvent(
  event: CodexHookEvent,
  observedAt: string,
): ObservedStatus {
  if (event.hook_event_name === "SessionStart") {
    return {
      value: "starting",
      confidence: "high",
      reason: `Codex session started from ${event.source}.`,
      source: "harness_event",
      updatedAt: observedAt,
    };
  }
  if (event.hook_event_name === "PermissionRequest") {
    return {
      value: "needs_attention",
      confidence: "high",
      reason: `Codex requested permission for ${event.tool_name}.`,
      source: "harness_event",
      updatedAt: observedAt,
      attention: "tool_approval",
    };
  }
  if (event.hook_event_name === "Stop") {
    if (event.stop_hook_active) {
      return {
        value: "working",
        confidence: "medium",
        reason: "A Stop hook kept Codex working.",
        source: "harness_event",
        updatedAt: observedAt,
      };
    }
    return {
      value: "idle",
      confidence: "high",
      reason: "Codex turn completed.",
      source: "harness_event",
      updatedAt: observedAt,
    };
  }
  if (event.hook_event_name === "PostToolUse") {
    if (event.tool_name === USER_INPUT_TOOL) {
      return {
        value: "working",
        confidence: "high",
        reason: "Codex received user input.",
        source: "harness_event",
        updatedAt: observedAt,
      };
    }
    return {
      value: "working",
      confidence: "medium",
      reason: `Codex completed ${event.tool_name}.`,
      source: "harness_event",
      updatedAt: observedAt,
    };
  }
  if (event.hook_event_name === "PreCompact") {
    return {
      value: "working",
      confidence: "medium",
      reason: `Codex is about to compact the conversation (${event.trigger}).`,
      source: "harness_event",
      updatedAt: observedAt,
    };
  }
  if (event.hook_event_name === "PostCompact") {
    return {
      value: "working",
      confidence: "medium",
      reason: `Codex compacted the conversation (${event.trigger}).`,
      source: "harness_event",
      updatedAt: observedAt,
    };
  }
  if (event.hook_event_name === "SubagentStart") {
    return {
      value: "working",
      confidence: "medium",
      reason: `Codex started subagent ${event.agent_type}.`,
      source: "harness_event",
      updatedAt: observedAt,
    };
  }
  if (event.hook_event_name === "PreToolUse") {
    // request_user_input blocks the turn on the user: the "tool call" IS the
    // clarifying question, so it must read as attention, not tool activity.
    if (event.tool_name === USER_INPUT_TOOL) {
      return {
        value: "needs_attention",
        confidence: "high",
        reason: "Codex requested user input.",
        source: "harness_event",
        updatedAt: observedAt,
        attention: "question",
      };
    }
    return {
      value: "working",
      confidence: "medium",
      reason: `Codex is about to use ${event.tool_name}.`,
      source: "harness_event",
      updatedAt: observedAt,
    };
  }
  return {
    value: "working",
    confidence: "medium",
    reason: "Codex received a user prompt.",
    source: "harness_event",
    updatedAt: observedAt,
  };
}

function turnFromCodexHookEvent(event: CodexHookEvent): HarnessEventReport["turn"] | undefined {
  // stop_hook_active means a Stop hook is forcing continuation, so the turn is not
  // actually complete — matches Claude's turnFromClaudeHookEvent guard and avoids a
  // premature ready marker mid-turn.
  return event.hook_event_name === "Stop" && !event.stop_hook_active
    ? { kind: "turn_completed" }
    : undefined;
}

function providerDataFromCodexEvent(event: CodexHookEvent): CodexHookProviderData {
  const providerData: CodexHookProviderData = {
    codexSessionId: event.session_id,
    hookEventName: event.hook_event_name,
    cwd: event.cwd,
    model: event.model,
  };
  if (event.permission_mode !== undefined) {
    providerData.permissionMode = event.permission_mode;
  }
  if ("turn_id" in event) {
    providerData.codexTurnId = event.turn_id;
  }
  if ("source" in event) {
    providerData.source = event.source;
  }
  if ("tool_name" in event) {
    providerData.toolName = event.tool_name;
  }
  if ("tool_use_id" in event) {
    providerData.toolUseId = event.tool_use_id;
  }
  if ("agent_id" in event && event.agent_id !== undefined) {
    providerData.agentId = event.agent_id;
  }
  if ("agent_type" in event && event.agent_type !== undefined) {
    providerData.agentType = event.agent_type;
  }
  if ("trigger" in event) {
    providerData.trigger = event.trigger;
  }
  if (event.station_project_id !== undefined) {
    providerData.stationProjectId = event.station_project_id;
  }
  if (event.station_worktree_id !== undefined) {
    providerData.stationWorktreeId = event.station_worktree_id;
  }
  if (event.station_worktree_path !== undefined) {
    providerData.stationWorktreePath = event.station_worktree_path;
  }
  if (event.station_session_id !== undefined) {
    providerData.stationSessionId = event.station_session_id;
  }
  if (event.station_terminal_provider !== undefined) {
    providerData.stationTerminalProvider = event.station_terminal_provider;
  }
  if (event.station_terminal_target_id !== undefined) {
    providerData.stationTerminalTargetId = event.station_terminal_target_id;
  }
  return CodexHookProviderDataSchema.parse(providerData);
}

export function codexStationIdentityCwdMismatch(
  cwd: string,
  stationWorktreePath: string | undefined,
): boolean {
  return stationWorktreePath !== undefined && !observedPathIsSameOrInside(cwd, stationWorktreePath);
}

/**
 * Rejects recognizable pre-fix hook observations whose cwd contradicts their Station stamp.
 * Reconcile repairs their derived binding and readiness by replaying the remaining admitted history.
 */
export function acceptsCodexPersistedEvent(observation: HarnessEventObservation): boolean {
  if (observation.eventType === "SubagentStop" || observation.rawEventType === "SubagentStop") {
    return false;
  }
  const providerData = CodexHookProviderDataSchema.safeParse(observation.providerData);
  if (!providerData.success) return true;
  return !codexStationIdentityCwdMismatch(
    providerData.data.cwd,
    providerData.data.stationWorktreePath,
  );
}

function reportCorrelationFromCodexEvent(
  event: CodexHookEvent,
): HarnessEventReport["correlation"] | undefined {
  if (codexStationIdentityCwdMismatch(event.cwd, event.station_worktree_path)) {
    return reportCorrelation({
      cwd: event.cwd,
      nativeSessionId: event.session_id,
    });
  }
  return reportCorrelation({
    cwd: event.cwd,
    nativeSessionId: event.session_id,
    projectId: event.station_project_id,
    worktreeId: event.station_worktree_id,
    sessionId: event.station_session_id,
    terminalTargetId: event.station_terminal_target_id,
  });
}

function reportCoalesceKeyFromCodexEvent(
  event: CodexHookEvent,
  reportId: string,
): string | undefined {
  if (event.hook_event_name === "PermissionRequest") {
    return `report:${reportId}`;
  }
  const parts: string[] = [];
  if ("turn_id" in event) {
    parts.push(`turn:${event.turn_id}`);
  }
  if ("tool_use_id" in event) {
    parts.push(`tool:${event.tool_use_id}`);
  } else if ("tool_name" in event) {
    parts.push(`tool:${event.tool_name}`);
  }
  return parts.length === 0 ? undefined : parts.join(":");
}

function codexHookEventReportId(event: CodexHookEvent, observedAt: string): string {
  const parts = ["codex", event.session_id, event.hook_event_name];
  if ("turn_id" in event) {
    parts.push(event.turn_id);
  }
  if ("tool_use_id" in event) {
    parts.push(`tool:${event.tool_use_id}`);
  } else if ("tool_name" in event) {
    parts.push(`tool:${event.tool_name}`);
  }
  if ("agent_id" in event && event.agent_id !== undefined) {
    parts.push(`agent:${event.agent_id}`);
  }
  if ("trigger" in event) {
    parts.push(`trigger:${event.trigger}`);
  }
  if (event.hook_event_name === "PermissionRequest") {
    parts.push(`request:${observedAt}`);
  }
  if ("source" in event) {
    parts.push(`source:${event.source}`);
  }
  return parts.map((part) => encodeURIComponent(part)).join(":");
}

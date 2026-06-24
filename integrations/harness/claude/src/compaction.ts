import { compactPayloadByFieldNames, type PayloadCompactionResult } from "@station/harness-shared";

export type ClaudePayloadCompactionResult = PayloadCompactionResult;

const commonFieldNames = [
  "session_id",
  "transcript_path",
  "cwd",
  "hook_event_name",
  "permission_mode",
  "station_project_id",
  "station_worktree_id",
  "station_worktree_path",
  "station_session_id",
  "station_terminal_provider",
  "station_terminal_target_id",
] as const;

function fieldNamesForEvent(eventName: string): string[] {
  const fields: string[] = [...commonFieldNames];
  if (eventName === "SessionStart") {
    fields.push("source");
    return fields;
  }
  if (eventName === "UserPromptSubmit") {
    fields.push("prompt");
    return fields;
  }
  if (eventName === "PreToolUse") {
    fields.push("tool_name", "tool_use_id", "tool_input");
    return fields;
  }
  if (eventName === "PostToolUse") {
    fields.push("tool_name", "tool_use_id", "duration_ms", "tool_input", "tool_response");
    return fields;
  }
  if (eventName === "PermissionRequest") {
    fields.push("tool_name", "tool_input", "permission_suggestions");
    return fields;
  }
  if (eventName === "Notification") {
    fields.push("notification_type", "message");
    return fields;
  }
  if (eventName === "PreCompact") {
    fields.push("trigger");
    return fields;
  }
  if (eventName === "Stop") {
    fields.push("stop_hook_active", "last_assistant_message");
    return fields;
  }
  if (eventName === "SessionEnd") {
    fields.push("reason");
    return fields;
  }
  fields.push("source", "trigger", "reason", "notification_type", "tool_name", "tool_use_id");
  return fields;
}

export function compactClaudeHookPayload(payload: unknown): ClaudePayloadCompactionResult {
  return compactPayloadByFieldNames(payload, {
    retainedFieldNames: (record) =>
      fieldNamesForEvent(typeof record.hook_event_name === "string" ? record.hook_event_name : ""),
    compactObjectFieldNames: ["tool_input", "tool_response", "permission_suggestions"],
    compactStringFieldNames: ["prompt", "message"],
    nullWhenPresentFieldNames: ["last_assistant_message"],
  });
}

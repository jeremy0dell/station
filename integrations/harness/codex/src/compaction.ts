import { compactPayloadByFieldNames, type PayloadCompactionResult } from "@station/harness-shared";

export type CodexPayloadCompactionResult = PayloadCompactionResult;

const commonFieldNames = [
  "session_id",
  "transcript_path",
  "cwd",
  "hook_event_name",
  "model",
  "permission_mode",
  "station_project_id",
  "station_worktree_id",
  "station_worktree_path",
  "station_session_id",
  "station_terminal_provider",
  "station_terminal_target_id",
] as const;

const turnFieldNames = ["turn_id", "agent_id", "agent_type"] as const;

export function compactCodexHookPayload(payload: unknown): CodexPayloadCompactionResult {
  return compactPayloadByFieldNames(payload, {
    retainedFieldNames: (record) =>
      fieldNamesForEvent(typeof record.hook_event_name === "string" ? record.hook_event_name : ""),
    compactObjectFieldNames: ["tool_input", "tool_response"],
    compactStringFieldNames: ["prompt"],
    nullWhenPresentFieldNames: ["last_assistant_message"],
  });
}

function fieldNamesForEvent(eventName: string): string[] {
  const fields: string[] = [...commonFieldNames];
  if (eventName === "SessionStart") {
    fields.push("source");
    return fields;
  }
  if (eventName === "UserPromptSubmit") {
    fields.push(...turnFieldNames, "prompt");
    return fields;
  }
  if (eventName === "PreToolUse") {
    fields.push(...turnFieldNames, "tool_name", "tool_input", "tool_use_id");
    return fields;
  }
  if (eventName === "PermissionRequest") {
    fields.push(...turnFieldNames, "tool_name", "tool_input");
    return fields;
  }
  if (eventName === "PostToolUse") {
    fields.push(...turnFieldNames, "tool_name", "tool_input", "tool_response", "tool_use_id");
    return fields;
  }
  if (eventName === "PreCompact" || eventName === "PostCompact") {
    fields.push(...turnFieldNames, "trigger");
    return fields;
  }
  if (eventName === "SubagentStart") {
    fields.push("turn_id", "agent_id", "agent_type");
    return fields;
  }
  if (eventName === "SubagentStop") {
    fields.push(
      "turn_id",
      "agent_transcript_path",
      "agent_id",
      "agent_type",
      "stop_hook_active",
      "last_assistant_message",
    );
    return fields;
  }
  if (eventName === "Stop") {
    fields.push("turn_id", "stop_hook_active", "last_assistant_message");
    return fields;
  }
  fields.push(...turnFieldNames, "source", "trigger", "tool_name", "tool_use_id");
  return fields;
}

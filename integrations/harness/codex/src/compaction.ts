export type CodexPayloadCompactionResult = {
  payload: unknown;
  compacted: boolean;
  originalByteCount: number | null;
  compactedByteCount: number | null;
  omittedFieldNames: string[];
};

type CompactFieldMetadata = {
  compacted: true;
  originalBytes: number | null;
};

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

const compactedFieldNames = new Set([
  "tool_input",
  "tool_response",
  "prompt",
  "last_assistant_message",
]);

export function compactCodexHookPayload(payload: unknown): CodexPayloadCompactionResult {
  const originalByteCount = jsonByteCount(payload);
  if (!isRecord(payload)) {
    return {
      payload,
      compacted: false,
      originalByteCount,
      compactedByteCount: originalByteCount,
      omittedFieldNames: [],
    };
  }

  const output: Record<string, unknown> = {};
  const copiedFields = new Set<string>();
  const omittedFieldNames = new Set<string>();
  const eventName = typeof payload.hook_event_name === "string" ? payload.hook_event_name : "";

  for (const fieldName of fieldNamesForEvent(eventName)) {
    if (!hasOwn(payload, fieldName) || compactedFieldNames.has(fieldName)) {
      continue;
    }
    output[fieldName] = payload[fieldName];
    copiedFields.add(fieldName);
  }

  compactObjectField(payload, output, copiedFields, omittedFieldNames, "tool_input");
  compactObjectField(payload, output, copiedFields, omittedFieldNames, "tool_response");
  compactStringField(payload, output, copiedFields, omittedFieldNames, "prompt");
  compactAssistantMessage(payload, output, copiedFields, omittedFieldNames);

  for (const fieldName of Object.keys(payload)) {
    if (copiedFields.has(fieldName)) {
      continue;
    }
    omittedFieldNames.add(fieldName);
  }

  const compacted = omittedFieldNames.size > 0;
  return {
    payload: output,
    compacted,
    originalByteCount,
    compactedByteCount: jsonByteCount(output),
    omittedFieldNames: [...omittedFieldNames].sort(),
  };
}

function jsonByteCount(value: unknown): number | null {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      return null;
    }
    return Buffer.byteLength(serialized, "utf8");
  } catch {
    return null;
  }
}

function compactObjectField(
  input: Record<string, unknown>,
  output: Record<string, unknown>,
  copiedFields: Set<string>,
  omittedFieldNames: Set<string>,
  fieldName: "tool_input" | "tool_response",
) {
  if (!hasOwn(input, fieldName)) {
    return;
  }
  output[fieldName] = compactFieldMetadata(input[fieldName]);
  copiedFields.add(fieldName);
  omittedFieldNames.add(fieldName);
}

function compactStringField(
  input: Record<string, unknown>,
  output: Record<string, unknown>,
  copiedFields: Set<string>,
  omittedFieldNames: Set<string>,
  fieldName: "prompt",
) {
  if (!hasOwn(input, fieldName)) {
    return;
  }
  output[fieldName] = compactedTextPlaceholder(fieldName, jsonByteCount(input[fieldName]));
  copiedFields.add(fieldName);
  omittedFieldNames.add(fieldName);
}

function compactAssistantMessage(
  input: Record<string, unknown>,
  output: Record<string, unknown>,
  copiedFields: Set<string>,
  omittedFieldNames: Set<string>,
) {
  if (!hasOwn(input, "last_assistant_message")) {
    return;
  }
  output.last_assistant_message = null;
  copiedFields.add("last_assistant_message");
  if (input.last_assistant_message !== null) {
    omittedFieldNames.add("last_assistant_message");
  }
}

function compactFieldMetadata(value: unknown): CompactFieldMetadata {
  return {
    compacted: true,
    originalBytes: jsonByteCount(value),
  };
}

function compactedTextPlaceholder(fieldName: string, byteCount: number | null): string {
  const bytes = byteCount === null ? "unknown" : String(byteCount);
  return `[station compacted ${fieldName}: ${bytes} bytes]`;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(value, key);
}

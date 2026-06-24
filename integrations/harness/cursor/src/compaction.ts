export type CursorProviderHookPayloadCompactionResult = {
  payload: unknown;
  compacted: boolean;
  originalByteCount: number | null;
  compactedByteCount: number | null;
  omittedFieldNames: string[];
};

const retainedFieldNames = [
  "hook_event_name",
  "session_id",
  "conversation_id",
  "generation_id",
  "transcript_path",
  "cwd",
  "workspace_roots",
  "model",
  "cursor_version",
  "status",
  "tool_name",
  "tool_use_id",
  "request_id",
  "message_id",
  "station_project_id",
  "station_worktree_id",
  "station_worktree_path",
  "station_session_id",
  "station_terminal_provider",
  "station_terminal_target_id",
] as const;

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function compactCursorProviderHookPayload(
  payload: unknown,
): CursorProviderHookPayloadCompactionResult {
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
  const omittedFieldNames = new Set<string>();
  for (const fieldName of retainedFieldNames) {
    if (Object.hasOwn(payload, fieldName)) {
      output[fieldName] = payload[fieldName];
    }
  }

  for (const fieldName of Object.keys(payload)) {
    if (!Object.hasOwn(output, fieldName)) {
      omittedFieldNames.add(fieldName);
    }
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
